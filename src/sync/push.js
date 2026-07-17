import { syncNow } from './clock'
import { getCursor, setCursor, setCursorError } from './cursors'

// Push algorithm (see SYNC_PLAN.md):
//   cursor = push START time on success — an edit landing while the request is
//   in flight keeps localUpdatedAt > cursor and stays dirty for the next run.
//   On failure nothing changes; crash-safe by construction.
export async function runPush(db, def) {
  const cursorId = `push:${def.id}`
  const start = syncNow()
  const cursor = await getCursor(db, cursorId)

  // The def's collect owns what gets read from SQLite — full freedom, plain
  // query builder: Model.query().whereDirty(cursor).all(db) (+ any preloads).
  // Returning null/undefined = nothing to push.
  if (!def.collect) throw new Error(`[sync] push "${def.id}": collect() is required`)

  const records = await def.collect({ db, cursor })

  // Nothing to push: null/undefined or an empty array — no API call, no cursor move.
  if (records == null || (Array.isArray(records) && records.length === 0)) {
    return { id: def.id, pushed: 0, skippedApi: true }
  }
  const total = Array.isArray(records) ? records.length : 1

  try {
    await def.push({ records, db, cursor })
  } catch (error) {
    await setCursorError(db, cursorId, error)
    throw error
  }

  await setCursor(db, cursorId, start)
  return { id: def.id, pushed: total }
}
