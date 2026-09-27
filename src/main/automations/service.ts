import {
  AutomationDispatchCancelledError,
  requestAutomationDispatch,
  type AutomationRendererChannel
} from './automation-dispatch-request'
export type { AutomationRendererChannel } from './automation-dispatch-request'
import type { Store } from '../persistence'
import type {
  Automation,
  AutomationDispatchResult,
  AutomationPrecheckResult,
  AutomationRun
} from '../../shared/automations-types'
import type { ClaudeUsageStore } from '../claude-usage/store'
import type { CodexUsageStore } from '../codex-usage/store'
import { evaluateAutomationRunPrecheck } from './automation-run-precheck'
import { resolveAutomationRunTarget, type AutomationRunTargetResult } from './run-target-resolution'
import type { HeadlessAutomationDispatcher } from './headless-dispatch'
import { DEFAULT_CODEX_HEADLESS_LAUNCH_TIMEOUT_MS } from './headless-dispatch'
import {
  HeadlessLaunchCleanupRegistry,
  reconcileStaleCodexHeadlessDispatches
} from './headless-dispatch-lifecycle'
import { persistAutomationDispatchResult } from './automation-dispatch-result-persistence'
import {
  AutomationRunCompletionWatcher,
  type AutomationRunTerminalObserver
} from './run-completion-watcher'
import { createAutomationRunWriter, type AutomationRunWriter } from './automation-run-writer'
import { reportAutomationScheduleDrift } from './schedule-drift-report'
import {
  describeScheduledRefusal,
  missedBeyondGrace,
  recordMissedRun,
  recordRefusedAutomationRun,
  recordUnevaluableAutomation
} from './dispatch-refusal'
import type { PublishAutomationsChanged } from '../../shared/runtime-client-events'

const DEFAULT_TICK_MS = 60 * 1000

export class AutomationService {
  private readonly store: Store
  private readonly tickMs: number
  private timer: ReturnType<typeof setInterval> | null = null
  private webContents: AutomationRendererChannel | null = null
  private rendererReady = false
  private evaluating = false
  private stopped = false
  private dispatchGeneration = 0
  private readonly claudeUsage: ClaudeUsageStore | null
  private readonly codexUsage: CodexUsageStore | null
  private readonly allowRemoteHostScheduling: boolean
  private readonly headlessDispatcher: HeadlessAutomationDispatcher | null
  private readonly codexHeadlessLaunchTimeoutMs: number
  private readonly headlessLaunchCleanups = new HeadlessLaunchCleanupRegistry()
  private readonly publish: PublishAutomationsChanged | null
  private readonly runs: AutomationRunWriter
  private readonly completionWatcher: AutomationRunCompletionWatcher | null
  /** Installed by desktop IPC registration, where external probes live; null on
   *  runtime servers. Orca's own automation traffic parks queued external
   *  probes behind this lease, whichever transport carried it. */
  externalProbePriority: (<T>(run: () => T) => T) | null = null

  constructor(
    store: Store,
    opts: {
      tickMs?: number
      claudeUsage?: ClaudeUsageStore
      codexUsage?: CodexUsageStore
      allowRemoteHostScheduling?: boolean
      headlessDispatcher?: HeadlessAutomationDispatcher
      codexHeadlessLaunchTimeoutMs?: number
      terminalObserver?: AutomationRunTerminalObserver
      onAutomationsChanged?: PublishAutomationsChanged
    } = {}
  ) {
    this.store = store
    this.tickMs = opts.tickMs ?? DEFAULT_TICK_MS
    this.claudeUsage = opts.claudeUsage ?? null
    this.codexUsage = opts.codexUsage ?? null
    this.allowRemoteHostScheduling = opts.allowRemoteHostScheduling ?? false
    this.headlessDispatcher = opts.headlessDispatcher ?? null
    this.codexHeadlessLaunchTimeoutMs =
      opts.codexHeadlessLaunchTimeoutMs ?? DEFAULT_CODEX_HEADLESS_LAUNCH_TIMEOUT_MS
    this.publish = opts.onAutomationsChanged ?? null
    this.runs = createAutomationRunWriter(store, this.publish)
    this.completionWatcher = opts.terminalObserver
      ? new AutomationRunCompletionWatcher({
          observer: opts.terminalObserver,
          readRun: (automationId, runId) =>
            this.store.listAutomationRuns(automationId).find((entry) => entry.id === runId) ?? null,
          markDispatchResult: (result) => this.markDispatchResult(result)
        })
      : null
  }

  /** CRUD callers publish through the service so every authority write lands on
   *  the same local + runtime client-event pair. */
  publishAutomationsChanged(payload: Parameters<PublishAutomationsChanged>[0] = {}): void {
    this.publish?.(payload)
  }

  setWebContents(webContents: AutomationRendererChannel | null): void {
    this.webContents = webContents
    this.rendererReady = false
  }

  setRendererReady(): void {
    this.rendererReady = true
    // Why: the renderer publishes the desktop window graph, so only after it
    // attaches can an unresolvable pane mean a lost terminal rather than "not yet".
    this.completionWatcher?.markTerminalSurfaceReady()
    void this.evaluateDueRuns()
  }

  start(): void {
    if (this.timer) {
      return
    }
    this.stopped = false
    this.timer = setInterval(() => {
      void this.evaluateDueRuns()
    }, this.tickMs)
    this.completionWatcher?.reconcileRetainedRuns(this.store.listAutomationRuns())
    reportAutomationScheduleDrift(this.store.listAutomations())
    // Why: headless serve never gets a renderer-ready IPC, but due runs still
    // need the same startup catch-up pass desktop gets after renderer attach.
    if (this.rendererReady || this.headlessDispatcher) {
      // Serve adopts its daemon PTYs and publishes its graph before start(), so
      // its terminal surface is already as answerable as it will get.
      this.completionWatcher?.markTerminalSurfaceReady()
      void this.evaluateDueRuns()
    }
  }

  stop(): void {
    this.stopped = true
    this.dispatchGeneration += 1
    this.completionWatcher?.dispose()
    if (!this.timer) {
      return
    }
    clearInterval(this.timer)
    this.timer = null
  }

  async runNow(automationId: string): Promise<AutomationRun> {
    const generation = this.dispatchGeneration
    const automation = this.store.listAutomations().find((entry) => entry.id === automationId)
    if (!automation) {
      throw new Error('Automation not found.')
    }
    const target = this.resolveTarget(automation)
    const run = await this.runs.createRun(automation, Date.now(), 'manual')
    return await this.requestDispatch(automation, run, target, generation)
  }

  /** The run-history row doc:94 pairs with the typed refusal an execute fence throws. */
  async recordRefusedRun(automationId: string): Promise<void> {
    const automation = this.store.listAutomations().find((entry) => entry.id === automationId)
    if (automation) {
      await recordRefusedAutomationRun({
        store: this.store,
        runs: this.runs,
        automation,
        allowRemoteHostScheduling: this.allowRemoteHostScheduling
      })
    }
  }

  async runPrecheck(automationId: string, runId: string): Promise<AutomationPrecheckResult | null> {
    return await evaluateAutomationRunPrecheck({
      store: this.store,
      automationId,
      runId,
      allowRemoteHostScheduling: this.allowRemoteHostScheduling
    })
  }

  async markDispatchResult(result: AutomationDispatchResult): Promise<AutomationRun> {
    return await persistAutomationDispatchResult({
      store: this.store,
      runs: this.runs,
      result,
      claudeUsage: this.claudeUsage,
      codexUsage: this.codexUsage,
      completionWatcher: this.completionWatcher,
      clearHeadlessLaunchCleanup: (runId) => this.headlessLaunchCleanups.clear(runId)
    })
  }

  private async evaluateDueRuns(): Promise<void> {
    if (this.evaluating || this.stopped) {
      return
    }
    this.evaluating = true
    const generation = this.dispatchGeneration
    try {
      const now = Date.now()
      await reconcileStaleCodexHeadlessDispatches({
        store: this.store,
        now,
        markDispatchResult: (result) => this.markDispatchResult(result),
        cleanupLaunch: (runId) => this.headlessLaunchCleanups.run(runId),
        clearLaunchCleanup: (runId) => this.headlessLaunchCleanups.clear(runId)
      })
      for (const automation of this.store.listAutomations()) {
        if (this.stopped || generation !== this.dispatchGeneration) {
          break
        }
        if (!automation.enabled || automation.nextRunAt > now) {
          continue
        }
        // Isolated per record (#16303): an unreadable schedule throws out of the
        // occurrence math, and an uncaught throw here skipped every later due row.
        try {
          await this.evaluateAutomation(automation, now)
        } catch (error) {
          if (
            !(error instanceof AutomationDispatchCancelledError) &&
            !this.stopped &&
            generation === this.dispatchGeneration &&
            this.store.listAutomations().some((current) => current.id === automation.id)
          ) {
            await recordUnevaluableAutomation({ runs: this.runs, automation, error })
          }
        }
      }
    } finally {
      this.evaluating = false
    }
  }

  private async evaluateAutomation(automation: Automation, now: number): Promise<void> {
    const generation = this.dispatchGeneration
    const scheduledFor = this.store.getLatestAutomationOccurrence(automation, now)
    if (scheduledFor === null) {
      await this.runs.advanceNextRun(automation.id, now)
      return
    }
    if (missedBeyondGrace({ automation, scheduledFor, now, tickMs: this.tickMs })) {
      await recordMissedRun({ runs: this.runs, automation, scheduledFor })
      await this.runs.advanceNextRun(automation.id, now)
      return
    }

    // Resolved before the run exists: a refusal repeats every occurrence, and a
    // */5 automation would otherwise write ~288 identical rows a day — past
    // retention, which would evict the automation's real history.
    const target = this.resolveTarget(automation)
    const canDispatch = this.canDispatchToRenderer() || Boolean(this.headlessDispatcher)
    const refusal = describeScheduledRefusal({ target, canDispatch })
    if (refusal && (await this.runs.repeatSkip(automation.id, refusal, scheduledFor))) {
      await this.runs.advanceNextRun(automation.id, now)
      return
    }

    await this.requestDispatch(
      automation,
      await this.runs.createRun(automation, scheduledFor),
      target,
      generation
    )
    await this.runs.advanceNextRun(automation.id, now)
  }

  private resolveTarget(automation: Automation): AutomationRunTargetResult {
    return resolveAutomationRunTarget(this.store, automation, {
      allowRemoteHostScheduling: this.allowRemoteHostScheduling
    })
  }

  private canDispatchToRenderer(): boolean {
    const webContents = this.webContents
    return Boolean(webContents && !webContents.isDestroyed() && this.rendererReady)
  }

  private requestDispatch(
    automation: Automation,
    run: AutomationRun,
    target: AutomationRunTargetResult,
    generation: number
  ): Promise<AutomationRun> {
    return requestAutomationDispatch(
      {
        store: this.store,
        runs: this.runs,
        isActive: () => !this.stopped && generation === this.dispatchGeneration,
        getRenderer: () => (this.canDispatchToRenderer() ? this.webContents : null),
        headlessDispatcher: this.headlessDispatcher,
        resolveTarget: (current) => this.resolveTarget(current),
        runPrecheck: () => this.runPrecheck(automation.id, run.id),
        markDispatchResult: (result) => this.markDispatchResult(result),
        watchRun: (dispatched) => this.completionWatcher?.watch(dispatched),
        codexHeadlessLaunchTimeoutMs: this.codexHeadlessLaunchTimeoutMs,
        registerLaunchCleanup: (runId, cleanup) =>
          this.headlessLaunchCleanups.register(runId, cleanup),
        clearLaunchCleanup: (runId) => this.headlessLaunchCleanups.clear(runId),
        cleanupLaunch: (runId) => this.headlessLaunchCleanups.run(runId)
      },
      automation,
      run,
      target
    )
  }
}
