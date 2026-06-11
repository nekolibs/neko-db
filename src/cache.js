import dayjs from 'dayjs'
import { getModel } from './models'

export class NormalizedCache {
  constructor() {
    this.entities = {}
    this.queries = {}
  }

  _entityKey(modelName, id) {
    return `${modelName}:${id}`
  }

  readEntity(modelName, id) {
    return this.entities[this._entityKey(modelName, id)] ?? null
  }

  writeEntity(modelName, id, data) {
    this.entities[this._entityKey(modelName, id)] = { ...data }
  }

  deleteEntity(modelName, id) {
    delete this.entities[this._entityKey(modelName, id)]
  }

  normalize(modelName, rows) {
    const model = getModel(modelName)
    if (!model) return

    const list = Array.isArray(rows) ? rows : [rows]
    for (const row of list) {
      if (!row?.id) continue
      this._normalizeEntity(model, modelName, row)
    }
  }

  _normalizeEntity(model, modelName, row) {
    const entity = {}
    for (const [key, value] of Object.entries(row)) {
      const field = model.fields[key]
      if (field && ['belongsTo', 'hasMany', 'hasOne'].includes(field.type)) {
        const relModel = field.withModel
        // belongsTo is rebuilt from the FK on denormalize; hasMany/hasOne have
        // no FK on this side, so store entity refs to reattach them later.
        if (field.type === 'belongsTo' && value && typeof value === 'object') {
          if (value.id) {
            this._normalizeEntity(getModel(relModel), relModel, value)
          }
        } else if (field.type === 'hasMany' && Array.isArray(value)) {
          const refs = []
          for (const child of value) {
            if (child?.id) {
              this._normalizeEntity(getModel(relModel), relModel, child)
              refs.push(this._entityKey(relModel, child.id))
            }
          }
          entity[key] = { __refs: refs }
        } else if (field.type === 'hasOne') {
          if (value && typeof value === 'object' && value.id) {
            this._normalizeEntity(getModel(relModel), relModel, value)
            entity[key] = { __ref: this._entityKey(relModel, value.id) }
          } else if (value === null) {
            entity[key] = { __ref: null }
          }
        }
      } else {
        entity[key] = value
      }
    }
    const key = this._entityKey(modelName, row.id)
    this.entities[key] = { ...this.entities[key], ...entity }
  }

  denormalize(modelName, id, _path = new Set()) {
    const entity = this.readEntity(modelName, id)
    if (!entity) return null

    const model = getModel(modelName)
    if (!model) return { ...entity }

    // Cycle guard: when an entity reappears in its own relation chain, emit
    // its scalar fields but stop expanding relations.
    const entityKey = this._entityKey(modelName, id)
    const inCycle = _path.has(entityKey)
    const path = new Set(_path).add(entityKey)

    const result = {}
    for (const [key, value] of Object.entries(entity)) {
      const field = model.fields[key]
      if (field?.type === 'date') {
        result[key] = value != null ? dayjs(value) : null
      } else if (field?.type === 'hasMany') {
        const refs = inCycle ? [] : (value?.__refs ?? [])
        result[key] = refs.map((ref) => this._denormalizeRef(ref, path)).filter(Boolean)
      } else if (field?.type === 'hasOne') {
        result[key] = !inCycle && value?.__ref ? this._denormalizeRef(value.__ref, path) : null
      } else {
        result[key] = value
      }
    }

    if (!inCycle) {
      for (const [key, field] of Object.entries(model.fields)) {
        if (field.type === 'belongsTo') {
          const fkId = entity[`${key}Id`]
          if (fkId) {
            result[key] = this.denormalize(field.withModel, fkId, path)
          }
        }
      }
    }

    return result
  }

  _denormalizeRef(ref, path) {
    const idx = ref.indexOf(':')
    return this.denormalize(ref.slice(0, idx), ref.slice(idx + 1), path)
  }

  storeQueryResult(queryKey, models, rows, dependsOn) {
    const primaryModel = models[0]
    const isSingle = !Array.isArray(rows)
    const list = Array.isArray(rows) ? rows : rows != null ? [rows] : []

    // Raw queries (no model) — store results directly, can't normalize without entity ids
    if (!primaryModel) {
      this.queries[queryKey] = { models, raw: true, data: isSingle ? (list[0] ?? null) : list, isSingle }
    } else {
      const entityRefs = list.filter((r) => r?.id).map((r) => this._entityKey(primaryModel, r.id))
      this.normalize(primaryModel, list)
      this.queries[queryKey] = { models, entityRefs, isSingle }
    }

    if (dependsOn?.length) {
      this.queries[queryKey].dependsOn = dependsOn
    }
  }

  readQueryResult(queryKey) {
    const entry = this.queries[queryKey]
    if (!entry) return undefined

    // Raw queries — return stored data directly
    if (entry.raw) return entry.data

    const { models, entityRefs, isSingle } = entry
    const primaryModel = models[0]

    const results = entityRefs
      .map((ref) => {
        const [model, id] = ref.split(':')
        return this.denormalize(model, id)
      })
      .filter(Boolean)

    return isSingle ? (results[0] ?? null) : results
  }

  hasQuery(queryKey) {
    return queryKey in this.queries
  }

  invalidateModel(modelName) {
    const toDelete = []
    for (const [key, entry] of Object.entries(this.queries)) {
      if (entry.models.includes(modelName) || entry.dependsOn?.includes(modelName)) {
        toDelete.push(key)
      }
    }
    for (const key of toDelete) {
      delete this.queries[key]
    }
  }

  invalidateAll() {
    this.queries = {}
  }

  getQueriesForModel(modelName) {
    const keys = []
    for (const [key, entry] of Object.entries(this.queries)) {
      if (entry.models.includes(modelName)) {
        keys.push(key)
      }
    }
    return keys
  }
}
