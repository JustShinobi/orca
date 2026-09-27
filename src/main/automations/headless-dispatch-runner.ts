import type {
  Automation,
  AutomationDispatchResult,
  AutomationPrecheckResult,
  AutomationRun
} from '../../shared/automations-types'
import {
  didAutomationPrecheckPass,
  formatAutomationPrecheckFailure
} from '../../shared/automation-precheck'
import type {
  HeadlessAutomationDispatcher,
  HeadlessAutomationDispatchLaunch
} from './headless-dispatch'
import type { AutomationRunTargetResult } from './run-target-resolution'
import type { AutomationRunWriter } from './automation-run-writer'

export type HeadlessAutomationDispatchContext = {
  automation: Automation
  run: AutomationRun
  target: Extract<AutomationRunTargetResult, { ok: true }>
  dispatcher: HeadlessAutomationDispatcher
  runs: AutomationRunWriter
  runPrecheck: () => Promise<AutomationPrecheckResult | null>
  markDispatchResult: (result: AutomationDispatchResult) => Promise<AutomationRun>
  watchRun: (run: AutomationRun) => void
  codexHeadlessLaunchTimeoutMs?: number
  registerLaunchCleanup?: (runId: string, cleanup: () => Promise<void>) => void
  clearLaunchCleanup?: (runId: string) => void
  cleanupLaunch?: (runId: string) => Promise<void>
}

function describeDispatchError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function runHeadlessAutomationDispatch(
  ctx: HeadlessAutomationDispatchContext
): Promise<AutomationRun> {
  const { automation, run, target, runs } = ctx
  const precheckResult =
    run.trigger === 'scheduled' && automation.precheck ? await ctx.runPrecheck() : null
  if (precheckResult && !didAutomationPrecheckPass(precheckResult)) {
    return runs.updateRun({
      runId: run.id,
      status: 'skipped_precheck',
      workspaceId: automation.workspaceId,
      precheckResult,
      error: formatAutomationPrecheckFailure(precheckResult)
    })
  }
  let launch: HeadlessAutomationDispatchLaunch
  try {
    launch = await ctx.dispatcher({ automation, run, target })
  } catch (error) {
    if (ctx.cleanupLaunch) {
      await ctx.cleanupLaunch(run.id).catch(() => {})
    }
    ctx.clearLaunchCleanup?.(run.id)
    return runs.updateRun({
      runId: run.id,
      status: 'dispatch_failed',
      workspaceId: automation.workspaceId,
      error: describeDispatchError(error)
    })
  }
  const launchDeadlineAt =
    automation.agentId === 'codex' && ctx.codexHeadlessLaunchTimeoutMs != null
      ? Date.now() + ctx.codexHeadlessLaunchTimeoutMs
      : null
  const launchRunTarget = {
    workspaceId: launch.workspaceId,
    workspaceDisplayName: launch.workspaceDisplayName ?? null,
    terminalSessionId: launch.terminalSessionId,
    terminalPaneKey: launch.terminalPaneKey ?? null,
    terminalPtyId: launch.terminalPtyId ?? null
  }
  if (launch.cleanup) {
    ctx.registerLaunchCleanup?.(run.id, launch.cleanup)
  }
  const updatePromise = runs.updateRun({
    runId: run.id,
    status: 'dispatched',
    ...launchRunTarget,
    launchDeadlineAt,
    launchEvidenceAt: null,
    error: null
  })
  const updated = (async () => {
    try {
      return await updatePromise
    } catch (error) {
      if (ctx.cleanupLaunch) {
        await ctx.cleanupLaunch(run.id).catch(() => {})
        ctx.clearLaunchCleanup?.(run.id)
        return await ctx.markDispatchResult({
          runId: run.id,
          status: 'dispatch_failed',
          workspaceId: automation.workspaceId,
          error: describeDispatchError(error)
        })
      }
      throw error
    }
  })()
  const launchReady =
    typeof launch.launchReady === 'function'
      ? launchDeadlineAt === null
        ? null
        : launch.launchReady(launchDeadlineAt)
      : launch.launchReady
  if (launchReady) {
    void launchReady
      .then(async () => {
        await ctx.markDispatchResult({
          runId: run.id,
          status: 'dispatched',
          launchEvidenceAt: Date.now()
        })
        ctx.clearLaunchCleanup?.(run.id)
      })
      .catch(async (error) => {
        await ctx
          .markDispatchResult({
            runId: run.id,
            status: 'dispatch_failed',
            ...launchRunTarget,
            error: describeDispatchError(error)
          })
          .catch(() => {})
        if (ctx.cleanupLaunch) {
          await ctx.cleanupLaunch(run.id).catch(() => {})
        }
        ctx.clearLaunchCleanup?.(run.id)
      })
  }
  // Observe the launched agent even while persistence is stalled or rejects its acknowledgement.
  if (!launch.completion) {
    ctx.watchRun({ ...run, ...launchRunTarget, status: 'dispatched', error: null })
    return updated
  }
  void launch.completion
    .then(
      async (completion) => {
        await ctx.markDispatchResult({
          runId: run.id,
          status: completion.status,
          ...launchRunTarget,
          precheckResult,
          outputSnapshot: completion.outputSnapshot ?? null,
          error: completion.error ?? null
        })
        ctx.clearLaunchCleanup?.(run.id)
      },
      async (error) => {
        await ctx
          .markDispatchResult({
            runId: run.id,
            status: 'dispatch_failed',
            ...launchRunTarget,
            error: describeDispatchError(error)
          })
          .catch(() => {})
        if (ctx.cleanupLaunch) {
          await ctx.cleanupLaunch(run.id).catch(() => {})
        }
        ctx.clearLaunchCleanup?.(run.id)
      }
    )
    .catch((error) => console.error('[automations] Failed to persist run completion:', error))
  return updated
}
