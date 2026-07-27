import { z } from 'zod'
import { defineMethod, defineStreamingMethod, type RpcAnyMethod } from '../core'
import { OptionalFiniteNumber } from '../schemas'

// Why: monotonically increasing per-process counter avoids the Date.now()
// collision that fired when two near-simultaneous accounts.subscribe calls
// collided on the same millisecond and one evicted the other through
// registerSubscriptionCleanup's existing-key eviction path.
let accountsSubscriptionSeq = 0

const CodexResetTarget = z.discriminatedUnion('runtime', [
  z.object({ runtime: z.literal('host'), wslDistro: z.null() }).strict(),
  // Why: reset scope must identify one exact WSL distro; null means all slots only for selection.
  z.object({ runtime: z.literal('wsl'), wslDistro: z.string().trim().min(1).max(255) }).strict()
])

const CodexSelectionTarget = z.discriminatedUnion('runtime', [
  z.object({ runtime: z.literal('host'), wslDistro: z.null() }).strict(),
  z
    .object({
      runtime: z.literal('wsl'),
      // A null distro intentionally means all WSL selection slots.
      wslDistro: z.string().trim().min(1).max(255).nullable()
    })
    .strict()
])

const SelectAccountParams = z.object({
  accountId: z
    .union([z.string().min(1, 'Missing accountId'), z.null()])
    .transform((v) => (v === null ? null : v))
})

const SelectCodexAccountForTargetParams = SelectAccountParams.extend({
  target: CodexSelectionTarget
})

const RemoveAccountParams = z.object({
  accountId: z.string().min(1, 'Missing accountId')
})

const CodexResetExpectedScope = z
  .object({
    target: CodexResetTarget,
    accountId: z.string().min(1, 'Missing accountId').max(512),
    accountRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    offerRevision: z.string().startsWith('v1:', 'Invalid offerRevision').max(4_096)
  })
  .strict()

const ConsumeCodexResetCreditParams = z
  .object({
    // Why: the phone owns the logical attempt key so a lost response can be
    // retried without spending a finite earned credit twice.
    idempotencyKey: z.uuid('Invalid idempotencyKey'),
    expectedScope: CodexResetExpectedScope
  })
  .strict()

const AccountsUnsubscribeParams = z.object({
  subscriptionId: z
    .unknown()
    .transform((value) => (typeof value === 'string' && value.length > 0 ? value : ''))
    .pipe(z.string().min(1, 'Missing subscriptionId'))
})

const AddAccountParams = z.object({
  target: z
    .object({
      runtime: z.enum(['host', 'wsl']).optional(),
      wslDistro: z.union([z.string(), z.null()]).optional()
    })
    .optional()
})

const PollAddAccountParams = z.object({
  loginId: z.string().min(1, 'Missing loginId'),
  timeoutMs: OptionalFiniteNumber
})

const SubmitLoginInputParams = z.object({
  loginId: z.string().min(1, 'Missing loginId'),
  input: z.string().min(1, 'Missing input')
})

// Why: bridges the desktop ClaudeAccountService / CodexAccountService /
// RateLimitService into the mobile WebSocket RPC and the headless CLI.
// Add/re-auth still spawn `claude login` / `codex login`, which need a real
// OAuth browser round-trip — accounts.addCodex/addClaude kick that off and
// return a loginId immediately, and accounts.pollAdd long-polls the result
// (the one-shot CLI transport can't hold a streaming method open; see plan
// in spec doc for issue #1438).
export const ACCOUNT_METHODS: readonly RpcAnyMethod[] = [
  defineMethod({
    name: 'accounts.list',
    params: null,
    handler: async (_params, { runtime }) => {
      // Why: ensure the snapshot reflects the latest provider state before
      // returning. Desktop polling pauses when the window is unfocused and
      // inactive-account caches only fill on AccountsPane open, so without
      // this the mobile UI would render stale nulls / zeroes.
      await runtime.refreshAccountsForMobile()
      return runtime.getAccountsSnapshot()
    }
  }),
  defineMethod({
    name: 'accounts.selectClaude',
    params: SelectAccountParams,
    handler: async (params, { runtime }) => runtime.selectClaudeAccount(params.accountId)
  }),
  defineMethod({
    name: 'accounts.selectCodex',
    params: SelectAccountParams,
    handler: async (params, { runtime }) => runtime.selectCodexAccount(params.accountId)
  }),
  defineMethod({
    // Why: old hosts silently strip unknown target fields from selectCodex.
    // A distinct RPC makes version skew fail before it can clear the host slot.
    name: 'accounts.selectCodexForTarget',
    params: SelectCodexAccountForTargetParams,
    handler: async (params, { runtime }) =>
      runtime.selectCodexAccountForTarget(params.accountId, params.target)
  }),
  defineMethod({
    name: 'accounts.consumeCodexResetCredit',
    params: ConsumeCodexResetCreditParams,
    handler: async (params, { runtime }) =>
      runtime.consumeCodexRateLimitResetCredit(params.idempotencyKey, params.expectedScope)
  }),
  defineMethod({
    name: 'accounts.removeClaude',
    params: RemoveAccountParams,
    handler: async (params, { runtime }) => runtime.removeClaudeAccount(params.accountId)
  }),
  defineMethod({
    name: 'accounts.removeCodex',
    params: RemoveAccountParams,
    handler: async (params, { runtime }) => runtime.removeCodexAccount(params.accountId)
  }),
  defineMethod({
    name: 'accounts.addCodex',
    params: AddAccountParams,
    handler: async (params, { runtime }) => runtime.addCodexAccount(params.target)
  }),
  defineMethod({
    name: 'accounts.addClaude',
    params: AddAccountParams,
    handler: async (params, { runtime }) => runtime.addClaudeAccount(params.target)
  }),
  defineMethod({
    name: 'accounts.pollAdd',
    params: PollAddAccountParams,
    handler: async (params, { runtime, signal }) =>
      runtime.pollAddAccount(params.loginId, { timeoutMs: params.timeoutMs, signal })
  }),
  // Why: relays a pasted OAuth code from the CLI's terminal into the Claude
  // login child process's stdin on the server — see ClaudeAccountAddOptions.
  defineMethod({
    name: 'accounts.submitLoginInput',
    params: SubmitLoginInputParams,
    handler: async (params, { runtime }) => {
      runtime.submitAccountLoginInput(params.loginId, params.input)
      return { submitted: true }
    }
  }),
  // Why: streaming counterpart so mobile usage bars refresh in place when the
  // desktop's 5-minute rate-limit poll completes or when the user switches
  // accounts on either side. Mirrors the notifications.subscribe pattern.
  defineStreamingMethod({
    name: 'accounts.subscribe',
    params: null,
    handler: async (_params, { runtime, connectionId }, emit) => {
      await new Promise<void>((resolve) => {
        const unsubscribe = runtime.onAccountsChanged((snapshot) => {
          emit({ type: 'snapshot', snapshot })
        })

        // Why: scope the id by connectionId so two sockets from the same
        // device (host + accounts screen) cannot evict each other through
        // registerSubscriptionCleanup's "existing key" branch, and append a
        // per-process counter so two concurrent subscribes on the same
        // socket also can't collide.
        const seq = ++accountsSubscriptionSeq
        const subscriptionId = `accounts-${connectionId ?? 'inproc'}-${seq}`
        runtime.registerSubscriptionCleanup(
          subscriptionId,
          () => {
            unsubscribe()
            emit({ type: 'end' })
            resolve()
          },
          connectionId
        )

        // Why: emit the current snapshot synchronously so the phone has
        // something to render immediately, then refresh only stale data.
        // Connection cutovers replay this subscription and must not turn the
        // manual-force lane into an unbounded provider-fetch loop.
        emit({ type: 'ready', subscriptionId, snapshot: runtime.getAccountsSnapshot() })
        void runtime.refreshAccountsForMobileSubscriber()
      })
    }
  }),
  defineMethod({
    name: 'accounts.unsubscribe',
    params: AccountsUnsubscribeParams,
    handler: async (params, { runtime }) => {
      runtime.cleanupSubscription(params.subscriptionId)
      return { unsubscribed: true }
    }
  })
]
