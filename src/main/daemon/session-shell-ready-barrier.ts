import {
  installDeviceAttributesResponder,
  STARTUP_DA1_RESPONSE
} from './startup-device-attributes-responder'
import { PostReadyFlushGate } from './post-ready-flush-gate'
import {
  createShellStartupOutputScanState,
  drainShellStartupOutputScanState,
  scanShellStartupOutput,
  type ShellStartupOutputScanState
} from '../shell-startup-output-scanner'
import {
  createShellPromptReadinessProbe,
  type ShellPromptReadinessProbe
} from '../shell-prompt-readiness-probe'
import type { HeadlessEmulator } from './headless-emulator'
import type { SubprocessHandle } from './session-subprocess-handle'
import type { ShellReadyState } from './types'

export const SHELL_READY_TIMEOUT_MS = 15_000
export const SHELL_READY_LATE_MARKER_GRACE_MS = 30_000
// Why: Codex skips marker-gated command delivery; this only bounds older daemon/local paths that still report shell-ready for Codex.
export const CODEX_SHELL_READY_TIMEOUT_MS = 300

export type SessionShellReadyBarrierDeps = {
  sessionId: string
  subprocess: SubprocessHandle
  responderParser: HeadlessEmulator['responderParser']
  shellReadySupported: boolean
  shellReadyTimeoutMs: number | undefined
  shellReadyLateMarkerGraceMs?: number
  installDeviceAttributesFilter(): void
  releaseDeviceAttributesFilter(): void
  acceptStartupIngress(data: string): void
}

/** The startup gate every byte of PTY output passes through: it strips the shell-ready marker, holds
 *  stdin until the shell can accept it, and owns DA1 authority for as long as the gate is closed. */
export class SessionShellReadyBarrier {
  private _state: ShellReadyState
  private scanState: ShellStartupOutputScanState | null = null
  private shellStartupPid: number | null = null
  private promptReadinessProbe: ShellPromptReadinessProbe | null = null
  private readyTimer: ReturnType<typeof setTimeout> | null = null
  private lateMarkerTimer: ReturnType<typeof setTimeout> | null = null
  private releaseDeviceAttributesResponder: (() => void) | null = null
  private preReadyStdinQueue: string[] = []
  private heldStartupCommand: string | null = null
  private readonly shellReadyLateMarkerGraceMs: number
  private readonly postReadyFlushGate: PostReadyFlushGate

  constructor(private readonly deps: SessionShellReadyBarrierDeps) {
    this.shellReadyLateMarkerGraceMs =
      deps.shellReadyLateMarkerGraceMs ??
      (deps.shellReadyTimeoutMs === undefined ? SHELL_READY_LATE_MARKER_GRACE_MS : 0)

    if (deps.shellReadySupported) {
      this._state = 'pending'
      this.scanState = createShellStartupOutputScanState()
      // Why: `write` queues everything until the ready marker, including the renderer's DA1
      // reply — and a shell that withholds its first prompt until DA1 is answered (fish) then
      // never emits the marker that would release it. Answer from the daemon, past the queue.
      this.releaseDeviceAttributesResponder = installDeviceAttributesResponder({
        parser: deps.responderParser,
        response: STARTUP_DA1_RESPONSE,
        reply: (data) => deps.subprocess.write(data)
      })
      deps.installDeviceAttributesFilter()
      this.readyTimer = setTimeout(() => {
        this.onShellReadyTimeout()
      }, deps.shellReadyTimeoutMs ?? SHELL_READY_TIMEOUT_MS)
    } else {
      this._state = 'unsupported'
    }

    this.postReadyFlushGate = new PostReadyFlushGate(() =>
      this.flushPreReadyQueue({ includeStartupCommand: true })
    )
  }

  get state(): ShellReadyState {
    return this._state
  }

  /** True while stdin must be queued: pre-marker, or inside the post-ready flush-gate window. */
  get isGatingWrites(): boolean {
    return this._state === 'pending' || this.postReadyFlushGate.isPending
  }

  /** Started after the startup ingress exists, matching the order the probe's callbacks assume. */
  startPromptReadinessProbe(): void {
    if (this._state !== 'pending') {
      return
    }
    this.promptReadinessProbe = createShellPromptReadinessProbe({
      slavePath: this.deps.subprocess.slavePath,
      shellPath: this.deps.subprocess.shellPath,
      shellCwd: this.deps.subprocess.shellCwd,
      shellPathEnv: this.deps.subprocess.shellPathEnv,
      getShellPid: () => this.shellStartupPid,
      onPromptReady: () => this.onShellPromptReady()
    })
  }

  /** Queues `data` when the gate is closed; false means the caller must write it through. */
  tryEnqueue(data: string): boolean {
    if (!this.isGatingWrites) {
      return false
    }
    this.preReadyStdinQueue.push(data)
    return true
  }

  /** Holds the initial startup command until ready, or returns false if it should be written now. */
  writeStartupCommand(data: string): boolean {
    if (this._state === 'pending' && this.heldStartupCommand === null) {
      this.heldStartupCommand = data
      return true
    }
    return false
  }

  ingestSubprocessData(data: string): void {
    let releaseStartupDeviceAttributes = false
    // Why the scan state, not the 'pending' state: it outlives the deadline while a held startup
    // command waits on a late marker, and the marker bytes must be stripped whenever it does.
    if (this.scanState) {
      const scanned = scanShellStartupOutput(this.scanState, data)
      data = scanned.output
      if (scanned.shellPid) {
        this.shellStartupPid = scanned.shellPid
      }
      if (scanned.ready) {
        this.transitionToReady(scanned.postMarkerBytesObserved)
        releaseStartupDeviceAttributes = true
      }
    } else {
      this.postReadyFlushGate.notifyData()
    }

    this.deps.acceptStartupIngress(data)
    if (this._state === 'pending' && data.length > 0) {
      this.promptReadinessProbe?.notifyOutput(data)
    }
    if (releaseStartupDeviceAttributes) {
      this.releaseDeviceAttributes()
    }
  }

  releaseHeldBytes(): string {
    if (!this.scanState) {
      return ''
    }
    const heldBytes = drainShellStartupOutputScanState(this.scanState)
    this.scanState = null
    // Why: scanning strips marker bytes before fan-out; if readiness never completes, release any held prefix before timeout/exit discards it.
    this.deps.acceptStartupIngress(heldBytes)
    return heldBytes
  }

  /** Hands DA1 back to the renderer once the barrier is done, however it ended. */
  releaseDeviceAttributes(): void {
    this.releaseDeviceAttributesResponder?.()
    this.releaseDeviceAttributesResponder = null
    this.deps.releaseDeviceAttributesFilter()
  }

  disposePromptReadinessProbe(): void {
    this.promptReadinessProbe?.dispose()
    this.promptReadinessProbe = null
  }

  clearReadyTimer(): void {
    if (this.readyTimer) {
      clearTimeout(this.readyTimer)
      this.readyTimer = null
    }
    if (this.lateMarkerTimer) {
      clearTimeout(this.lateMarkerTimer)
      this.lateMarkerTimer = null
    }
  }

  /** Drops queued stdin and the flush gate; teardown does this, and dispose repeats it defensively. */
  clearPendingWrites(): void {
    this.preReadyStdinQueue = []
    this.postReadyFlushGate.clear()
  }

  clearFlushGate(): void {
    this.postReadyFlushGate.clear()
  }

  reportUndeliveredStartupCommand(): void {
    if (this.heldStartupCommand === null) {
      return
    }
    this.heldStartupCommand = null
    console.warn(
      `[daemon/session] ${this.deps.sessionId}: session ended before the shell-ready marker; its startup command was never delivered`
    )
  }

  dispose(): void {
    this.clearReadyTimer()
    this.disposePromptReadinessProbe()
    this.reportUndeliveredStartupCommand()
    this.scanState = null
    this.clearPendingWrites()
  }

  private transitionToReady(postMarkerBytesObserved = false): void {
    this._state = 'ready'
    this.scanState = null
    this.disposePromptReadinessProbe()
    this.clearReadyTimer()
    if (this.preReadyStdinQueue.length === 0 && this.heldStartupCommand === null) {
      return
    }
    this.postReadyFlushGate.arm(postMarkerBytesObserved)
  }

  private onShellReadyTimeout(): void {
    this.readyTimer = null
    if (this._state !== 'pending') {
      return
    }
    this._state = 'timed_out'
    this.disposePromptReadinessProbe()
    this.releaseDeviceAttributes()
    if (this.heldStartupCommand === null || this.shellReadyLateMarkerGraceMs <= 0) {
      this.releaseHeldBytes()
      this.flushPreReadyQueue({ includeStartupCommand: true })
      return
    }
    // Why: keystrokes go through so the pane is usable, but the startup command keeps waiting.
    this.flushPreReadyQueue({ includeStartupCommand: false })
    this.lateMarkerTimer = setTimeout(() => {
      this.onShellReadyLateMarkerGraceExpired()
    }, this.shellReadyLateMarkerGraceMs)
  }

  private onShellReadyLateMarkerGraceExpired(): void {
    this.lateMarkerTimer = null
    if (this._state !== 'timed_out' || this.heldStartupCommand === null) {
      return
    }
    console.warn(
      `[daemon/session] ${this.deps.sessionId}: no shell-ready marker after ${
        SHELL_READY_TIMEOUT_MS + this.shellReadyLateMarkerGraceMs
      }ms; writing the startup command without proof the shell is reading it`
    )
    this.releaseHeldBytes()
    this.flushPreReadyQueue({ includeStartupCommand: true })
  }

  private onShellPromptReady(): void {
    if (this._state !== 'pending') {
      return
    }
    console.warn(
      `[Session] ${this.deps.sessionId}: shell-ready wrapper was replaced before its marker; releasing at the identified shell prompt. OSC 133 integration may be unavailable.`
    )
    this.releaseHeldBytes()
    this.transitionToReady(true)
    this.releaseDeviceAttributes()
  }

  private flushPreReadyQueue(
    opts: { includeStartupCommand: boolean } = { includeStartupCommand: true }
  ): void {
    const startupCommand = opts.includeStartupCommand ? this.heldStartupCommand : null
    if (startupCommand !== null) {
      this.heldStartupCommand = null
    }
    const queued = this.preReadyStdinQueue
    this.preReadyStdinQueue = []
    if (startupCommand !== null) {
      this.deps.subprocess.write(startupCommand)
    }
    for (const data of queued) {
      this.deps.subprocess.write(data)
    }
  }
}
