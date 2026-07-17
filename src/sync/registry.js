// Push/pull definition registries — mirror the model registry pattern (models.js).
//
// Push def: { id, dependsOn = [], models = [...], push: async ({ rowsByModel, db }) }
// Pull def: { id, dependsOn = [], models = [...], pull: async ({ cursor, db }) => ({ rowsByModel, cursor, full }), store? }

const pushes = {}
const pulls = {}

// Replace semantics (not merge): registration happens once at app startup, and
// on a Metro hot reload the fresh call must not resurrect removed defs.
function replaceAll(registry, defs) {
  Object.keys(registry).forEach((key) => delete registry[key])
  defs.forEach((def) => {
    registry[def.id] = { dependsOn: [], models: [], ...def }
  })
  return registry
}

export function registerPushes(defs) {
  return replaceAll(pushes, defs)
}

export function registerPulls(defs) {
  return replaceAll(pulls, defs)
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
