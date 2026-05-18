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

export class Model {
  constructor(name, { fields, typeDefs = null, resolvers = null, types = null, queries = null, mutations = null, triggers = null, timestamps = true }) {
    this.name = name
    this.fields = fields
    this.triggers = triggers || {}
    this.timestamps = timestamps

    if (queries || mutations) {
      this.typeDefs = this._buildTypeDefs(types, queries, mutations)
      this.resolvers = this._buildResolvers(queries, mutations)
    } else {
      this.typeDefs = typeDefs
      this.resolvers = resolvers
    }
  }

  _buildTypeDefs(types, queries, mutations) {
    const { gql } = require('@apollo/client')
    const parts = []

    if (types) parts.push(types)

    const querySchemas = (queries || []).map((q) => q.schema)
    const mutationSchemas = (mutations || []).map((m) => m.schema)

    if (querySchemas.length) {
      parts.push(`extend type Query {\n${querySchemas.map((s) => `    ${s}`).join('\n')}\n  }`)
    }
    if (mutationSchemas.length) {
      parts.push(`extend type Mutation {\n${mutationSchemas.map((s) => `    ${s}`).join('\n')}\n  }`)
    }

    const extraTypes = [...(queries || []), ...(mutations || [])]
      .map((r) => r.types)
      .filter(Boolean)

    if (extraTypes.length) parts.push(...extraTypes)

    if (!parts.length) return null
    return gql(parts.join('\n\n'))
  }

  _buildResolvers(queries, mutations) {
    const result = {}

    if (queries?.length) {
      result.Query = {}
      for (const q of queries) {
        const name = q.schema.match(/^\s*(\w+)/)[1]
        result.Query[name] = q.resolver
      }
    }

    if (mutations?.length) {
      result.Mutation = {}
      for (const m of mutations) {
        const name = m.schema.match(/^\s*(\w+)/)[1]
        result.Mutation[name] = m.resolver
      }
    }

    return Object.keys(result).length ? result : null
  }

  _applyTimestamps(data, isInsert = false) {
    if (!this.timestamps) return data
    const now = new Date().toISOString()
    const result = { ...data }
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

    // Auto-timestamps
    data = this._applyTimestamps(data, true)

    // Batch before trigger
    let dataArray = [data]
    const batchResult = await this._fireTrigger(`before${op}Many`, { data: dataArray, db })
    if (batchResult !== undefined) dataArray = batchResult

    // Per-record before trigger
    let item = dataArray[0]
    const itemResult = await this._fireTrigger(`before${op}`, { data: item, db })
    if (itemResult !== undefined) item = itemResult

    // Serialize AFTER triggers (triggers work on raw JS input)
    const result = await Query.insert(db, this, this._serialize(item), options)

    // Per-record after trigger
    await this._fireTrigger(`after${op}`, { data: item, result, db })

    // Batch after trigger
    await this._fireTrigger(`after${op}Many`, { data: [item], results: [result], db })

    return result
  }

  async insertMany(db, dataArray, options = {}) {
    const { Query } = require('./query')
    const isUpsert = !!options.onConflict
    const op = isUpsert ? 'Upsert' : 'Insert'
    const hasTriggers = Object.keys(this.triggers).length > 0

    // Auto-generate UUID ids
    dataArray = dataArray.map((d) => (d.id ? d : { id: generateUUIDv7(), ...d }))

    // Auto-timestamps
    dataArray = dataArray.map((d) => this._applyTimestamps(d, true))

    // Fast path: no triggers
    if (!hasTriggers) {
      return Query.insertMany(db, this, dataArray.map((d) => this._serialize(d)), options)
    }

    // Batch before trigger
    let items = [...dataArray]
    const batchResult = await this._fireTrigger(`before${op}Many`, { data: items, db })
    if (batchResult !== undefined) items = batchResult

    // Per-record before triggers
    for (let i = 0; i < items.length; i++) {
      const itemResult = await this._fireTrigger(`before${op}`, { data: items[i], db })
      if (itemResult !== undefined) items[i] = itemResult
    }

    // Serialize AFTER triggers
    const results = await Query.insertMany(db, this, items.map((d) => this._serialize(d)), options)

    // Per-record after triggers
    for (let i = 0; i < items.length; i++) {
      await this._fireTrigger(`after${op}`, { data: items[i], result: results[i], db })
    }

    // Batch after trigger
    await this._fireTrigger(`after${op}Many`, { data: items, results, db })

    return results
  }

  async update(db, id, data) {
    // Auto-timestamps
    data = this._applyTimestamps(data)

    // Batch before trigger
    let currentData = data
    const batchResult = await this._fireTrigger('beforeUpdateMany', { ids: [id], data: currentData, db })
    if (batchResult !== undefined) currentData = batchResult

    // Per-record before trigger
    const itemResult = await this._fireTrigger('beforeUpdate', { id, data: currentData, db })
    if (itemResult !== undefined) currentData = itemResult

    // Serialize AFTER triggers, skip triggers in query to prevent double-firing
    const result = await this.query().where({ id }).update(db, this._serialize(currentData), { _skipTriggers: true })

    // Per-record after trigger
    await this._fireTrigger('afterUpdate', { id, data: currentData, db })

    // Batch after trigger
    await this._fireTrigger('afterUpdateMany', { ids: [id], data: currentData, db })

    return result
  }

  async delete(db, id) {
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

    return result
  }
}

