import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page, TestInfo } from '@stablyai/playwright-test'
import { RuntimeClient } from '../../src/cli/runtime/client'
import { decodePairingOffer, encodePairingOffer } from '../../src/shared/pairing'
import { expect, test } from './helpers/orca-app'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import {
  launchPairedElectronClient,
  type RuntimeDesktopPairingOffer
} from './helpers/paired-electron-client'
import { createZombieRuntimeRelay } from './helpers/zombie-runtime-relay'

function createGitRepo(): string {
  const repoPath = mkdtempSync(path.join(os.tmpdir(), 'orca-pr10235-repo-'))
  execFileSync('git', ['init'], { cwd: repoPath, stdio: 'ignore' })
  writeFileSync(path.join(repoPath, 'README.md'), '# PR 10235 relay oracle\n')
  execFileSync('git', ['add', 'README.md'], { cwd: repoPath, stdio: 'ignore' })
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Orca E2E',
      '-c',
      'user.email=orca-e2e@example.invalid',
      'commit',
      '-m',
      'seed'
    ],
    { cwd: repoPath, stdio: 'ignore' }
  )
  return repoPath
}

function withRelayEndpoint(
  offer: RuntimeDesktopPairingOffer,
  endpoint: string
): RuntimeDesktopPairingOffer {
  return {
    pairingUrl: encodePairingOffer({ ...decodePairingOffer(offer.pairingUrl), endpoint })
  }
}

async function readWorktreeSurface(
  page: Page,
  repoPath: string,
  environmentId: string
): Promise<{ rendered: boolean; worktreeId: string | null }> {
  return page.evaluate(
    ({ environmentId, repoName, repoPath }) => {
      const worktree = window.__store
        ?.getState()
        .allWorktrees()
        .find(
          (candidate) =>
            candidate.hostId === `runtime:${environmentId}` &&
            (candidate.id.endsWith(`::${repoPath}`) ||
              candidate.id.split(/[\\/]/).at(-1) === repoName)
        )
      const worktreeId = worktree?.id ?? null
      const rendered = Array.from(document.querySelectorAll('[data-worktree-id]')).some(
        (element) => element.getAttribute('data-worktree-id') === worktreeId
      )
      return { rendered, worktreeId }
    },
    { environmentId, repoName: path.basename(repoPath), repoPath }
  )
}

async function runStaleSubscriptionOracle(args: {
  host: RuntimeClient
  initialRepoPath: string
  offer: RuntimeDesktopPairingOffer
  testInfo: TestInfo
  topology: 'headed' | 'headless'
}): Promise<void> {
  const targetOffer = decodePairingOffer(args.offer.pairingUrl)
  const relay = await createZombieRuntimeRelay(targetOffer.endpoint)
  const client = await launchPairedElectronClient(
    withRelayEndpoint(args.offer, relay.endpoint),
    args.testInfo,
    `PR 10235 ${args.topology}`
  ).catch(async (error) => {
    await relay.close()
    throw error
  })
  const addedRepoPath = createGitRepo()

  try {
    await client.page.evaluate(async (environmentId) => {
      const store = window.__store
      if (!store) {
        throw new Error('Paired desktop store is unavailable')
      }
      await store.getState().fetchRepos({ runtimeEnvironmentId: environmentId })
    }, client.environmentId)
    await expect
      .poll(() => readWorktreeSurface(client.page, args.initialRepoPath, client.environmentId), {
        timeout: 30_000
      })
      .toMatchObject({ rendered: true, worktreeId: expect.any(String) })
    await expect
      .poll(() => relay.evidence().activeConnectionCount, { timeout: 10_000 })
      .toBeGreaterThan(0)

    const connectionCountBeforeFault = relay.evidence().connectionCount
    await relay.zombifyActiveSessions()
    const added = await args.host.call<{ repo: { id: string } }>('repo.add', {
      path: addedRepoPath,
      kind: 'git'
    })
    await args.host.call('repo.update', {
      repo: added.result.repo.id,
      updates: { externalWorktreeVisibility: 'show' }
    })
    await expect
      .poll(
        async () => {
          const result = await args.host.call<{ totalCount: number }>('worktree.list', {
            repo: `id:${added.result.repo.id}`
          })
          return result.result.totalCount
        },
        { timeout: 30_000 }
      )
      .toBeGreaterThan(0)
    await expect
      .poll(() => readWorktreeSurface(client.page, addedRepoPath, client.environmentId), {
        timeout: 2_000
      })
      .toEqual({ rendered: false, worktreeId: null })

    try {
      await expect
        .poll(() => readWorktreeSurface(client.page, addedRepoPath, client.environmentId), {
          timeout: 40_000
        })
        .toMatchObject({ rendered: true, worktreeId: expect.any(String) })
    } catch (error) {
      const staleEvidence = relay.evidence()
      await client.page.screenshot({
        path: args.testInfo.outputPath(`${args.topology}-stale-before-reload.png`),
        fullPage: true
      })
      throw new Error(
        `${args.topology} subscription stayed stale behind a control-responsive relay: ${JSON.stringify(staleEvidence)}`,
        { cause: error }
      )
    }

    const evidence = relay.evidence()
    expect(evidence.controlPingCount).toBeGreaterThan(0)
    expect(evidence.connectionCount).toBeGreaterThan(connectionCountBeforeFault)
    await client.page.screenshot({
      path: args.testInfo.outputPath(`${args.topology}-self-healed.png`),
      fullPage: true
    })
    console.info(`[pr10235] ${JSON.stringify({ topology: args.topology, ...evidence })}`)
  } finally {
    await client.dispose()
    await relay.close()
    rmSync(addedRepoPath, { recursive: true, force: true })
  }
}

test('self-heals a headed server worktree subscription behind a zombie relay @headful', async ({
  electronApp,
  orcaPage,
  testRepoPath
}, testInfo) => {
  test.setTimeout(150_000)
  expect(
    await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some((window) => window.isVisible())
    )
  ).toBe(true)
  const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  const offer = await orcaPage.evaluate(async () => {
    const result = await window.api.mobile.getRuntimePairingUrl({
      address: '127.0.0.1',
      rotate: true
    })
    if (!result.available || !result.pairingUrl) {
      throw new Error('Headed runtime did not publish a pairing offer')
    }
    return { pairingUrl: result.pairingUrl }
  })
  await runStaleSubscriptionOracle({
    host: new RuntimeClient(userDataDir),
    initialRepoPath: testRepoPath,
    offer,
    testInfo,
    topology: 'headed'
  })
})

test('self-heals a headless serve worktree subscription behind a zombie relay', async ({
  testRepoPath: _testRepoPath
}, testInfo) => {
  test.setTimeout(150_000)
  const initialRepoPath = createGitRepo()
  const host = await launchHeadlessPairedRuntimeHost().catch((error) => {
    rmSync(initialRepoPath, { recursive: true, force: true })
    throw error
  })
  try {
    const added = await host.client.call<{ repo: { id: string } }>('repo.add', {
      path: initialRepoPath,
      kind: 'git'
    })
    await host.client.call('repo.update', {
      repo: added.result.repo.id,
      updates: { externalWorktreeVisibility: 'show' }
    })
    await runStaleSubscriptionOracle({
      host: host.client,
      initialRepoPath,
      offer: host.offer,
      testInfo,
      topology: 'headless'
    })
  } finally {
    await host.dispose()
    rmSync(initialRepoPath, { recursive: true, force: true })
  }
})
