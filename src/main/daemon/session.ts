import { isValidPtySize } from './daemon-pty-size'
import type { SessionOutputPlane, AttachedClient } from './session-output-plane'
import type { SessionProducerPause } from './session-producer-pause'
import {
  type SessionShellReadyBarrier,
  SHELL_READY_TIMEOUT_MS,
  SHELL_READY_LATE_MARKER_GRACE_MS,
  CODEX_SHELL_READY_TIMEOUT_MS
} from './session-shell-ready-barrier'
import {
  type SessionTerminationController,
  IMMEDIATE_KILL_PHYSICAL_EXIT_TIMEOUT_MS,
  SESSION_FORCE_KILL_RETRY_MS
} from './session-termination-controller'
import { nudgePowerShellPromptRepaint } from './session-powershell-prompt-repaint'
import type { SubprocessHandle } from './session-subprocess-handle'
import type { SessionOptions } from './session-options'
import type { TuiAgent } from '../../shared/tui-agent'
import { randomUUID } from 'node:crypto'
import type { PtyStartupIngress } from '../../shared/pty-startup-ingress'
import type {
  SessionState,
  ShellReadyState,
  TakePendingOutputResult,
  TerminalSnapshot
} from './types'
import {
  teardownSessionSubprocess,
  handleSessionSubprocessExit,
  disposeSession
} from './session-subprocess-teardown'
import { writeSessionData, writeSessionStartupCommand } from './session-write-router'
import {
  collectSessionPendingOutput,
  prepareSessionForFinalSnapshot
} from './session-pending-output-collector'
import { createSessionComponents } from './session-components'

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

    const components = createSessionComponents({
      opts,
      getState: () => this._state,
      handleSubprocessData: (data) => this.handleSubprocessData(data),
      handleSubprocessExit: (code) => this.handleSubprocessExit(code)
    })
    this.output = components.output
    this.producerPause = components.producerPause
    this.termination = components.termination
    this.shellReady = components.shellReady
    this.startupIngress = components.startupIngress
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
    writeSessionData({
      data,
      disposed: this._disposed,
      state: this._state,
      startupIngress: this.startupIngress,
      shellReady: this.shellReady,
      subprocess: this.subprocess
    })
  }

  writeStartupCommand(data: string): void {
    writeSessionStartupCommand({
      data,
      disposed: this._disposed,
      state: this._state,
      startupIngress: this.startupIngress,
      shellReady: this.shellReady,
      subprocess: this.subprocess
    })
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
    return collectSessionPendingOutput({
      disposed: this._disposed,
      includeSnapshot,
      teardownSnapshot: opts.teardownSnapshot,
      shellReady: this.shellReady,
      startupIngress: this.startupIngress,
      output: this.output,
      getSnapshot: (o) => this.getSnapshot(o)
    })
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
    return prepareSessionForFinalSnapshot(this.shellReady, this.startupIngress)
  }

  dispose(): void {
    if (this._disposed) {
      return
    }
    const result = disposeSession({
      incarnationId: this.incarnationId,
      state: this._state,
      subprocess: this.subprocess,
      output: this.output,
      producerPause: this.producerPause,
      termination: this.termination,
      shellReady: this.shellReady,
      startupIngress: this.startupIngress,
      teardownSubprocess: () => this.#teardownSubprocess()
    })
    if (result.exitCode !== null) {
      this._exitCode = result.exitCode
    }
    this._state = 'exited'
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
    teardownSessionSubprocess({
      output: this.output,
      producerPause: this.producerPause,
      termination: this.termination,
      shellReady: this.shellReady
    })
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
    this._exitCode = code
    this._state = 'exited'
    handleSessionSubprocessExit({
      code,
      incarnationId: this.incarnationId,
      output: this.output,
      producerPause: this.producerPause,
      termination: this.termination,
      shellReady: this.shellReady,
      startupIngress: this.startupIngress,
      onSessionExit: this.onSessionExit
    })
  }

  closeStartupQueryAuthority(): number {
    return this.startupIngress.closeQueryAuthority()
  }
}
