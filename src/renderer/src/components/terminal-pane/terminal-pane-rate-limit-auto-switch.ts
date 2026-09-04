import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '../../store'
import { getConnectionId } from '@/lib/connection-context'
import { runAgentRateLimitAutoSwitch } from '@/lib/agent-rate-limit-auto-switch-runner'
import type { AutoSwitchRateLimitAgent } from '../../../../shared/agent-rate-limit-detection'
import type { AgentProviderSessionMetadata } from '../../../../shared/agent-session-resume'
import type { PtyTransport } from './pty-transport'

export type AgentRateLimitAutoSwitchEvent = {
  paneId: number
  paneKey: string
  ptyId: string
  agent: AutoSwitchRateLimitAgent
  providerSession: AgentProviderSessionMetadata
}

export function createTerminalPaneRateLimitAutoSwitchHandler(input: {
  worktreeId: string
  paneTransportsRef: { current: Map<number, PtyTransport> }
  autoSwitchingPaneKeysRef: { current: Set<string> }
}): (event: AgentRateLimitAutoSwitchEvent) => void {
  return (event) => {
    if (input.autoSwitchingPaneKeysRef.current.has(event.paneKey)) {
      return
    }
    const transport = input.paneTransportsRef.current.get(event.paneId)
    if (!transport || transport.getPtyId() !== event.ptyId) {
      return
    }
    if (useAppStore.getState().settings?.autoSwitchRateLimitedAccounts !== true) {
      return
    }

    input.autoSwitchingPaneKeysRef.current.add(event.paneKey)
    const agentLabel = event.agent === 'claude' ? 'Claude' : 'Codex'
    toast.info(
      translate(
        'auto.components.terminalPane.TerminalPane.34f715e07e',
        '{{value0}} account limit detected.',
        { value0: agentLabel }
      ),
      {
        description: translate(
          'auto.components.terminalPane.TerminalPane.3200325804',
          'Switching managed accounts and resuming the same session.'
        )
      }
    )

    void runAgentRateLimitAutoSwitch({
      ptyId: event.ptyId,
      agent: event.agent,
      providerSession: event.providerSession,
      connectionId: getConnectionId(input.worktreeId) ?? null
    })
      .then((result) => {
        if (result.ok) {
          toast.success(
            translate(
              'auto.components.terminalPane.TerminalPane.e0e6981a0e',
              '{{value0}} session resumed.',
              { value0: agentLabel }
            ),
            {
              description: translate(
                'auto.components.terminalPane.TerminalPane.f8d8f16aca',
                'Switched to {{value0}} and sent continue.',
                { value0: result.accountLabel }
              )
            }
          )
          return
        }
        if (result.reason === 'disabled') {
          return
        }
        const toastFn =
          result.reason === 'no-account' || result.reason === 'ssh' ? toast.info : toast.error
        toastFn(
          translate(
            'auto.components.terminalPane.TerminalPane.816627b20e',
            '{{value0}} auto-switch skipped.',
            { value0: agentLabel }
          ),
          {
            description: result.message
          }
        )
      })
      .catch((error) => {
        toast.error(
          translate(
            'auto.components.terminalPane.TerminalPane.8bb13ef78d',
            '{{value0}} auto-switch failed.',
            { value0: agentLabel }
          ),
          {
            description: error instanceof Error ? error.message : String(error)
          }
        )
      })
      .finally(() => {
        input.autoSwitchingPaneKeysRef.current.delete(event.paneKey)
      })
  }
}
