// Declaration classes — same ergonomics as `new Model(name, opts)`.
// Every step is FREE logic and EXPLICIT — there are no default behaviors.
//
// new Pull('pets', {
//   dependsOn: [],
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
//   collect: async ({ db, cursor }) => records,
//     // Read whatever you want from SQLite with the query builder, e.g.
//     // PetModel.query().whereDirty(cursor).all(db) — preloads, joins, anything.
//     // Return null = nothing to push.
//   push: async ({ records, db }) => {},
//     // Shape (cleanRequest) and send to the API however you want.
// })

export class Pull {
  constructor(id, { dependsOn = [], model, models, pull, store }) {
    if (!pull) throw new Error(`[sync] Pull "${id}": pull() is required`)
    if (!store) throw new Error(`[sync] Pull "${id}": store() is required`)

    this.id = id
    this.dependsOn = dependsOn
    this.models = models ?? (model ? [model] : [])
    this.pull = pull
    this.store = store
  }
}

export class Push {
  constructor(id, { dependsOn = [], model, models, collect, push }) {
    if (!collect) throw new Error(`[sync] Push "${id}": collect() is required`)
    if (!push) throw new Error(`[sync] Push "${id}": push() is required`)

    this.id = id
    this.dependsOn = dependsOn
    this.models = models ?? (model ? [model] : [])
    this.collect = collect
    this.push = push
  }
}
