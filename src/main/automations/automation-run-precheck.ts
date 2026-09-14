import type { AutomationPrecheckResult } from '../../shared/automations-types'
import type { Store } from '../persistence'
import { runAutomationPrecheck } from './precheck-runner'
import { resolveAutomationRunTarget } from './run-target-resolution'

export async function evaluateAutomationRunPrecheck(params: {
  store: Store
  automationId: string
  runId: string
  allowRemoteHostScheduling: boolean
}): Promise<AutomationPrecheckResult | null> {
  const automation = params.store
    .listAutomations()
    .find((entry) => entry.id === params.automationId)
  if (!automation) {
    throw new Error('Automation not found.')
  }
  const run = params.store
    .listAutomationRuns(params.automationId)
    .find((entry) => entry.id === params.runId)
  if (!run) {
    throw new Error('Automation run not found.')
  }
  if (run.trigger !== 'scheduled' || !automation.precheck) {
    return null
  }
  const target = resolveAutomationRunTarget(params.store, automation, {
    allowRemoteHostScheduling: params.allowRemoteHostScheduling
  })
  if (!target.ok) {
    const now = Date.now()
    return {
      command: automation.precheck.command,
      exitCode: null,
      timedOut: false,
      durationMs: 0,
      stdout: '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      error: target.error,
      startedAt: now,
      completedAt: now
    }
  }
  return await runAutomationPrecheck({
    precheck: automation.precheck,
    target:
      automation.executionTargetType === 'ssh'
        ? { type: 'ssh', cwd: target.cwd, connectionId: automation.executionTargetId }
        : { type: 'local', cwd: target.cwd }
  })
}
