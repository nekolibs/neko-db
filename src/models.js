const models = {}

export function getModel(name) {
  return models[name]
}

export function getModels() {
  return models
}

export function registerModels(modelList) {
  modelList.forEach((model) => {
    models[model.name] = model
  })

  return models
}

import { generateUUIDv7 } from './utils/uuid'
import { syncNow } from './sync/clock'

let _emitter = null

export function setEmitter(emitter) {
  _emitter = emitter
}

export function getEmitter() {
  return _emitter
}

export class Model {
  constructor(name, { fields, triggers = null, timestamps = true, sync = false }) {
    this.name = name
    this.fields = fields
    this.triggers = triggers || {}
    this.timestamps = timestamps
    this.sync = sync
  }

  _applyTimestamps(data, isInsert = false, fromSync = false) {
    const result = { ...data }
    // Sync dirty marker — device clock, monotonic. Pull-applied writes (fromSync)
    // skip it entirely: a new row stays null (never written locally), an existing
    // row keeps its real stamp — clean-ness is decided by the push cursor, not this.
    if (this.sync && !fromSync && !('localUpdatedAt' in result)) result.localUpdatedAt = syncNow()
    if (!this.timestamps) return result
    const now = new Date().toISOString()
    if (isInsert && !('insertedAt' in result)) result.insertedAt = now
    if (!('updatedAt' in result)) result.updatedAt = now
    return result
  }

  async _fireTrigger(name, context) {
    const fn = this.triggers[name]
    if (!fn) return undefined
    return fn(context)
  }

  query() {
    const { Query } = require('./query')
    return Query.from(this)
  }

  all(db) {
    return this.query().all(db)
  }

  first(db, where = null) {
    let q = this.query()
    if (where) q = q.where(where)
    return q.first(db)
  }

  get(db, id) {
    return this.query().where({ id }).first(db)
  }

  _serialize(data) {
    const result = { ...data }
    for (const [key, value] of Object.entries(result)) {
      const fn = this.fields[key]?.serialize
      if (fn) result[key] = fn(value)
    }
    return result
  }

  _deserialize(row) {
    for (const [key, field] of Object.entries(this.fields)) {
      if (field.deserialize && key in row) row[key] = field.deserialize(row[key])
    }
    return row
  }

  async insert(db, data, options = {}) {
    const { Query } = require('./query')
    const isUpsert = !!options.onConflict
    const op = isUpsert ? 'Upsert' : 'Insert'

    // Auto-generate UUID id
    if (!data.id) {
      data = { id: generateUUIDv7(), ...data }
    }

    const fromSync = !!options.fromSync

    // Auto-timestamps
    data = this._applyTimestamps(data, true, fromSync)

    // Batch before trigger
    let dataArray = [data]
    const batchResult = await this._fireTrigger(`before${op}Many`, { data: dataArray, db, fromSync })
    if (batchResult !== undefined) dataArray = batchResult

    // Per-record before trigger
    let item = dataArray[0]
    const itemResult = await this._fireTrigger(`before${op}`, { data: item, db, fromSync })
    if (itemResult !== undefined) item = itemResult

    // Serialize AFTER triggers (triggers work on raw JS input)
    const result = await Query.insert(db, this, this._serialize(item), options)

    // Per-record after trigger
    await this._fireTrigger(`after${op}`, { data: item, result, db, fromSync })

    // Batch after trigger
    await this._fireTrigger(`after${op}Many`, { data: [item], results: [result], db, fromSync })

    _emitter?.emit(this.name)
    return result
  }

  async insertMany(db, dataArray, options = {}) {
    const { Query } = require('./query')
    const isUpsert = !!options.onConflict
    const op = isUpsert ? 'Upsert' : 'Insert'
    const hasTriggers = Object.keys(this.triggers).length > 0
    const fromSync = !!options.fromSync

    // Auto-generate UUID ids
    dataArray = dataArray.map((d) => (d.id ? d : { id: generateUUIDv7(), ...d }))

    // Auto-timestamps
    dataArray = dataArray.map((d) => this._applyTimestamps(d, true, fromSync))

    // Fast path: no triggers
    if (!hasTriggers) {
      const results = await Query.insertMany(db, this, dataArray.map((d) => this._serialize(d)), options)
      _emitter?.emit(this.name)
      return results
    }

    // Batch before trigger
    let items = [...dataArray]
    const batchResult = await this._fireTrigger(`before${op}Many`, { data: items, db, fromSync })
    if (batchResult !== undefined) items = batchResult

    // Per-record before triggers
    for (let i = 0; i < items.length; i++) {
      const itemResult = await this._fireTrigger(`before${op}`, { data: items[i], db, fromSync })
      if (itemResult !== undefined) items[i] = itemResult
    }

    // Serialize AFTER triggers
    const results = await Query.insertMany(db, this, items.map((d) => this._serialize(d)), options)

    // Per-record after triggers
    for (let i = 0; i < items.length; i++) {
      await this._fireTrigger(`after${op}`, { data: items[i], result: results[i], db, fromSync })
    }

    // Batch after trigger
    await this._fireTrigger(`after${op}Many`, { data: items, results, db, fromSync })

    _emitter?.emit(this.name)
    return results
  }

  async update(db, id, data, options = {}) {
    const fromSync = !!options.fromSync

    // Auto-timestamps
    data = this._applyTimestamps(data, false, fromSync)

    // Batch before trigger
    let currentData = data
    const batchResult = await this._fireTrigger('beforeUpdateMany', { ids: [id], data: currentData, db, fromSync })
    if (batchResult !== undefined) currentData = batchResult

    // Per-record before trigger
    const itemResult = await this._fireTrigger('beforeUpdate', { id, data: currentData, db, fromSync })
    if (itemResult !== undefined) currentData = itemResult

    // Serialize AFTER triggers, skip triggers in query to prevent double-firing
    const result = await this.query().where({ id }).update(db, this._serialize(currentData), { _skipTriggers: true, fromSync })

    // Per-record after trigger
    await this._fireTrigger('afterUpdate', { id, data: currentData, db, fromSync })

    // Batch after trigger
    await this._fireTrigger('afterUpdateMany', { ids: [id], data: currentData, db, fromSync })

    _emitter?.emit(this.name)
    return result
  }

  async delete(db, id) {
    if (this.sync) {
      throw new Error(
        `Model "${this.name}" is synced — hard deletes would be invisible to sync. Soft delete instead: update(db, id, { deleted: true })`
      )
    }

    // Batch before trigger
    await this._fireTrigger('beforeDeleteMany', { ids: [id], db })

    // Per-record before trigger
    await this._fireTrigger('beforeDelete', { id, db })

    // Skip triggers in query to prevent double-firing
    const result = await this.query().where({ id }).delete(db, { _skipTriggers: true })

    // Per-record after trigger
    await this._fireTrigger('afterDelete', { id, db })

    // Batch after trigger
    await this._fireTrigger('afterDeleteMany', { ids: [id], db })

    _emitter?.emit(this.name)
    return result
  }
}

