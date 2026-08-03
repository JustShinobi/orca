// STA-3077 / #11729 regression guard.
//
// Scenario: an SSH relay dies abruptly (SIGTERM, no graceful UI disconnect --
// simulates a real network drop or relay crash) while 3 terminal panes are
// live, then the app reconnects. Docker-traced fact (see the project memory
// for the full run): on relay death, Orca's own auto-redeploy starts a FRESH
// relay process with a new pid and a RESET internal pty-id counter -- the
// remote shells the old leases point at are genuinely gone. This is NOT a
// "panes should be restored" scenario; no fix can bring back a destroyed
// shell, and asserting recovered pane count would be asserting something
// false by design.
//
// What IS in scope, and what this spec guards: `handlePtyReattachFailure`
// never runs for this path (traced: zero "Dropping stale PTY" / "Leaving PTY
// ... detached" / "Ignoring stale PTY" log lines across the whole run, loss
// completing ~27ms after ssh.connect() resolves), so nothing retires the old
// leases or scrubs their bindings. Two invariants should hold regardless:
//   1. leases minted before the relay died must end up non-restorable
//      (state 'expired'/'terminated', not 'attached'/'detached' --
//      'attached'/'detached' is exactly the reattachKnownPtys eligibility
//      filter, ssh-relay-session.ts:1852-1854).
//   2. no pane still visible after the app settles may display a ptyId bound
//      to one of those pre-drop leases. Because the fresh relay resets its
//      pty-id counter, a *new* legitimate pty can collide on the exact same
//      composite id (`ssh:<targetId>@@pty-1`) as the destroyed one -- so a
//      raw id match isn't proof of staleness. `createdAt` disambiguates: a
//      newly-minted lease gets a fresh `createdAt` after the redeploy, while
//      a stale binding is the literal pre-drop lease row, unmoved.
//
// Empirical hit rate (4 runs, see project-sta3077-ssh-pane-duplication
// memory): all 3 pre-drop SSH panes were lost every run (4/4). The specific
// leftover-stale-binding signature (a pre-drop ptyId still present in the
// pane manager after the 45s settle window) showed up in 3/4 runs; the 4th
// collapsed further (0 visible panes at all, stale ref gone too). Both
// outcomes satisfy invariant 2 as written (no *currently visible* pane may
// carry a stale binding) and this spec asserts invariant 1 unconditionally.
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { test, expect } from './helpers/orca-app'
import {
  connectDockerSshRelayTarget,
  reconnectDisconnectedDockerSshRelayTarget
} from './helpers/docker-ssh-relay-connection'
import {
  cleanupDockerSshRelayTarget,
  startDockerSshRelayTarget,
  type DockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'
import {
  readDockerSshRelayProcessSnapshot,
  terminateDockerSshRelay,
  isDockerSshRelayPidRunning
} from './helpers/docker-ssh-relay-processes'
import {
  readPersistedTerminalLayout,
  type PersistedTerminalLayout
} from './helpers/persisted-terminal-layout'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  countVisibleTerminalPanes,
  splitActiveTerminalPane,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForPaneCount
} from './helpers/terminal'

const RUN_DOCKER_SSH = process.env.ORCA_E2E_SSH_DOCKER === '1'
// Loss completes well under a second per the trace, but leave generous
// margin for the redeploy + app reconnect RPC chain to fully settle.
const SETTLE_SAMPLE_WINDOW_MS = 45_000
const SETTLE_SAMPLE_INTERVAL_MS = 2_000

type SshLease = {
  targetId: string
  ptyId: string
  tabId?: string
  leafId?: string
  state: 'attached' | 'detached' | 'terminated' | 'expired'
  createdAt: number
  updatedAt: number
}

test.describe('SSH relay redeploy: stale PTY bindings', () => {
  test.skip(!RUN_DOCKER_SSH, 'Set ORCA_E2E_SSH_DOCKER=1 to run Docker-backed SSH repro.')
  test.skip(process.platform === 'win32', 'Docker SSH repro uses POSIX SSH tooling.')

  test('leases from a destroyed relay generation are retired and no visible pane keeps their binding', async ({
    orcaPage,
    electronApp
  }, testInfo) => {
    test.setTimeout(360_000)
    let target: DockerSshRelayTarget | null = null
    try {
      target = startDockerSshRelayTarget(testInfo)
      await waitForSessionReady(orcaPage)
      await waitForActiveWorktree(orcaPage)
      const remote = await connectDockerSshRelayTarget(orcaPage, target, {
        relayGracePeriodSeconds: 300
      })
      await waitForActiveTerminalManager(orcaPage, 60_000)
      await waitForActivePanePtyId(orcaPage, 60_000)

      // Build out 3 panes in the single tab so we have multiple live remote PTYs.
      await splitActiveTerminalPane(orcaPage, 'vertical')
      await waitForPaneCount(orcaPage, 2, 30_000)
      await splitActiveTerminalPane(orcaPage, 'horizontal')
      await waitForPaneCount(orcaPage, 3, 30_000)

      const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
      // Why this path, not userDataDir/orca-data.json: the bare path is only
      // the fresh-install onboarding seed. The running app's live writes land
      // under the profile directory -- reading the bare path here previously
      // silently returned leasesAfter: null on every run.
      const dataFile = path.join(userDataDir, 'profiles', 'local-default', 'orca-data.json')
      const readLeases = (): SshLease[] => {
        const raw = JSON.parse(readFileSync(dataFile, 'utf8'))
        return (raw.sshRemotePtyLeases ?? []).filter(
          (l: { targetId: string }) => l.targetId === remote.targetId
        )
      }
      const readLayout = (tabId: string | undefined): PersistedTerminalLayout | null =>
        tabId === undefined ? null : readPersistedTerminalLayout(dataFile, tabId)
      const readPaneState = async (): Promise<{
        count: number
        ptyIds: (string | undefined)[]
      }> => {
        const count = await countVisibleTerminalPanes(orcaPage)
        const ptyIds = await orcaPage.evaluate(() => {
          const managers = Array.from(window.__paneManagers?.values() ?? [])
          return managers.flatMap((m) => m.getPanes?.().map((p) => p.container.dataset.ptyId) ?? [])
        })
        return { count, ptyIds }
      }

      const paneCountBefore = await countVisibleTerminalPanes(orcaPage)
      const leasesBefore = readLeases()
      const tabIdBefore = leasesBefore[0]?.tabId
      const layoutBefore = readLayout(tabIdBefore)
      // A missing layout would make the leaf-count guard below compare 0 <= 0 forever.
      expect(
        layoutBefore,
        'the tab must have a persisted layout in some workspace-session partition'
      ).not.toBeNull()
      const leafCountBefore = Object.keys(layoutBefore?.ptyIdsByLeafId ?? {}).length
      // Keyed by "targetId::ptyId" (relay form) -> createdAt, so a post-drop
      // lease can be told apart from a freshly-reminted one sharing the same id.
      const createdAtBeforeByLeaseKey = new Map(
        leasesBefore.map((l) => [`${l.targetId}::${l.ptyId}`, l.createdAt])
      )

      const beforeSnapshot = readDockerSshRelayProcessSnapshot(target)
      if (!beforeSnapshot) {
        throw new Error('No relay process group found before kill')
      }

      // Kill the relay WITHOUT a graceful UI disconnect first -- mimics a real
      // network drop / relay crash, not a user-initiated disconnect.
      terminateDockerSshRelay(target, beforeSnapshot)
      await expect
        .poll(() => isDockerSshRelayPidRunning(target!, beforeSnapshot.relayPid), {
          timeout: 30_000,
          message: 'relay did not exit after SIGTERM'
        })
        .toBe(false)

      // App-driven reconnect WITHOUT first calling disconnect (mirrors an
      // auto-reconnect / "resume connection" flow after detecting a drop).
      await reconnectDisconnectedDockerSshRelayTarget(orcaPage, remote.targetId)
      await waitForActiveTerminalManager(orcaPage, 60_000)

      // Sample repeatedly over a long window -- the relay reconnect backoff
      // sequence can take well past a few seconds to fully settle after an
      // abrupt drop.
      const timeline: { atMs: number; count: number; ptyIds: (string | undefined)[] }[] = []
      const start = Date.now()
      while (Date.now() - start < SETTLE_SAMPLE_WINDOW_MS) {
        const state = await readPaneState()
        timeline.push({ atMs: Date.now() - start, ...state })
        await orcaPage.waitForTimeout(SETTLE_SAMPLE_INTERVAL_MS)
      }

      await orcaPage.evaluate(() => window.api.session.flush())
      await orcaPage.waitForTimeout(500)

      const finalState = await readPaneState()
      const afterSnapshot = readDockerSshRelayProcessSnapshot(target)
      const leasesAfter = readLeases()
      const layoutAfter = readLayout(tabIdBefore)

      const evidence = {
        remoteTargetId: remote.targetId,
        paneCountBefore,
        leafCountBefore,
        leasesBefore,
        layoutBefore,
        beforeSnapshot,
        timeline,
        finalState,
        afterSnapshot,
        leasesAfter,
        layoutAfter
      }
      console.log(`[ssh-relay-redeploy-stale-pty-binding] ${JSON.stringify(evidence, null, 2)}`)
      testInfo.annotations.push({
        type: 'ssh-relay-redeploy-stale-pty-binding',
        description: JSON.stringify(evidence)
      })

      // Ground truth: SIGTERM + redeploy must actually produce a fresh relay
      // process. If this fails, the scenario didn't execute as designed.
      expect(afterSnapshot, 'relay must redeploy after SIGTERM').not.toBeNull()
      expect(
        afterSnapshot!.relayPid,
        'redeployed relay must be a different process, not a respawn of the same pid'
      ).not.toBe(beforeSnapshot.relayPid)

      // Invariant 1: every pre-drop lease that was never re-minted by the
      // fresh relay generation (same createdAt as before the kill) must be
      // non-restorable. 'attached'/'detached' is exactly the eligibility
      // filter reattachKnownPtys uses (ssh-relay-session.ts:1852-1854); a
      // lease left in either state after its relay generation is destroyed
      // stays forever eligible for a doomed reattach.
      const stillRestorableStaleLeases = leasesAfter.filter((lease) => {
        const key = `${lease.targetId}::${lease.ptyId}`
        const beforeCreatedAt = createdAtBeforeByLeaseKey.get(key)
        return (
          beforeCreatedAt !== undefined &&
          lease.createdAt === beforeCreatedAt &&
          (lease.state === 'attached' || lease.state === 'detached')
        )
      })
      expect(
        stillRestorableStaleLeases,
        'leases from the destroyed relay generation must be retired (expired/terminated), not left attached/detached'
      ).toEqual([])

      // Invariant 2: no currently-visible pane may display a ptyId bound to a
      // pre-drop (never-reminted) lease -- that binding points at a shell
      // that no longer exists.
      const visiblePtyIds = new Set(finalState.ptyIds.filter((id): id is string => Boolean(id)))
      const staleVisibleLeaseKeys = leasesAfter
        .filter((lease) => {
          const key = `${lease.targetId}::${lease.ptyId}`
          const beforeCreatedAt = createdAtBeforeByLeaseKey.get(key)
          return beforeCreatedAt !== undefined && lease.createdAt === beforeCreatedAt
        })
        .map((lease) => `ssh:${lease.targetId}@@${lease.ptyId}`)
        .filter((compositeId) => visiblePtyIds.has(compositeId))
      expect(
        staleVisibleLeaseKeys,
        'no visible pane may still display a binding minted before the relay was destroyed'
      ).toEqual([])

      // Durable layout guard: the leaf/pty binding table must not gain extra
      // leaves during this recovery path (that would be RC3's split-and-graft
      // signature -- it's the duplication defect, not this loss scenario, but
      // it's cheap to guard here too since the layout is captured either way).
      const leafCountAfter = Object.keys(layoutAfter?.ptyIdsByLeafId ?? {}).length
      expect(
        leafCountAfter,
        'reconnect after a relay redeploy must not graft additional leaves into the layout'
      ).toBeLessThanOrEqual(leafCountBefore)
    } finally {
      cleanupDockerSshRelayTarget(target)
    }
  })
})
