import { isValidPtySize } from './daemon-pty-size'
import { SessionOutputPlane, type AttachedClient } from './session-output-plane'
import { SessionProducerPause } from './session-producer-pause'
import {
  SessionShellReadyBarrier,
  SHELL_READY_TIMEOUT_MS,
  SHELL_READY_LATE_MARKER_GRACE_MS,
  CODEX_SHELL_READY_TIMEOUT_MS
} from './session-shell-ready-barrier'
import {
  SessionTerminationController,
  IMMEDIATE_KILL_PHYSICAL_EXIT_TIMEOUT_MS,
  SESSION_FORCE_KILL_RETRY_MS
} from './session-termination-controller'
import { nudgePowerShellPromptRepaint } from './session-powershell-prompt-repaint'
import type { SubprocessHandle } from './session-subprocess-handle'
import type { SessionOptions } from './session-options'
import type { TuiAgent } from '../../shared/tui-agent'
import { randomUUID } from 'node:crypto'
import { PtyStartupIngress } from '../../shared/pty-startup-ingress'
import { extractOnlyCookedEchoSafeQueryReplies } from '../../shared/terminal-query-reply'
import type {
  SessionState,
  ShellReadyState,
  TakePendingOutputResult,
  TerminalSnapshot
} from './types'
import { createPtySlaveEchoProbe } from '../../shared/pty-slave-line-discipline-echo'

export {
  SHELL_READY_TIMEOUT_MS,
  SHELL_READY_LATE_MARKER_GRACE_MS,
  CODEX_SHELL_READY_TIMEOUT_MS,
  IMMEDIATE_KILL_PHYSICAL_EXIT_TIMEOUT_MS,
  SESSION_FORCE_KILL_RETRY_MS
}

export class Session {
  readonly sessionId: string
  readonly incarnationId = randomUUID()
  readonly terminalHandle: string | null
  readonly launchAgent: TuiAgent | null
  readonly wslDistro: string | null
  private _state: SessionState = 'running'
  private _exitCode: number | null = null
  private _disposed = false
  private subprocess: SubprocessHandle
  private readonly onSessionExit?: (code: number) => void
  private readonly output: SessionOutputPlane
  private readonly producerPause: SessionProducerPause
  private readonly shellReady: SessionShellReadyBarrier
  private readonly termination: SessionTerminationController
  private readonly startupIngress: PtyStartupIngress

  constructor(opts: SessionOptions) {
    this.sessionId = opts.sessionId
    this.terminalHandle = opts.terminalHandle ?? null
    this.launchAgent = opts.launchAgent ?? null
    this.wslDistro = opts.wslDistro ?? null
    this.subprocess = opts.subprocess
    this.onSessionExit = opts.onExit
    this.output = new SessionOutputPlane({
      cols: opts.cols,
      rows: opts.rows,
      scrollback: opts.scrollback,
      wslDistro: opts.wslDistro,
      historySeedChunks: opts.historySeedChunks
    })
    this.producerPause = new SessionProducerPause(this.subprocess)
    this.termination = new SessionTerminationController({
      sessionId: this.sessionId,
      subprocess: this.subprocess,
      launchAgent: this.launchAgent,
      isExited: () => this._state === 'exited',
      releaseProducerPause: (pauseOpts) => this.producerPause.release(pauseOpts)
    })

    this.shellReady = new SessionShellReadyBarrier({
      sessionId: this.sessionId,
      subprocess: this.subprocess,
      responderParser: this.output.responderParser,
      shellReadySupported: opts.shellReadySupported,
      shellReadyTimeoutMs: opts.shellReadyTimeoutMs,
      shellReadyLateMarkerGraceMs: opts.shellReadyLateMarkerGraceMs,
      installDeviceAttributesFilter: () => this.output.installDeviceAttributesFilter(),
      releaseDeviceAttributesFilter: () => this.output.releaseDeviceAttributesFilter(),
      acceptStartupIngress: (data) => this.startupIngress.accept(data)
    })

    const echoProbe = createPtySlaveEchoProbe(this.subprocess.slavePath)
    this.startupIngress = new PtyStartupIngress({
      ...(opts.startupIngress ? { intent: opts.startupIngress } : {}),
      ...(opts.ownerBackend ? { ownerBackend: opts.ownerBackend } : {}),
      write: (data) => this.subprocess.write(data),
      onEmission: (emission) => this.output.emit(emission),
      ...(echoProbe ? { echoProbe } : {})
    })
    this.shellReady.startPromptReadinessProbe()
    this.subprocess.onData((data) => this.handleSubprocessData(data))
    this.subprocess.onExit((code) => this.handleSubprocessExit(code))
  }

  get state(): SessionState {
    return this._state
  }
  get shellState(): ShellReadyState {
    return this.shellReady.state
  }
  get historySeeded(): boolean | undefined {
    return this.output.historySeeded
  }
  get exitCode(): number | null {
    return this._exitCode
  }
  get isAlive(): boolean {
    return this._state !== 'exited'
  }
  get hasAttachedClients(): boolean {
    return this.output.hasAttachedClients
  }
  get isTerminating(): boolean {
    return this.termination.isTerminating
  }
  beginTermination(): boolean {
    return this.termination.beginTermination()
  }
  get pid(): number {
    return this.subprocess.pid
  }

  write(data: string): void {
    if (this._state === 'exited' || this._disposed) {
      return
    }
    if (
      extractOnlyCookedEchoSafeQueryReplies(data) &&
      this.startupIngress.answerLiveQueryReply(data)
    ) {
      return
    }
    if (this.shellReady.tryEnqueue(data)) {
      return
    }
    this.subprocess.write(data)
  }

  writeStartupCommand(data: string): void {
    if (this._state === 'exited' || this._disposed) {
      return
    }
    if (this.shellReady.writeStartupCommand(data)) {
      return
    }
    this.write(data)
  }

  resize(cols: number, rows: number): void {
    if (this._state === 'exited' || this._disposed || !isValidPtySize(cols, rows)) {
      return
    }
    this.output.resize(cols, rows)
    this.subprocess.resize(cols, rows)
  }

  pauseProducer(): void {
    if (this._state === 'exited' || this._disposed) {
      return
    }
    this.producerPause.pause()
  }

  resumeProducer(): void {
    this.producerPause.release({ resume: true })
  }

  kill(): void {
    this.termination.kill()
  }

  signalTerminationRoot(): void {
    this.termination.signalTerminationRoot()
  }

  scheduleForceDisposeFallback(): void {
    this.termination.scheduleForceDisposeFallback()
  }

  async forceKillAndWaitForExit(
    timeoutMs = IMMEDIATE_KILL_PHYSICAL_EXIT_TIMEOUT_MS
  ): Promise<void> {
    await this.termination.forceKillAndWaitForExit(timeoutMs)
  }

  signal(sig: string): void {
    this.termination.signal(sig)
  }

  attachClient(client: Omit<AttachedClient, 'token'>): symbol {
    return this.output.attachClient(client)
  }

  detachClient(token: symbol): void {
    this.output.detachClient(token)
    if (!this.output.hasAttachedClients) {
      this.producerPause.release({ resume: true })
    }
  }

  detachAllClients(): void {
    this.output.clearClients()
    this.producerPause.release({ resume: true })
  }

  getSnapshot(opts: { scrollbackRows?: number } = {}): TerminalSnapshot | null {
    this.startupIngress.snapshotBarrier()
    return this.output.getSnapshot(opts)
  }

  getPartialEscapeTailAnsi(): string {
    return this.output.getPartialEscapeTailAnsi()
  }
  getAppliedSize(): { cols: number; rows: number } | null {
    return this.output.getAppliedSize()
  }

  takePendingOutput(
    includeSnapshot: boolean,
    opts: { teardownSnapshot?: boolean } = {}
  ): TakePendingOutputResult | null {
    if (this._disposed) {
      return null
    }
    const releasedHeldBytes =
      includeSnapshot && opts.teardownSnapshot === true ? this.prepareForFinalSnapshot() : ''
    return this.output.takePendingOutput(includeSnapshot, releasedHeldBytes, () =>
      this.getSnapshot()
    )
  }

  getCwd(): string | null {
    return this.output.getCwd()
  }
  getForegroundProcess(): string | null {
    return this.subprocess.getForegroundProcess()
  }

  async confirmForegroundProcess(): Promise<string | null> {
    return this.subprocess.confirmForegroundProcess?.() ?? this.subprocess.getForegroundProcess()
  }

  clearScrollback(): void {
    if (this._disposed) {
      return
    }
    this.output.clearScrollback()
    this.subprocess.clear?.()
    nudgePowerShellPromptRepaint({
      subprocess: this.subprocess,
      isGatingWrites: this.shellReady.isGatingWrites,
      isCursorOnEmptyPromptLine: () => this.output.isCursorOnEmptyPromptLine()
    })
  }

  prepareForFinalSnapshot(): string {
    const held = this.shellReady.releaseHeldBytes()
    this.startupIngress.snapshotBarrier()
    return held
  }

  dispose(): void {
    if (this._disposed) {
      return
    }
    this.shellReady.releaseDeviceAttributes()
    this.shellReady.releaseHeldBytes()
    this.startupIngress.drainAndClose()
    const wasTerminating = this.termination.isTerminating && this._state !== 'exited'
    const clientsToNotify = wasTerminating ? this.output.snapshotClients() : []
    if (wasTerminating) {
      try {
        this.subprocess.forceKill()
      } catch {
        /* child may already be gone */
      }
      this._exitCode = -1
      this.termination.clearTerminating()
    }

    this.#teardownSubprocess()
    this._state = 'exited'

    this.output.clearClients()
    this.shellReady.clearPendingWrites()
    this.output.disposeEmulator()

    for (const client of clientsToNotify) {
      client.onExit(-1, this.incarnationId)
    }
  }

  disposeSubprocess(): void {
    this.#teardownSubprocess()
    this._state = 'exited'
  }

  async forceKillAndDisposeSubprocess(): Promise<void> {
    await this.forceKillAndWaitForExit()
    this.dispose()
  }

  #teardownSubprocess(): void {
    if (this._disposed) {
      return
    }
    this._disposed = true
    this.output.markDisposed()
    this.producerPause.release({ resume: true })
    this.termination.cancelForceKillFallback()
    this.shellReady.dispose()
    this.termination.disposeSubprocessHandle()
  }

  private handleSubprocessData(data: string): void {
    if (this._disposed) {
      return
    }
    this.shellReady.ingestSubprocessData(data)
  }

  private handleSubprocessExit(code: number): void {
    this.termination.markPhysicalExit()
    if (this._disposed) {
      return
    }

    this.shellReady.releaseDeviceAttributes()
    this.shellReady.disposePromptReadinessProbe()
    this.shellReady.releaseHeldBytes()
    this.startupIngress.drainAndClose()
    this._exitCode = code
    this._state = 'exited'
    this.termination.clearTerminating()
    this.producerPause.release({ resume: false })

    this.termination.cancelForceKillFallback()
    this.shellReady.clearReadyTimer()
    this.shellReady.reportUndeliveredStartupCommand()
    this.shellReady.clearFlushGate()
    this.termination.disposeSubprocessHandle()

    this.output.broadcastExit(code, this.incarnationId)
    this.onSessionExit?.(code)
  }

  closeStartupQueryAuthority(): number {
    return this.startupIngress.closeQueryAuthority()
  }
}
