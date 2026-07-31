import { describe, expect, it } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'

describe('headless dispatch lifecycle reconciliation', () => {
  it('preserves pending and terminal states while selecting only stale dispatched rows', () => {
    const db = new OrchestrationDb(':memory:')
    try {
      const pending = db.createStartingWorkerDispatch({
        taskId: db.createTask({ spec: 'pending' }).id,
        startOptions: { agent: 'codex' }
      }).dispatch
      expect(pending.status).toBe('pending')

      const completed = db.createDispatchContext(
        db.createTask({ spec: 'completed' }).id,
        'term_completed'
      )
      db.completeDispatch(completed.id)

      const failed = db.createDispatchContext(db.createTask({ spec: 'failed' }).id, 'term_failed')
      expect(db.failDispatch(failed.id, 'launch timeout')?.status).toBe('failed')

      const circuitTask = db.createTask({ spec: 'circuit broken' })
      for (const handle of ['term_circuit_1', 'term_circuit_2', 'term_circuit_3']) {
        const dispatch = db.createDispatchContext(circuitTask.id, handle)
        const failedDispatch = db.failDispatch(dispatch.id, 'launch timeout')
        if (handle.endsWith('_3')) {
          expect(failedDispatch?.status).toBe('circuit_broken')
        }
      }

      const stale = db.createDispatchContext(db.createTask({ spec: 'stale' }).id, 'term_stale')
      const sqlite = (db as unknown as { db: Database.Database }).db
      sqlite
        .prepare('UPDATE dispatch_contexts SET dispatched_at = ? WHERE id = ?')
        .run('2026-07-12 10:00:00', stale.id)

      expect(db.getStaleDispatches('2026-07-12T11:55:00.000Z').map((row) => row.id)).toEqual([
        stale.id
      ])
      expect(db.getDispatchContextById(pending.id)?.status).toBe('pending')
      expect(db.getDispatchContextById(completed.id)?.status).toBe('completed')
      expect(db.getDispatchContextById(failed.id)?.status).toBe('failed')
      expect(db.getDispatchContext(circuitTask.id)?.status).toBe('circuit_broken')
    } finally {
      db.close()
    }
  })
})
