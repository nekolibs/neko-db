import { getModel } from '../models'
import { Query } from '../query'
import { getCursor, setCursor, setCursorError } from './cursors'
import { getPushes } from './registry'

// Runaway backstop — a sane server never comes close.
const MAX_PAGES = 1000

function pushCursorIdForModel(modelName) {
  for (const def of Object.values(getPushes())) {
    if (def.models.includes(modelName)) return `push:${def.id}`
  }
  return null
}

// Dirty = has an unpushed local change (same predicate as whereDirty in collects).
// Evaluated at STORE time — push-before-pull ordering only shrinks the window;
// this check is the correctness mechanism (see SYNC_PLAN.md).
async function dirtyIdSet(db, model) {
  const cursorId = pushCursorIdForModel(model.name)
  const cursor = cursorId ? await getCursor(db, cursorId) : null

  const rows = await model.query().select('id').whereDirty(cursor).all(db)
  return new Set(rows.map((r) => r.id))
}

// API rows carry keys the table doesn't have (__typename, nested relations).
// storeRows keeps only real table columns — read once per table, per db handle.
const columnsCache = new WeakMap()

async function tableColumns(db, table) {
  let tables = columnsCache.get(db)
  if (!tables) {
    tables = new Map()
    columnsCache.set(db, tables)
  }

  if (!tables.has(table)) {
    const info = await db.getAllAsync(`PRAGMA table_info(${table})`)
    tables.set(table, new Set(info.map((column) => column.name)))
  }

  return tables.get(table)
}

// The safe upsert primitive — dirty-skip + clean marker + fromSync. Exposed to
// custom store() overrides so free-form storage keeps the correctness rules:
// skip locally-dirty rows (their unpushed edit wins locally, next push decides
// on the server, the echo applies the outcome), land rows clean.
export async function storeRows(db, modelName, rows) {
  const model = getModel(modelName)
  if (!model) throw new Error(`[sync] storeRows: unknown model "${modelName}"`)
  if (!rows?.length) return { stored: 0, skipped: 0 }

  const columns = await tableColumns(db, model.name)
  const dirty = await dirtyIdSet(db, model)

  // Keep only real table columns (API rows carry __typename, nested relations).
  // localUpdatedAt is NOT set here — fromSync tells the write path to skip
  // stamping, so a new row stays null and an existing row keeps its real stamp;
  // clean-ness is the push cursor's job, never a wipe of the timestamp.
  const clean = rows
    .filter((row) => !dirty.has(row.id))
    .map((row) => {
      const picked = {}
      for (const key of Object.keys(row)) {
        if (columns.has(key) && key !== 'localUpdatedAt') picked[key] = row[key]
      }
      return picked
    })

  if (clean.length) {
    await model.insertMany(db, clean, { onConflict: { target: 'id', update: 'all' }, fromSync: true })
  }

  return { stored: clean.length, skipped: rows.length - clean.length }
}

async function storePage(db, def, result) {
  // The def's store owns how the API result lands in SQLite — full freedom.
  // Receives the raw pull() result plus the safe primitives.
  if (!def.store) throw new Error(`[sync] pull "${def.id}": store() is required`)

  const counts = await def.store({
    db,
    result,
    storeRows: (modelName, rows) => storeRows(db, modelName, rows),
    dirtyIds: async (modelName) => dirtyIdSet(db, getModel(modelName)),
  })

  return { stored: counts?.stored ?? 0, skipped: counts?.skipped ?? 0 }
}

// Pull algorithm (see SYNC_PLAN.md): cursor is an opaque string the def
// interprets (server syncVersion). Each page commits atomically WITH its cursor
// advance — a crash mid-pull resumes from the last stored page.
export async function runPull(db, def) {
  const cursorId = `pull:${def.id}`
  let cursor = await getCursor(db, cursorId)

  let pages = 0
  let stored = 0
  let skipped = 0

  try {
    while (pages < MAX_PAGES) {
      const result = await def.pull({ cursor, db })
      if (!result) break

      const { cursor: nextCursor, full } = result
      const advanced = nextCursor != null && String(nextCursor) !== String(cursor ?? '')

      const counts = await Query.transaction(db, async () => {
        const pageCounts = await storePage(db, def, result)
        if (advanced) await setCursor(db, cursorId, nextCursor)
        return pageCounts
      })

      stored += counts.stored
      skipped += counts.skipped
      pages += 1

      // Stall guard: a "full" page that didn't advance the cursor would loop forever.
      if (!full || !advanced) break
      cursor = String(nextCursor)
    }
  } catch (error) {
    await setCursorError(db, cursorId, error)
    throw error
  }

  return { id: def.id, pages, stored, skipped }
}
