import { getDb } from './DbBridge'
import { clampPushCursors } from './cursors'
import { getPushes, getPulls } from './registry'
import { runPush } from './push'
import { runPull } from './pull'

// ============================================
// Dependency ordering
// ============================================

// Kahn layering: defs whose deps are all resolved run together (in parallel).
function topoLevels(defs) {
  for (const def of Object.values(defs)) {
    for (const dep of def.dependsOn) {
      if (!defs[dep]) throw new Error(`[sync] "${def.id}" dependsOn unknown def "${dep}"`)
    }
  }

  const remaining = new Set(Object.keys(defs))
  const levels = []

  while (remaining.size > 0) {
    const level = [...remaining].filter((id) => defs[id].dependsOn.every((dep) => !remaining.has(dep)))
    if (level.length === 0) throw new Error(`[sync] dependency cycle among: ${[...remaining].join(', ')}`)
    level.forEach((id) => remaining.delete(id))
    levels.push(level.map((id) => defs[id]))
  }

  return levels
}

// Failure propagation: a failed def skips its whole downstream subtree for this
// run (e.g. filesPush fails → eventsPush must not send events referencing files
// the server never received). The subtree retries together next cycle.
async function runSide(db, defs, runner) {
  const results = {}
  const failed = new Set()

  for (const level of topoLevels(defs)) {
    await Promise.all(
      level.map(async (def) => {
        if (def.dependsOn.some((dep) => failed.has(dep))) {
          failed.add(def.id)
          results[def.id] = { id: def.id, skipped: true, reason: 'dependency failed' }
          return
        }

        try {
          results[def.id] = await runner(db, def)
        } catch (error) {
          failed.add(def.id)
          results[def.id] = { id: def.id, error }
        }
      })
    )
  }

  return results
}

// ids: undefined/null = all defs; [] = none (push()/pull() disable the other side).
function pickDefs(defs, ids) {
  if (ids == null) return defs
  const picked = {}
  ids.forEach((id) => {
    if (!defs[id]) throw new Error(`[sync] unknown def "${id}"`)
    // Deps outside the picked subset are treated as satisfied.
    picked[id] = { ...defs[id], dependsOn: defs[id].dependsOn.filter((dep) => ids.includes(dep)) }
  })
  return picked
}

// ============================================
// Status (consumed by useSyncStatus in the React layer)
// ============================================

const listeners = new Set()
let status = { syncing: false, lastResult: null, lastError: null, lastSyncAt: null }

function setStatus(patch) {
  status = { ...status, ...patch }
  listeners.forEach((cb) => cb(status))
}

export function getSyncStatus() {
  return status
}

export function subscribeSyncStatus(cb) {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

// ============================================
// Runs
// ============================================

let running = false
let rerunRequested = false

export function isSyncing() {
  return running
}

// Full cycle: clamp cursors → pushes (topo) → pulls (topo).
// Pulls ALWAYS run even when pushes failed — dirty-skip protects unpushed rows,
// and gating pulls would let one poison row starve the app of updates.
// Mutex: one run at a time; a trigger during a run queues exactly one rerun.
// cooldown (seconds): skip when the last cycle finished less than that ago —
// scheduling triggers pass it; manual calls default to 0 and always run.
export async function sync({ db = getDb(), pushIds, pullIds, cooldown = 0 } = {}) {
  if (!db) return null

  if (running) {
    rerunRequested = true
    return null
  }

  if (cooldown > 0 && status.lastSyncAt && Date.now() - Date.parse(status.lastSyncAt) < cooldown * 1000) {
    return { skipped: 'cooldown' }
  }

  running = true
  setStatus({ syncing: true })

  let result = null
  try {
    do {
      rerunRequested = false
      await clampPushCursors(db)

      const pushes = await runSide(db, pickDefs(getPushes(), pushIds), runPush)
      const pulls = await runSide(db, pickDefs(getPulls(), pullIds), runPull)

      result = { pushes, pulls }
    } while (rerunRequested)

    const hasError = [...Object.values(result.pushes), ...Object.values(result.pulls)].some((r) => r.error)
    setStatus({ lastResult: result, lastError: hasError ? result : null, lastSyncAt: new Date().toISOString() })
    return result
  } finally {
    running = false
    setStatus({ syncing: false })
  }
}

export function push({ ids, db } = {}) {
  return sync({ db, pushIds: ids ?? null, pullIds: [] })
}

export function pull({ ids, db } = {}) {
  return sync({ db, pushIds: [], pullIds: ids ?? null })
}
