import {
  isFinalAutomationRunStatus,
  type AutomationDispatchResult,
  type AutomationRun
} from '../../shared/automations-types'
import type { ClaudeUsageStore } from '../claude-usage/store'
import type { CodexUsageStore } from '../codex-usage/store'
import type { Store } from '../persistence'
import { clearAutomationDispatchTokens } from './dispatch-tokens'
import { collectAutomationRunUsage } from './run-usage-collection'
import type { AutomationRunWriter } from './automation-run-writer'

type AutomationRunCompletionCallbacks = {
  watch: (run: AutomationRun) => void
  forget: (runId: string) => void
}

export async function persistAutomationDispatchResult(params: {
  store: Store
  runs: AutomationRunWriter
  result: AutomationDispatchResult
  claudeUsage: ClaudeUsageStore | null
  codexUsage: CodexUsageStore | null
  completionWatcher: AutomationRunCompletionCallbacks | null
  clearHeadlessLaunchCleanup: (runId: string) => void
}): Promise<AutomationRun> {
  const current = (params.store.listAutomationRuns?.() ?? []).find(
    (entry) => entry.id === params.result.runId
  )
  // Why: completion and launch-timeout observers race; the first persisted terminal state is authoritative.
  const clearsRetiredTerminalIdentity =
    current &&
    params.result.status === current.status &&
    params.result.terminalSessionId === null &&
    params.result.terminalPaneKey === null &&
    params.result.terminalPtyId === null &&
    Object.hasOwn(params.result, 'terminalSessionId') &&
    Object.hasOwn(params.result, 'terminalPaneKey') &&
    Object.hasOwn(params.result, 'terminalPtyId')
  if (current && isFinalAutomationRunStatus(current.status) && !clearsRetiredTerminalIdentity) {
    clearAutomationDispatchTokens(current.automationId, current.id)
    return current
  }
  const run = params.runs.updateRun(params.result)
  clearAutomationDispatchTokens(run.automationId, run.id)
  if (isFinalAutomationRunStatus(run.status) && run.status !== 'dispatch_failed') {
    params.clearHeadlessLaunchCleanup(run.id)
  }
  if (!isFinalAutomationRunStatus(run.status)) {
    if (run.status === 'dispatched') {
      params.completionWatcher?.watch(run)
    }
    return run
  }
  params.completionWatcher?.forget(run.id)
  // Why: repeated completion callbacks can rewrite already-collected usage.
  if (run.usage) {
    return run
  }
  const usage = await collectAutomationRunUsage({
    automation: params.store.listAutomations().find((entry) => entry.id === run.automationId),
    run,
    claudeUsage: params.claudeUsage,
    codexUsage: params.codexUsage
  })
  // Why: create-time retention may evict a final run during the usage await.
  if (!params.store.listAutomationRuns(run.automationId).some((entry) => entry.id === run.id)) {
    return run
  }
  return params.runs.updateRun({
    runId: run.id,
    status: run.status,
    workspaceId: run.workspaceId,
    terminalSessionId: run.terminalSessionId,
    usage,
    error: run.error
  })
}
