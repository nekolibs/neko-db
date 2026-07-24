export class ModelEmitter {
  constructor() {
    this._listeners = new Map()
  }

  subscribe(modelName, callback) {
    if (!this._listeners.has(modelName)) {
      this._listeners.set(modelName, new Set())
    }
    const set = this._listeners.get(modelName)
    set.add(callback)
    return () => set.delete(callback)
  }

  emit(modelName) {
    const set = this._listeners.get(modelName)
    if (!set) return
    for (const cb of set) cb()
  }

  // Wake every live query at once, for a full DB reset. Per-model emit can't cover it:
  // after a wipe every model is stale, including ones with no pending mutation.
  emitAll() {
    for (const set of this._listeners.values()) {
      for (const cb of set) cb()
    }
  }
}
