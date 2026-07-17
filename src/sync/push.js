import { syncNow } from './clock'
import { getCursor, markRun, setCursor, setCursorError } from './cursors'
import { assertNoErrors } from './results'

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

  // Everything the def touches — collect (SQLite read), push (transport), and any
  // bookkeeping write inside push — runs under one try. ANY error records it on
  // the cursor (lastError) and leaves the cursor un-advanced, so rows stay dirty
  // and retry. Nothing is ever silently marked clean.
  try {
    const records = await def.collect({ db, cursor })

    // Nothing to push: null/undefined or an empty array — no API call, no cursor
    // move. Still a successful run, so record it (lastRunAt) without advancing.
    if (records == null || (Array.isArray(records) && records.length === 0)) {
      await markRun(db, cursorId)
      return { id: def.id, pushed: 0, skippedApi: true }
    }
    const total = Array.isArray(records) ? records.length : 1

    // A returned transport result carrying { errors } throws here — the cursor
    // is NOT advanced, so the rows stay dirty and retry (no silent data loss).
    const result = await def.push({ records, db, cursor })
    assertNoErrors(result, def.id)

    await setCursor(db, cursorId, start)
    return { id: def.id, pushed: total }
  } catch (error) {
    await setCursorError(db, cursorId, error)
    throw error
  }
}
