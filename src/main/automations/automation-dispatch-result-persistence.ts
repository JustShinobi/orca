import {
  isFinalAutomationRunStatus,
  type AutomationDispatchResult,
  type AutomationRun
} from '../../shared/automations-types'
import type { ClaudeUsageStore } from '../claude-usage/store'
import type { CodexUsageStore } from '../codex-usage/store'
import type { Store } from '../persistence'
import { clearAutomationDispatchTokens } from './dispatch-tokens'
import { writeAutomationRunUsage } from './run-usage-collection'
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
  return await writeAutomationRunUsage({
    store: params.store,
    runs: params.runs,
    run,
    claudeUsage: params.claudeUsage,
    codexUsage: params.codexUsage
  })
}
