import { SessionOutputPlane } from './session-output-plane'
import { SessionProducerPause } from './session-producer-pause'
import { SessionShellReadyBarrier } from './session-shell-ready-barrier'
import { SessionTerminationController } from './session-termination-controller'
import { PtyStartupIngress } from '../../shared/pty-startup-ingress'
import { createPtySlaveEchoProbe } from '../../shared/pty-slave-line-discipline-echo'
import type { SessionOptions } from './session-options'
import type { SessionState } from './types'

export type SessionComponents = {
  output: SessionOutputPlane
  producerPause: SessionProducerPause
  termination: SessionTerminationController
  shellReady: SessionShellReadyBarrier
  startupIngress: PtyStartupIngress
}

export function createSessionComponents(args: {
  opts: SessionOptions
  getState: () => SessionState
  handleSubprocessData: (data: string) => void
  handleSubprocessExit: (code: number) => void
}): SessionComponents {
  const { opts } = args
  const output = new SessionOutputPlane({
    cols: opts.cols,
    rows: opts.rows,
    scrollback: opts.scrollback,
    wslDistro: opts.wslDistro,
    historySeedChunks: opts.historySeedChunks
  })
  const producerPause = new SessionProducerPause(opts.subprocess)
  const termination = new SessionTerminationController({
    sessionId: opts.sessionId,
    subprocess: opts.subprocess,
    launchAgent: opts.launchAgent ?? null,
    isExited: () => args.getState() === 'exited',
    releaseProducerPause: (pauseOpts) => producerPause.release(pauseOpts)
  })

  let startupIngressRef: PtyStartupIngress | null = null
  const shellReady = new SessionShellReadyBarrier({
    sessionId: opts.sessionId,
    subprocess: opts.subprocess,
    responderParser: output.responderParser,
    shellReadySupported: opts.shellReadySupported,
    shellReadyTimeoutMs: opts.shellReadyTimeoutMs,
    shellReadyLateMarkerGraceMs: opts.shellReadyLateMarkerGraceMs,
    installDeviceAttributesFilter: () => output.installDeviceAttributesFilter(),
    releaseDeviceAttributesFilter: () => output.releaseDeviceAttributesFilter(),
    acceptStartupIngress: (data) => startupIngressRef?.accept(data) ?? false
  })

  const echoProbe = createPtySlaveEchoProbe(opts.subprocess.slavePath)
  const startupIngress = new PtyStartupIngress({
    ...(opts.startupIngress ? { intent: opts.startupIngress } : {}),
    ...(opts.ownerBackend ? { ownerBackend: opts.ownerBackend } : {}),
    write: (data) => opts.subprocess.write(data),
    onEmission: (emission) => output.emit(emission),
    ...(echoProbe ? { echoProbe } : {})
  })
  startupIngressRef = startupIngress

  shellReady.startPromptReadinessProbe()
  opts.subprocess.onData(args.handleSubprocessData)
  opts.subprocess.onExit(args.handleSubprocessExit)

  return {
    output,
    producerPause,
    termination,
    shellReady,
    startupIngress
  }
}
