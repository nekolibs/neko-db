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
}
