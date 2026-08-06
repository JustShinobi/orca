import { z } from 'zod'
import {
  addRegisteredSshTarget,
  connectRegisteredSshTarget,
  getSshConnectionManager,
  getRegisteredSshState,
  importRegisteredSshConfig,
  listRegisteredRemovedSshTargetLabels,
  listRegisteredSshTargets
} from '../../../ipc/ssh'
import { browseSshDirectory } from '../../../ipc/ssh-browse'
import { defineMethod, type RpcMethod } from '../core'
import { getPublicSshError, getPublicSshState } from '../../public-ssh-state'
import {
  MAX_SSH_RELAY_GRACE_PERIOD_SECONDS,
  MIN_SSH_RELAY_GRACE_PERIOD_SECONDS
} from '../../../../shared/ssh-types'

const SshTarget = z.object({
  targetId: z.string().min(1)
})

function listRegisteredSshTargetSummaries(): { id: string; label: string }[] {
  return listRegisteredSshTargets().map(({ id, label }) => ({ id, label }))
}

const ManualSshTarget = z
  .object({
    label: z.string().trim().min(1).max(200),
    configHost: z.string().trim().min(1).max(512).optional(),
    host: z.string().trim().min(1).max(512),
    port: z.number().int().min(1).max(65_535),
    username: z.string().trim().max(200),
    identityFile: z.string().trim().min(1).max(4096).optional(),
    relayGracePeriodSeconds: z
      .number()
      .int()
      .min(0)
      .max(MAX_SSH_RELAY_GRACE_PERIOD_SECONDS)
      .refine(
        (value) => value === 0 || value >= MIN_SSH_RELAY_GRACE_PERIOD_SECONDS,
        `Relay grace period must be 0 or at least ${MIN_SSH_RELAY_GRACE_PERIOD_SECONDS}`
      )
      .optional(),
    systemSshConnectionReuse: z.boolean().optional()
  })
  .strict()

const SshBrowse = SshTarget.extend({
  dirPath: z.string().min(1).max(4096)
})

export const SSH_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'ssh.getState',
    params: SshTarget,
    handler: (params) => ({
      state: getPublicSshState(getRegisteredSshState(params.targetId) ?? null)
    })
  }),
  defineMethod({
    name: 'ssh.connect',
    params: SshTarget,
    handler: async (params) => {
      try {
        return { state: getPublicSshState(await connectRegisteredSshTarget(params.targetId)) }
      } catch {
        const state = getRegisteredSshState(params.targetId)
        throw new Error(getPublicSshError(state?.status ?? 'error'))
      }
    }
  }),
  defineMethod({
    name: 'ssh.listTargets',
    params: null,
    // Why: legacy clients can call this method directly, so it must preserve the same HUB-private secret boundary.
    handler: () => ({ targets: listRegisteredSshTargetSummaries() })
  }),
  defineMethod({
    name: 'ssh.listTargetSummaries',
    params: null,
    // Why: paired clients need display identity only; SSH addresses, jump chains, and credentials remain HUB-private.
    handler: () => ({ targets: listRegisteredSshTargetSummaries() })
  }),
  defineMethod({
    name: 'ssh.listRemovedTargetLabels',
    params: null,
    handler: () => ({ labels: listRegisteredRemovedSshTargetLabels() })
  }),
  defineMethod({
    name: 'ssh.addTarget',
    params: z.object({ target: ManualSshTarget }).strict(),
    handler: (params) => addRegisteredSshTarget(params.target)
  }),
  defineMethod({
    name: 'ssh.importConfig',
    params: z.object({ reAdopt: z.boolean().optional() }).strict().optional(),
    handler: (params) => importRegisteredSshConfig(params)
  }),
  defineMethod({
    name: 'ssh.browseDir',
    params: SshBrowse,
    handler: (params) =>
      browseSshDirectory(getSshConnectionManager(), params.targetId, params.dirPath)
  })
]
