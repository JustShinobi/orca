import { GROK_HOME_ENVELOPE_MAX_LENGTH } from '../../shared/grok-session-paths'
import { buildWindowsAgentHookPostCommand } from '../agent-hooks/installer-utils'
import {
  buildWindowsHookEnvironmentGuardLines,
  buildWindowsHookStdinDrainEpilogue
} from '../agent-hooks/hook-stdin-contract'

const GROK_HOME_READY_LABEL = 'orca_grok_home_ready'
const WINDOWS_HOOK_PAYLOAD_FORM_LINE = '  --data-urlencode "payload@-" >nul 2>nul'

const WINDOWS_GROK_HOOK_POST_COMMAND = buildWindowsAgentHookPostCommand('grok').replace(
  WINDOWS_HOOK_PAYLOAD_FORM_LINE,
  `  --data-urlencode "grokHome=%ORCA_GROK_HOME%" ^\r\n${WINDOWS_HOOK_PAYLOAD_FORM_LINE}`
)

/** cmd.exe body of the managed Grok hook, installed for local win32 sessions. */
export function buildGrokWindowsHookScript(): string {
  return [
    '@echo off',
    'setlocal',
    'if defined ORCA_AGENT_HOOK_ENDPOINT if exist "%ORCA_AGENT_HOOK_ENDPOINT%" call "%ORCA_AGENT_HOOK_ENDPOINT%" 2>nul',
    ...buildWindowsHookEnvironmentGuardLines(),
    // Why (#12326): cmd expands `%VAR:~N%` on an undefined variable into a bare
    // `~N` token while reading the line, so the guards below turn into invalid
    // syntax and abort the whole hook with exit 255 — and GROK_HOME is unset for
    // most Orca-launched sessions. An `if defined` prefix is too late (expansion
    // precedes it); only a jump keeps those lines unread.
    'set "ORCA_GROK_HOME=%GROK_HOME%"',
    `if not defined ORCA_GROK_HOME goto :${GROK_HOME_READY_LABEL}`,
    `if not "%ORCA_GROK_HOME:~${GROK_HOME_ENVELOPE_MAX_LENGTH},1%"=="" set "ORCA_GROK_HOME="`,
    `if not defined ORCA_GROK_HOME goto :${GROK_HOME_READY_LABEL}`,
    // Why: a trailing backslash escapes curl's closing argv quote on Windows,
    // merging the payload option into grokHome and dropping the hook body.
    'if "%ORCA_GROK_HOME:~-1%"=="\\" set "ORCA_GROK_HOME=%ORCA_GROK_HOME%."',
    `:${GROK_HOME_READY_LABEL}`,
    WINDOWS_GROK_HOOK_POST_COMMAND,
    'exit /b 0',
    ...buildWindowsHookStdinDrainEpilogue(),
    ''
  ].join('\r\n')
}
