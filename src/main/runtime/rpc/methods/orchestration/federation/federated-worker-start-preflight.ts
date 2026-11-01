import type { WorkerStartInput } from '../worker/worker-start-schema'
import type { WorkerStartMutation } from '../worker/worker-start-mutation'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { RuntimeStatus } from '../../../../../../shared/runtime-types'
import { isTuiAgent } from '../../../../../../shared/tui-agent-config'
import {
  ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_CONTROL_MAIL_PROTOCOL_VERSION,
  ORCHESTRATION_FEDERATION_CONTROL_MAIL_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_PROTOCOL_VERSION,
  ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY
} from '../../../../../../shared/protocol-version'
import { orchestrationMigrationData } from '../../../../../../shared/orchestration-rpc-contract'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import {
  assertWorkerLaunchPreferencesRuntimeSupported,
  assertWorkerLaunchPreferencesCreateTerminal,
  createPendingWorkerLaunchReceipt,
  type OrchestrationWorkerLaunchReceipt
} from '../worker/worker-launch-preferences'
import { validateFederatedWorkerStartPlacement } from '../worker/worker-start-validation'
import { resolveFederatedWorkerStartBudgets } from '../worker/worker-start-budgets'
import { isWorkerStartTimeoutWithinTimerLimit } from '../../../../../../shared/orchestration-timing-budgets'

export type FederatedWorkerPreflightResult = {
  worktree: string
  createsWorktree: boolean
  requestedLaunch: OrchestrationWorkerLaunchReceipt
  server: ReturnType<OrcaRuntimeService['resolveOrchestrationWorkerServer']>
  pairingFence: { expectedEnvironmentPairingRevision: number | undefined }
  budgets: ReturnType<typeof resolveFederatedWorkerStartBudgets>
  federationProtocolVersion: number
  status: RuntimeStatus
  mutation: WorkerStartMutation
}

export async function preflightFederatedWorkerStart(
  params: WorkerStartInput,
  runtime: OrcaRuntimeService,
  orchestrationMutation: WorkerStartMutation | undefined
): Promise<FederatedWorkerPreflightResult> {
  if (!isWorkerStartTimeoutWithinTimerLimit(params.timeoutMs)) {
    throw new OrchestrationError(
      'invalid_argument',
      '--timeout-ms is too large for worker-start transport grace; the derived timeout must fit within the timer limit.'
    )
  }
  if (!orchestrationMutation) {
    throw new OrchestrationError(
      'invalid_argument',
      'Remote worker-start requires a durable retry request.'
    )
  }
  const worktree = params.worktree ?? 'current'
  if (worktree === 'current' || worktree === 'new-child') {
    throw new OrchestrationError(
      'invalid_argument',
      '--on requires an exact remote worktree selector or new-top-level.'
    )
  }
  const createsWorktree = worktree === 'new-top-level'
  assertWorkerLaunchPreferencesCreateTerminal(params)
  validateFederatedWorkerStartPlacement(params, createsWorktree)
  const requestedLaunch = createPendingWorkerLaunchReceipt({
    agent: isTuiAgent(params.agent) ? params.agent : null,
    model: params.model,
    effort: params.effort
  })
  const server = runtime.resolveOrchestrationWorkerServer(params.on as string)
  const pairingFence = { expectedEnvironmentPairingRevision: server.pairingRevision }
  const budgets = resolveFederatedWorkerStartBudgets(params.timeoutMs)
  const status = (await runtime.callOrchestrationWorkerServer(
    server.environmentId,
    'status.get',
    undefined,
    budgets.preflightTimeoutMs,
    undefined,
    pairingFence
  )) as RuntimeStatus
  if (!status.capabilities?.includes(ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY)) {
    throw new OrchestrationError(
      'orchestration_migration_required',
      `Connected server ${server.name} does not support the current orchestration contract. No effects were applied.`,
      orchestrationMigrationData('runtime_capability_missing')
    )
  }
  if (!status.capabilities?.includes(ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY)) {
    throw new OrchestrationError(
      'capability_unsupported',
      `Connected server ${server.name} does not support orchestration federation.`
    )
  }
  assertWorkerLaunchPreferencesRuntimeSupported({
    model: params.model,
    effort: params.effort,
    capabilities: status.capabilities,
    serverName: server.name
  })
  const supportsControlMail = status.capabilities?.includes(
    ORCHESTRATION_FEDERATION_CONTROL_MAIL_RUNTIME_CAPABILITY
  )
  const federationProtocolVersion =
    supportsControlMail &&
    status.capabilities?.includes(ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_RUNTIME_CAPABILITY)
      ? ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_PROTOCOL_VERSION
      : supportsControlMail
        ? ORCHESTRATION_FEDERATION_CONTROL_MAIL_PROTOCOL_VERSION
        : 1

  return {
    worktree,
    createsWorktree,
    requestedLaunch,
    server,
    pairingFence,
    budgets,
    federationProtocolVersion,
    status,
    mutation: orchestrationMutation
  }
}
