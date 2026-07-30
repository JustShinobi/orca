import { app, ipcMain } from 'electron'
import {
  configureAiVaultSessionSources,
  listAiVaultSessions as listCachedLocalAiVaultSessions,
  resetAiVaultSessionListCacheForTests,
  type AiVaultSessionSources
} from '../ai-vault/cached-session-list'
import {
  listCachedRemoteAiVaultSessions,
  resetCachedRemoteAiVaultSessionsForTests
} from '../ai-vault/cached-remote-session-list'
import { aiVaultScanIssueResult } from '../ai-vault/session-list-results'
import type { AiVaultListArgs, AiVaultListResult } from '../../shared/ai-vault-types'
import { registerAiVaultResumeHandler, type AiVaultResumeHandlerOptions } from './ai-vault-resume'
import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostScope,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostScope
} from '../../shared/execution-host'
import {
  getSshFilesystemProvider,
  SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE
} from '../providers/ssh-filesystem-dispatch'
import { getActiveSshAiVaultHostInfo, getActiveSshAiVaultHostInfos } from './ssh'
import { resetAllAiVaultHostScansForTests, scanAllAiVaultHosts } from './ai-vault-all-host-scan'
import { shouldBypassAiVaultMergedCache, shouldForceAiVaultHost } from './ai-vault-refresh-policy'
import { listAiVaultSubagentSessions } from './ai-vault-subagent-list'

const AI_VAULT_CACHE_TTL_MS = 15_000
const AI_VAULT_ALL_HOST_RUNTIME_TIMEOUT_MS = 3_000

type AiVaultHandlerOptions = AiVaultSessionSources &
  AiVaultResumeHandlerOptions & {
    getActiveRuntimeAiVaultHostInfos?: () => readonly RuntimeAiVaultHostInfo[]
    scanRuntimeAiVaultSessions?: (
      environmentId: string,
      args: AiVaultListArgs,
      options?: RuntimeAiVaultScanOptions
    ) => Promise<AiVaultListResult>
  }

type RuntimeAiVaultScanOptions = {
  timeoutMs?: number
}

type CachedAiVaultList = {
  key: string
  result: AiVaultListResult
  expiresAt: number
}

type RuntimeAiVaultHostInfo = {
  environmentId: string
  executionHostId: `runtime:${string}`
}

let cachedList: CachedAiVaultList | null = null
let inflightList: Promise<AiVaultListResult> | null = null
let inflightKey: string | null = null
let handlerOptions: AiVaultHandlerOptions = {}

async function listAiVaultSessions(args?: AiVaultListArgs): Promise<AiVaultListResult> {
  const executionHostScope = normalizeExecutionHostScope(
    args?.executionHostScope ?? LOCAL_EXECUTION_HOST_ID
  )
  // Why: local-scope scans go straight to the shared cache module (also used by
  // the runtime RPC method), so the desktop panel and a paired mobile client
  // never double-scan the same transcripts; the cache below only has to dedupe
  // the multi-host (ssh/runtime/all) merges that exist on the desktop side.
  if (executionHostScope === LOCAL_EXECUTION_HOST_ID) {
    return scanLocalAiVaultSessions(args)
  }
  // Scope paths change the result set, so they must be part of the cache key.
  const key = JSON.stringify({
    limit: args?.limit ?? 'default',
    scopePaths: args?.scopePaths ?? [],
    executionHostScope
  })
  const now = Date.now()
  // Why: opening this panel repeatedly should not re-parse hundreds of JSONL
  // transcripts; explicit refreshes bypass the cache but not an active scan.
  if (
    !shouldBypassAiVaultMergedCache(args) &&
    cachedList?.key === key &&
    cachedList.expiresAt > now
  ) {
    return cachedList.result
  }
  if (inflightList && inflightKey === key) {
    return inflightList
  }

  inflightKey = key
  inflightList = scanAiVaultSessionsByHostScope(args, executionHostScope)
    .then((result) => {
      cachedList = {
        key,
        result,
        expiresAt: Date.now() + AI_VAULT_CACHE_TTL_MS
      }
      return result
    })
    .finally(() => {
      // Only clear tracking if it still refers to this request: a concurrent
      // different-scope scan may have replaced it and must stay dedupable.
      if (inflightKey === key) {
        inflightKey = null
        inflightList = null
      }
    })
  return inflightList
}

async function scanAiVaultSessionsByHostScope(
  args: AiVaultListArgs | undefined,
  executionHostScope: ExecutionHostScope
): Promise<AiVaultListResult> {
  if (executionHostScope === 'all') {
    const runtimeHosts = getActiveRuntimeAiVaultHostInfosResult()
    const runtimeIssues = runtimeHosts.issue ? [runtimeHosts.issue] : []
    return scanAllAiVaultHosts({
      sshHosts: getActiveSshAiVaultHostInfos(),
      runtimeHosts: runtimeHosts.hostInfos,
      runtimeIssues,
      limit: args?.limit,
      scanLocal: () => scanLocalAiVaultSessions(args),
      scanSsh: (hostInfo, signal) => scanSshAiVaultSessions(hostInfo.targetId, args, signal),
      scanRuntime: (hostInfo) =>
        scanRuntimeAiVaultSessions(hostInfo, args, {
          timeoutMs: AI_VAULT_ALL_HOST_RUNTIME_TIMEOUT_MS
        })
    })
  }

  const parsed = parseExecutionHostId(executionHostScope)
  if (parsed?.kind === 'ssh') {
    return scanSshAiVaultSessions(parsed.targetId, args)
  }
  if (parsed?.kind === 'runtime') {
    return scanRuntimeAiVaultSessions(
      {
        environmentId: parsed.environmentId,
        executionHostId: toRuntimeExecutionHostId(parsed.environmentId)
      },
      args
    )
  }

  return aiVaultScanIssueResult({
    executionHostId: executionHostScope,
    path: executionHostScope,
    message: 'Agent Session History is not available for this execution host.'
  })
}

function getActiveRuntimeAiVaultHostInfos(): readonly RuntimeAiVaultHostInfo[] {
  return handlerOptions.getActiveRuntimeAiVaultHostInfos?.() ?? []
}

function getActiveRuntimeAiVaultHostInfosResult(): {
  hostInfos: readonly RuntimeAiVaultHostInfo[]
  issue?: AiVaultListResult
} {
  try {
    return { hostInfos: getActiveRuntimeAiVaultHostInfos() }
  } catch (error) {
    return {
      hostInfos: [],
      issue: aiVaultScanIssueResult({
        path: 'runtime environments',
        message: error instanceof Error ? error.message : 'Runtime hosts are unavailable.'
      })
    }
  }
}

async function scanRuntimeAiVaultSessions(
  hostInfo: RuntimeAiVaultHostInfo,
  args?: AiVaultListArgs,
  options: RuntimeAiVaultScanOptions = {}
): Promise<AiVaultListResult> {
  const scanner = handlerOptions.scanRuntimeAiVaultSessions
  if (!scanner) {
    return aiVaultScanIssueResult({
      executionHostId: hostInfo.executionHostId,
      path: hostInfo.environmentId,
      message: 'Agent Session History is not available for this execution host.'
    })
  }
  const scanArgs: AiVaultListArgs = { executionHostScope: hostInfo.executionHostId }
  if (args?.limit !== undefined) {
    scanArgs.limit = args.limit
  }
  scanArgs.force = shouldForceAiVaultHost(args, hostInfo.executionHostId)
  if (args?.scopePaths !== undefined) {
    scanArgs.scopePaths = args.scopePaths
  }
  try {
    return await scanner(hostInfo.environmentId, scanArgs, options)
  } catch (error) {
    return aiVaultScanIssueResult({
      executionHostId: hostInfo.executionHostId,
      path: hostInfo.environmentId,
      message: error instanceof Error ? error.message : 'Remote Orca server is unavailable.'
    })
  }
}

async function scanLocalAiVaultSessions(args?: AiVaultListArgs): Promise<AiVaultListResult> {
  // Why: the shared cache module owns codex-home/WSL sourcing and the local
  // scan cache, so the desktop IPC path and the runtime RPC method (mobile)
  // share one cache instance and one source of managed-Codex homes.
  return listCachedLocalAiVaultSessions({
    limit: args?.limit,
    force: shouldForceAiVaultHost(args, LOCAL_EXECUTION_HOST_ID),
    scopePaths: args?.scopePaths
  })
}

async function scanSshAiVaultSessions(
  targetId: string,
  args?: AiVaultListArgs,
  signal?: AbortSignal
): Promise<AiVaultListResult> {
  const executionHostId = toSshExecutionHostId(targetId)
  const hostInfo = getActiveSshAiVaultHostInfo(targetId)
  const provider = getSshFilesystemProvider(targetId)
  if (!hostInfo || !provider) {
    return sshScanIssueResult({
      executionHostId,
      targetId,
      message: SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE
    })
  }
  try {
    return await listCachedRemoteAiVaultSessions({
      provider,
      executionHostId: hostInfo.executionHostId,
      remoteHome: hostInfo.remoteHome,
      hostPlatform: hostInfo.hostPlatform,
      limit: args?.limit,
      scopePaths: args?.scopePaths,
      force: shouldForceAiVaultHost(args, hostInfo.executionHostId),
      signal
    })
  } catch (error) {
    if (signal?.aborted) {
      throw error
    }
    return sshScanIssueResult({
      executionHostId,
      targetId,
      message: error instanceof Error ? error.message : SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE
    })
  }
}

function sshScanIssueResult(args: {
  executionHostId: `ssh:${string}`
  targetId: string
  message: string
}): AiVaultListResult {
  return aiVaultScanIssueResult({
    executionHostId: args.executionHostId,
    path: args.targetId,
    message: args.message
  })
}

export function registerAiVaultHandlers(options: AiVaultHandlerOptions = {}): void {
  handlerOptions = options
  // Why: configure the SAME shared cache module the runtime RPC method uses so
  // there is exactly one cache instance and neither caller drops codex-home or
  // WSL injection. The runtime also configures these sources from its deps
  // (serve-mode reachable); this desktop path supplies the same source.
  configureAiVaultSessionSources(options)
  ipcMain.handle('aiVault:listSessions', (_event, args?: AiVaultListArgs) =>
    listAiVaultSessions(args)
  )
  registerAiVaultResumeHandler(options)
  ipcMain.handle('aiVault:listSubagentSessions', (_event, args) =>
    listAiVaultSubagentSessions(args)
  )
  // DOM focus/visibility events don't fire in the renderer on macOS app
  // activation, so refresh-on-refocus needs this main-process signal.
  app.on('browser-window-focus', (_event, window) => {
    if (!window.isDestroyed()) {
      window.webContents.send('aiVault:windowFocused')
    }
  })
}

function resetAiVaultCacheForTests(): void {
  resetAllAiVaultHostScansForTests()
  cachedList = null
  inflightList = null
  inflightKey = null
  handlerOptions = {}
  // The local leg delegates to the shared cache module; reset it too so tests
  // never see a scan cached by an earlier case.
  resetAiVaultSessionListCacheForTests()
  resetCachedRemoteAiVaultSessionsForTests()
}

export const _internals = {
  listAiVaultSessions,
  listAiVaultSubagentSessions,
  resetAiVaultCacheForTests
}
