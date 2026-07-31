import type {
  Automation,
  AutomationDispatchResult,
  AutomationPrecheckResult,
  AutomationRun
} from '../../shared/automations-types'
import { isFinalAutomationRunStatus } from '../../shared/automations-types'
import type { Store } from '../persistence'
import type { HeadlessAutomationDispatcher } from './headless-dispatch'
import type { AutomationRunTargetResult } from './run-target-resolution'
import {
  didAutomationPrecheckPass,
  formatAutomationPrecheckFailure
} from '../../shared/automation-precheck'

export async function requestHeadlessAutomationDispatch(params: {
  store: Store
  automation: Automation
  run: AutomationRun
  target: Extract<AutomationRunTargetResult, { ok: true }>
  headlessDispatcher: HeadlessAutomationDispatcher
  codexHeadlessLaunchTimeoutMs: number
  runPrecheck: (automationId: string, runId: string) => Promise<AutomationPrecheckResult | null>
  markDispatchResult: (result: AutomationDispatchResult) => Promise<AutomationRun>
}): Promise<AutomationRun> {
  const { automation, run } = params
  const precheckResult =
    run.trigger === 'scheduled' && automation.precheck
      ? await params.runPrecheck(automation.id, run.id)
      : null
  if (precheckResult && !didAutomationPrecheckPass(precheckResult)) {
    return params.store.updateAutomationRun({
      runId: run.id,
      status: 'skipped_precheck',
      workspaceId: automation.workspaceId,
      precheckResult,
      error: formatAutomationPrecheckFailure(precheckResult)
    })
  }

  const launchDeadlineAt =
    automation.agentId === 'codex' ? Date.now() + params.codexHeadlessLaunchTimeoutMs : null
  const dispatchRun =
    launchDeadlineAt === null
      ? run
      : params.store.updateAutomationRun({
          runId: run.id,
          status: 'pending',
          workspaceId: run.workspaceId,
          launchDeadlineAt,
          launchEvidenceAt: null,
          error: null
        })

  try {
    const launch = await params.headlessDispatcher({
      automation,
      run: dispatchRun,
      target: params.target
    })
    const launchRunTarget = {
      workspaceId: launch.workspaceId,
      workspaceDisplayName: launch.workspaceDisplayName ?? null,
      terminalSessionId: launch.terminalSessionId,
      terminalPaneKey: launch.terminalPaneKey ?? null,
      terminalPtyId: launch.terminalPtyId ?? null
    }
    const updated = params.store.updateAutomationRun({
      runId: run.id,
      status: 'dispatched',
      ...launchRunTarget,
      launchDeadlineAt,
      launchEvidenceAt: null,
      error: null
    })
    if (launch.launchReady) {
      void launch.launchReady.then(
        () => markHeadlessLaunchReady(params.store, run.id),
        (error) =>
          void params.markDispatchResult({
            runId: run.id,
            status: 'dispatch_failed',
            ...launchRunTarget,
            error: error instanceof Error ? error.message : String(error)
          })
      )
    }
    if (launch.completion) {
      void launch.completion
        .then((completion) =>
          params.markDispatchResult({
            runId: run.id,
            status: completion.status,
            ...launchRunTarget,
            precheckResult,
            outputSnapshot: completion.outputSnapshot ?? null,
            error: completion.error ?? null
          })
        )
        .catch((error) =>
          params.markDispatchResult({
            runId: run.id,
            status: 'dispatch_failed',
            ...launchRunTarget,
            error: error instanceof Error ? error.message : String(error)
          })
        )
    }
    return updated
  } catch (error) {
    return params.store.updateAutomationRun({
      runId: run.id,
      status: 'dispatch_failed',
      workspaceId: automation.workspaceId,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

export function reconcileStaleCodexHeadlessDispatches(params: {
  store: Store
  now: number
  markDispatchResult: (result: AutomationDispatchResult) => Promise<AutomationRun>
}): void {
  for (const automation of params.store.listAutomations()) {
    if (automation.agentId !== 'codex') {
      continue
    }
    for (const run of params.store.listAutomationRuns(automation.id)) {
      if (
        (run.status !== 'pending' && run.status !== 'dispatched') ||
        run.launchEvidenceAt != null ||
        run.launchDeadlineAt == null ||
        run.launchDeadlineAt > params.now
      ) {
        continue
      }
      void params
        .markDispatchResult({
          runId: run.id,
          status: 'dispatch_failed',
          workspaceId: run.workspaceId,
          workspaceDisplayName: run.workspaceDisplayName,
          terminalSessionId: run.terminalSessionId,
          terminalPaneKey: run.terminalPaneKey,
          terminalPtyId: run.terminalPtyId,
          error: 'Codex headless agent did not produce launch evidence before the deadline.'
        })
        .catch(() => {
          // A retained run can disappear while stale reconciliation collects usage.
        })
    }
  }
}

function markHeadlessLaunchReady(store: Store, runId: string): void {
  const run = store.listAutomationRuns().find((entry) => entry.id === runId)
  if (!run || isFinalAutomationRunStatus(run.status)) {
    return
  }
  store.updateAutomationRun({
    runId,
    status: 'dispatched',
    workspaceId: run.workspaceId,
    workspaceDisplayName: run.workspaceDisplayName,
    terminalSessionId: run.terminalSessionId,
    terminalPaneKey: run.terminalPaneKey,
    terminalPtyId: run.terminalPtyId,
    launchEvidenceAt: Date.now(),
    error: null
  })
}
