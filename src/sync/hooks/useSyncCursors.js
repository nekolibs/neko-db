import { useSQLiteContext } from 'expo-sqlite'
import { useCallback, useEffect, useState } from 'react'

import { getCursorRows } from '../cursors'
import { getPulls, getPushes } from '../registry'
import { useSyncStatus } from './useSyncStatus'

// UI-agnostic status enum from a persisted cursor row (labels/colors stay in the view).
function deriveStatus(row) {
  if (row?.errorCount > 0 && row.lastError) return 'error'
  if (row?.lastRunAt || row?.lastSuccessAt) return 'ok'
  return 'idle'
}

// Merge the registered defs with the persisted _sync_cursors rows so every operation
// shows up — including ones that have never run yet (no cursor row). Each row is fully
// derived (status + display timestamp) so consumers don't reimplement the rules.
function buildRows(cursorRows) {
  const byId = {}
  cursorRows.forEach((row) => {
    byId[row.id] = row
  })

  const rows = []
  const collect = (kind, defs) => {
    Object.entries(defs).forEach(([id, def]) => {
      const row = byId[`${kind}:${id}`]
      rows.push({
        key: `${kind}:${id}`,
        kind,
        id,
        models: def?.models ?? [],
        status: deriveStatus(row),
        at: row?.lastRunAt ?? row?.lastSuccessAt ?? null,
        lastError: row?.lastError ?? null,
        errorCount: row?.errorCount ?? 0,
      })
    })
  }
  collect('push', getPushes())
  collect('pull', getPulls())
  return rows
}

// Reactive-ish view over the persisted per-operation sync status. There is no emitter on
// _sync_cursors, so we re-read it whenever a sync cycle finishes (syncing flips / lastSyncAt
// changes) — that's the only moment the rows can change.
export function useSyncCursors() {
  const db = useSQLiteContext()
  const { syncing, lastSyncAt, ops } = useSyncStatus()
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)

  const refetch = useCallback(() => {
    if (!db) return Promise.resolve()
    return getCursorRows(db).then((cursorRows) => {
      setRows(buildRows(cursorRows ?? []))
      setLoading(false)
    })
  }, [db])

  useEffect(() => {
    refetch()
  }, [refetch, syncing, lastSyncAt])

  // rows carry durable status (re-read after each cycle); overlay the live per-op state
  // (running right now) so each row is self-contained — no parallel ops map to thread.
  const liveRows = rows.map((row) => ({ ...row, running: ops?.[row.key] === 'running' }))

  return { rows: liveRows, loading, syncing, refetch }
}
