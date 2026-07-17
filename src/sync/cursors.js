import { syncNow } from './clock'

// Lib-owned cursor storage. Created in NekoDB onInit (idempotent) — it can't be
// a numbered app migration because PRAGMA user_version is app-owned.
// resetDatabase drops it too → automatic full resync.
export async function ensureCursorsTable(db) {
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS _sync_cursors (
      id TEXT PRIMARY KEY,
      cursor TEXT,
      lastSuccessAt TEXT,
      lastError TEXT,
      errorCount INTEGER NOT NULL DEFAULT 0
    );
  `)
}

export async function getCursor(db, id) {
  const row = await db.getFirstAsync('SELECT cursor FROM _sync_cursors WHERE id = ?', id)
  return row?.cursor ?? null
}

export async function setCursor(db, id, cursor) {
  await db.runAsync(
    `INSERT INTO _sync_cursors (id, cursor, lastSuccessAt, lastError, errorCount)
     VALUES (?, ?, ?, NULL, 0)
     ON CONFLICT (id) DO UPDATE SET
       cursor = excluded.cursor,
       lastSuccessAt = excluded.lastSuccessAt,
       lastError = NULL,
       errorCount = 0`,
    id,
    cursor == null ? null : String(cursor),
    new Date().toISOString()
  )
}

export async function setCursorError(db, id, error) {
  await db.runAsync(
    `INSERT INTO _sync_cursors (id, cursor, lastError, errorCount)
     VALUES (?, NULL, ?, 1)
     ON CONFLICT (id) DO UPDATE SET
       lastError = excluded.lastError,
       errorCount = _sync_cursors.errorCount + 1`,
    id,
    String(error?.message || error)
  )
}

export async function getCursorRows(db) {
  return db.getAllAsync('SELECT * FROM _sync_cursors ORDER BY id')
}

// Heal closed-app backward clock jumps: a push cursor "in the future" would hide
// dirty rows forever. Pull it back to now - 1s; worst case some clean rows are
// re-flagged dirty and re-pushed (idempotent, LWW absorbs it).
// Pull cursors are server-issued versions — device clock never touches them.
export async function clampPushCursors(db) {
  const now = syncNow()
  const safe = new Date(Date.parse(now) - 1000).toISOString()
  await db.runAsync("UPDATE _sync_cursors SET cursor = ? WHERE id LIKE 'push:%' AND cursor > ?", safe, now)
}
