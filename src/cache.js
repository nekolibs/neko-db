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
        if (field.type === 'belongsTo' && value && typeof value === 'object') {
          if (value.id) {
            this._normalizeEntity(getModel(relModel), relModel, value)
          }
        } else if (field.type === 'hasMany' && Array.isArray(value)) {
          for (const child of value) {
            if (child?.id) {
              this._normalizeEntity(getModel(relModel), relModel, child)
            }
          }
        } else if (field.type === 'hasOne' && value && typeof value === 'object') {
          if (value.id) {
            this._normalizeEntity(getModel(relModel), relModel, value)
          }
        }
      } else {
        entity[key] = value
      }
    }
    const key = this._entityKey(modelName, row.id)
    this.entities[key] = { ...this.entities[key], ...entity }
  }

  denormalize(modelName, id) {
    const entity = this.readEntity(modelName, id)
    if (!entity) return null

    const model = getModel(modelName)
    if (!model) return { ...entity }

    const result = {}
    for (const [key, value] of Object.entries(entity)) {
      const field = model.fields[key]
      if (field?.type === 'date') {
        result[key] = value != null ? dayjs(value) : null
      } else {
        result[key] = value
      }
    }

    for (const [key, field] of Object.entries(model.fields)) {
      if (field.type === 'belongsTo') {
        const fkId = entity[`${key}Id`]
        if (fkId) {
          result[key] = this.denormalize(field.withModel, fkId)
        }
      }
    }

    return result
  }

  storeQueryResult(queryKey, models, rows) {
    const primaryModel = models[0]
    const list = Array.isArray(rows) ? rows : rows != null ? [rows] : []
    const entityRefs = list.filter((r) => r?.id).map((r) => this._entityKey(primaryModel, r.id))

    this.normalize(primaryModel, list)

    this.queries[queryKey] = { models, entityRefs, isSingle: !Array.isArray(rows) }
  }

  readQueryResult(queryKey) {
    const entry = this.queries[queryKey]
    if (!entry) return undefined

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
      if (entry.models.includes(modelName)) {
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
