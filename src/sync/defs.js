// Declaration classes — same ergonomics as `new Model(name, opts)`.
// Every step is FREE logic and EXPLICIT — there are no default behaviors.
//
// new Pull('pets', {
//   dependsOn: [],
//   enabled: async ({ db }) => true,   // optional gate — see below
//   pull: async ({ cursor, db }) => result,
//     // Call the API however you want. Return { cursor, full, ...anything }.
//     // cursor/full drive the engine's pagination loop.
//   store: async ({ db, result, storeRows, dirtyIds }) => {},
//     // Save the result to SQLite however you want (any tables, any shape).
//     // storeRows(model, rows) is offered: upserts with the dirty-skip rule
//     // (never overwrite a row that has unpushed local edits) and marks rows clean.
// })
//
// new Push('pets', {
//   dependsOn: [],
//   model: 'pet',              // declares which model's pending state this push owns
//                              // (pull-side dirty checks resolve their cursor through it)
//   enabled: async ({ db }) => true,   // optional gate — see below
//   collect: async ({ db, cursor }) => records,
//     // Read whatever you want from SQLite with the query builder, e.g.
//     // PetModel.query().whereDirty(cursor).all(db) — preloads, joins, anything.
//     // Return null = nothing to push.
//   push: async ({ records, db }) => {},
//     // Shape (cleanRequest) and send to the API however you want.
// })
//
// enabled: an OPTIONAL predicate ({ db }) => boolean (sync or async). When it
// returns false the def is skipped for that cycle BEFORE collect()/pull() runs,
// and the cursor is NOT advanced (recorded via markRun) — so a push's dirty rows
// stay dirty and a pull resumes from the same server cursor once it re-enables.
// Use it to declare run conditions per def, e.g. `enabled: () => !!getSession()?.user?.id`
// on a push that must only upload while logged in. Omit it to always run.

export class Pull {
  constructor(id, { dependsOn = [], model, models, enabled, pull, store }) {
    if (!pull) throw new Error(`[sync] Pull "${id}": pull() is required`)
    if (!store) throw new Error(`[sync] Pull "${id}": store() is required`)

    this.id = id
    this.dependsOn = dependsOn
    this.models = models ?? (model ? [model] : [])
    this.enabled = enabled
    this.pull = pull
    this.store = store
  }
}

export class Push {
  constructor(id, { dependsOn = [], model, models, enabled, collect, push, autoPush = true, debounce }) {
    if (!collect) throw new Error(`[sync] Push "${id}": collect() is required`)
    if (!push) throw new Error(`[sync] Push "${id}": push() is required`)

    this.id = id
    this.dependsOn = dependsOn
    this.models = models ?? (model ? [model] : [])
    this.enabled = enabled
    this.collect = collect
    this.push = push
    this.autoPush = autoPush
    this.debounce = debounce
  }
}
