// Push/pull definition registries — mirror the model registry pattern (models.js).
//
// Push def: { id, dependsOn = [], models = [...], push: async ({ rowsByModel, db }) }
// Pull def: { id, dependsOn = [], models = [...], pull: async ({ cursor, db }) => ({ rowsByModel, cursor, full }), store? }

const pushes = {}
const pulls = {}

// Replace semantics (not merge): registration happens once at app startup, and
// on a Metro hot reload the fresh call must not resurrect removed defs.
function replaceAll(registry, defs, base) {
  Object.keys(registry).forEach((key) => delete registry[key])
  defs.forEach((def) => {
    registry[def.id] = { ...base, ...def }
  })
  return registry
}

export function registerPushes(defs) {
  return replaceAll(pushes, defs, { dependsOn: [], models: [], autoPush: true })
}

export function registerPulls(defs) {
  return replaceAll(pulls, defs, { dependsOn: [], models: [] })
}

export function pushDefsForModel(modelName) {
  return Object.values(pushes).filter((def) => def.models.includes(modelName))
}

export function getPush(id) {
  return pushes[id]
}

export function getPull(id) {
  return pulls[id]
}

export function getPushes() {
  return pushes
}

export function getPulls() {
  return pulls
}
