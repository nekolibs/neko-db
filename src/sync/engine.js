import { getDb } from './DbBridge'
import { clampPushCursors } from './cursors'
import { getPushes, getPulls } from './registry'
import { runPush } from './push'
import { runPull } from './pull'
import { syncLog } from './log'

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
async function runSide(db, defs, runner, side) {
  const results = {}
  const failed = new Set()

  for (const level of topoLevels(defs)) {
    await Promise.all(
      level.map(async (def) => {
        const opKey = `${side}:${def.id}`

        if (def.dependsOn.some((dep) => failed.has(dep))) {
          failed.add(def.id)
          results[def.id] = { id: def.id, skipped: true, reason: 'dependency failed' }
          setOpStatus(opKey, 'skipped')
          syncLog(opKey, 'skipped: dependency failed')
          return
        }

        setOpStatus(opKey, 'running')
        try {
          results[def.id] = await runner(db, def)
          setOpStatus(opKey, 'ok')
          syncLog(opKey, 'ok', results[def.id])
        } catch (error) {
          failed.add(def.id)
          results[def.id] = { id: def.id, error }
          setOpStatus(opKey, 'error')
          syncLog(opKey, 'error', error?.message || error)
          emitSyncError(error, { id: def.id, kind: side })
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
// ops: live per-operation state during a cycle, keyed 'push:<id>' / 'pull:<id>' →
// 'running' | 'ok' | 'error' | 'skipped'. Lets the UI show which op is syncing right now.
let status = { syncing: false, lastResult: null, lastError: null, lastSyncAt: null, ops: {} }

function setStatus(patch) {
  status = { ...status, ...patch }
  listeners.forEach((cb) => cb(status))
}

function setOpStatus(key, state) {
  setStatus({ ops: { ...status.ops, [key]: state } })
}

export function getSyncStatus() {
  return status
}

export function subscribeSyncStatus(cb) {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

// DB reset: status is module-level and survives every remount, so lastSyncAt would keep
// describing cycles that ran against the dropped data. Goes through setStatus so
// useSyncStatus subscribers re-render. Deliberately leaves `running` alone — that mutex
// guards an in-flight cycle and is not ours to clear.
export function resetSyncStatus() {
  setStatus({ syncing: false, lastResult: null, lastError: null, lastSyncAt: null, ops: {} })
}

// ============================================
// Error handler (optional — set by SyncProvider's onError prop)
// ============================================

// A single project-supplied reporter. Called once per failed operation with the live
// Error and { id, kind }, and once for a structural cycle failure (id/kind null).
let errorHandler = null

export function setSyncErrorHandler(fn) {
  errorHandler = fn ?? null
}

// A reporter must never break a sync cycle — swallow anything it throws.
function emitSyncError(error, info) {
  try {
    errorHandler?.(error, info)
  } catch (_) {
    // ignore
  }
}

// ============================================
// Lifecycle hooks (optional — set by SyncProvider's hooks prop)
// ============================================

// { before, after } — before runs ahead of cursor-clamp + pushes, after runs at
// the end of the success path. A project uses `before` to reconcile local state
// before anything is pushed (e.g. drop data the user just lost access to, so the
// doomed push never happens and never fires onError). Called on EVERY sync() —
// full cycle, push-only, and pull-only — so a hook must be cheap and idempotent.
let hooks = {}

export function setSyncHooks(next) {
  hooks = next ?? {}
}

// A hook must never break a cycle: report a throw and carry on (there is no
// block semantics). Reported so a genuinely broken hook is not silent.
async function runHook(name, payload) {
  const fn = hooks?.[name]
  if (!fn) return

  try {
    await fn(payload)
  } catch (error) {
    syncLog(`hook:${name}`, 'failed', error?.message || error)
    emitSyncError(error, { id: name, kind: 'hook' })
  }
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
    syncLog('cycle queued: already running')
    return null
  }

  if (cooldown > 0 && status.lastSyncAt && Date.now() - Date.parse(status.lastSyncAt) < cooldown * 1000) {
    syncLog('cycle skipped: cooldown')
    return { skipped: 'cooldown' }
  }

  running = true
  setStatus({ syncing: true, ops: {} })
  syncLog('cycle start', { pushIds: pushIds ?? 'all', pullIds: pullIds ?? 'all' })

  let result = null
  try {
    // Before anything is pushed — a hook may reconcile local state so a doomed
    // push never runs. Runs once per sync(), not per rerun iteration.
    await runHook('before', { db, pushIds, pullIds })

    do {
      rerunRequested = false
      await clampPushCursors(db)

      const pushes = await runSide(db, pickDefs(getPushes(), pushIds), runPush, 'push')
      const pulls = await runSide(db, pickDefs(getPulls(), pullIds), runPull, 'pull')

      result = { pushes, pulls }
    } while (rerunRequested)

    const hasError = [...Object.values(result.pushes), ...Object.values(result.pulls)].some((r) => r.error)
    setStatus({ lastResult: result, lastError: hasError ? result : null, lastSyncAt: new Date().toISOString() })
    syncLog('cycle end', hasError ? 'with errors' : 'ok')

    await runHook('after', { db, result, pushIds, pullIds })
    return result
  } catch (error) {
    // Structural failure outside the per-op guard (clamp / topo cycle / unknown def).
    // Report it and resolve null rather than rejecting — triggers call sync() fire-and-forget.
    syncLog('cycle failed (structural)', error?.message || error)
    emitSyncError(error, { id: null, kind: null })
    setStatus({ lastSyncAt: new Date().toISOString() })
    return null
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
