import { spawn } from 'node:child_process'
import { delimiter } from 'node:path'
import { stripElectronRunAsNode } from '../runtime/launch'
import {
  getVersionManagerBinPaths,
  resolveCliCommand,
  withCliRuntimeOnPath
} from '../../shared/node-cli-command-resolution'
import {
  getSpawnArgsForWindows,
  UnsafeWindowsBatchArgumentsError,
  WINDOWS_BATCH_UNSAFE_CHARACTERS_LABEL
} from '../../shared/windows-batch-spawn'
import { stdioForWindowsInteractiveChild } from '../../shared/windows-console-input'
import { RuntimeClientError } from '../runtime-client'
import type { InteractiveLoginSession } from './interactive-login-interruption'

export function addAgentNodePaths(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const pathKey =
    process.platform === 'win32' && env.Path !== undefined && env.PATH === undefined
      ? 'Path'
      : 'PATH'
  const currentEntries = (env[pathKey] ?? '').split(delimiter).filter(Boolean)
  const existing = new Set(currentEntries)
  const missing = getVersionManagerBinPaths().filter((entry) => !existing.has(entry))
  if (missing.length > 0) {
    env[pathKey] = [...missing, ...currentEntries].join(delimiter)
  }
  return env
}

/**
 * Runs the real agent login attached to the user's terminal so the OAuth
 * URL/device-code prompt is visible and the code can be pasted back — the desktop
 * GUI flow drives this via a browser Orca can't reach on a headless host.
 */
export async function runAgentLoginInTerminal(
  command: string,
  args: string[],
  extraEnv: Record<string, string>,
  json: boolean,
  session: InteractiveLoginSession
): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const resolvedCommand = resolveCliCommand(command)
    let spawnCmd: string
    let spawnArgs: string[]
    try {
      ;({ spawnCmd, spawnArgs } = getSpawnArgsForWindows(resolvedCommand, args))
    } catch (error) {
      // Why: the bare sentinel message reaches the user verbatim otherwise, with
      // nothing naming the path or the characters that made it unspawnable.
      rejectPromise(
        error instanceof UnsafeWindowsBatchArgumentsError
          ? new RuntimeClientError(
              'invalid_environment',
              `Cannot run \`${command}\` from "${resolvedCommand}": the path contains characters ` +
                `cmd.exe would reinterpret. Install it somewhere without ` +
                `${WINDOWS_BATCH_UNSAFE_CHARACTERS_LABEL} in the path.`
            )
          : error
      )
      return
    }
    // Why paired after the seed: addAgentNodePaths prepends the *newest* version
    // manager bin, which is not necessarily where this CLI lives. Pairing last puts
    // the CLI's own node in front of that seed (stablyai/orca#10932).
    const env = withCliRuntimeOnPath(
      resolvedCommand,
      addAgentNodePaths({ ...stripElectronRunAsNode(process.env), ...extraEnv })
    )
    const consoleStdio = stdioForWindowsInteractiveChild(json)
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(spawnCmd, spawnArgs, {
        // Why: JSON mode reserves stdout for the response envelope while keeping
        // the interactive login attached to the user's terminal via stderr.
        stdio: consoleStdio.stdio,
        env
      })
    } finally {
      consoleStdio.dispose()
    }
    session.child = child
    child.once('error', (error) =>
      rejectPromise(
        new RuntimeClientError(
          'internal',
          `Could not launch \`${command}\`. Is it installed and on PATH? (${
            error instanceof Error ? error.message : String(error)
          })`
        )
      )
    )
    child.once('exit', (code) => {
      session.child = null
      if (code === 0) {
        resolvePromise()
        return
      }
      rejectPromise(
        new RuntimeClientError(
          'internal',
          `\`${command} ${args.join(' ')}\` exited with code ${code ?? 'null'}.`
        )
      )
    })
  })
}
