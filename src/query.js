import { getModel, getEmitter } from './models'
import { syncNow } from './sync/clock'

export class Query {
  constructor(source, state = {}) {
    // source can be: Model instance, model name string, or table name
    if (typeof source === 'string') {
      this._model = getModel(source)
      this._table = this._model?.name ?? source
    } else if (source?.name) {
      this._model = source
      this._table = source.name
    } else {
      this._model = null
      this._table = null
    }

    this._state = {
      select: state.select ?? ['*'],
      where: state.where ?? [],
      joins: state.joins ?? [],
      preloads: state.preloads ?? [],
      orderBy: state.orderBy ?? [],
      limit: state.limit ?? null,
      offset: state.offset ?? null,
      rawSQL: state.rawSQL ?? null,
      rawParams: state.rawParams ?? [],
    }
  }

  // ============================================
  // CHAINABLE METHODS
  // ============================================

  select(...fields) {
    return this._clone({ select: fields.flat() })
  }

  where(conditions) {
    return this._clone({
      where: [...this._state.where, conditions],
    })
  }

  whereIf(condition, conditions) {
    return condition ? this.where(conditions) : this
  }

  // Sync helper: rows with local changes newer than the push's last success.
  // No cursor yet (never pushed) = everything ever written locally.
  whereDirty(cursor) {
    const { gt, fragment } = require('./operators')
    return cursor ? this.where({ localUpdatedAt: gt(cursor) }) : this.where(fragment('localUpdatedAt IS NOT NULL'))
  }

  orWhere(...conditions) {
    return this._clone({
      where: [...this._state.where, { $or: conditions }],
    })
  }

  join(relationName, type = 'INNER') {
    if (!this._model) {
      throw new Error('join() requires a model. Use joinTable() for raw joins.')
    }

    const relation = this._model.fields[relationName]
    if (!relation) {
      throw new Error(`Unknown relation: ${relationName}`)
    }

    return this._clone({
      joins: [...this._state.joins, { relationName, type, relation }],
    })
  }

  joinTable(table, on, type = 'INNER') {
    return this._clone({
      joins: [...this._state.joins, { table, on, type, explicit: true }],
    })
  }

  // Supports nested relations via dot paths, e.g. preload('pet.avatar').
  // The first segment is a relation on this model; the rest is preloaded on the
  // related model. Calls targeting the same relation merge (nested paths accrue).
  preload(path, options = {}) {
    if (!this._model) {
      throw new Error('preload() requires a model.')
    }

    const [relationName, ...rest] = path.split('.')
    const relation = this._model.fields[relationName]
    if (!relation) {
      throw new Error(`Unknown relation: ${relationName}`)
    }
    const nestedPath = rest.join('.')

    const preloads = [...this._state.preloads]
    const idx = preloads.findIndex((p) => p.relationName === relationName)
    if (idx >= 0) {
      const prev = preloads[idx]
      preloads[idx] = {
        ...prev,
        // Last explicit select wins for a merged relation.
        select: options.select ?? prev.select ?? null,
        // Dedup nested paths so the same relation isn't preloaded twice.
        nested:
          nestedPath && !(prev.nested || []).includes(nestedPath)
            ? [...(prev.nested || []), nestedPath]
            : prev.nested || [],
      }
    } else {
      preloads.push({
        relationName,
        relation,
        select: options.select ?? null,
        nested: nestedPath ? [nestedPath] : [],
      })
    }

    return this._clone({ preloads })
  }

  orderBy(field, direction = 'ASC') {
    return this._clone({
      orderBy: [...this._state.orderBy, { field, direction: direction.toUpperCase() }],
    })
  }

  limit(n) {
    return this._clone({ limit: n })
  }

  offset(n) {
    return this._clone({ offset: n })
  }

  models() {
    const result = []
    if (this._model) result.push(this._model.name)

    // Walk preloads (incl. nested dot-paths) so a query subscribes to every model
    // it touches — e.g. preload('pet.avatar') subscribes to pet AND document.
    const walk = (model, preloads) => {
      for (const p of preloads) {
        const relation = p.relation || model?.fields?.[p.relationName]
        const withModel = relation?.withModel
        if (withModel && !result.includes(withModel)) result.push(withModel)
        if (p.nested?.length && withModel) {
          walk(
            getModel(withModel),
            p.nested.map((path) => {
              const [relationName, ...rest] = path.split('.')
              return { relationName, nested: rest.length ? [rest.join('.')] : [] }
            })
          )
        }
      }
    }
    walk(this._model, this._state.preloads)

    return result
  }

  // ============================================
  // EXECUTION METHODS
  // ============================================

  async all(db) {
    if (this._state.rawSQL) {
      return db.getAllAsync(this._state.rawSQL, ...this._state.rawParams)
    }

    const { sql, params } = this._buildSelect()
    const rows = await db.getAllAsync(sql, ...params)
    if (this._model) rows.forEach((r) => this._model._deserialize(r))
    return this._hydrateResults(db, rows)
  }

  async first(db) {
    const results = await this.limit(1).all(db)
    return results[0] ?? null
  }

  async one(db) {
    const results = await this.limit(2).all(db)

    if (results.length === 0) {
      throw new Error(`Expected one ${this._table}, got none`)
    }
    if (results.length > 1) {
      throw new Error(`Expected one ${this._table}, got multiple`)
    }

    return results[0]
  }

  async count(db) {
    const countQuery = this._clone({ select: ['COUNT(*) as count'], preloads: [] })
    const { sql, params } = countQuery._buildSelect()
    const result = await db.getFirstAsync(sql, ...params)
    return result?.count ?? 0
  }

  async exists(db) {
    const count = await this.limit(1).count(db)
    return count > 0
  }

  // ============================================
  // WRITE OPERATIONS
  // ============================================

  async _execUpdate(db, data, fromSync = false) {
    // Sync dirty marker — single choke point ALL update paths flow through.
    // fromSync (pull-applied) skips it; an explicit key also suppresses it.
    if (this._model?.sync && !fromSync && !('localUpdatedAt' in data)) {
      data = { ...data, localUpdatedAt: syncNow() }
    }

    // Auto-timestamps
    if (this._model?.timestamps && !('updatedAt' in data)) {
      data = { ...data, updatedAt: new Date().toISOString() }
    }

    const sets = Object.keys(data).map((k) => `${k} = ?`)
    const setParams = Object.values(data)

    const { whereClause, whereParams } = this._buildWhereClause()

    const sql = `UPDATE ${this._table} SET ${sets.join(', ')} ${whereClause}`
    const result = await db.runAsync(sql, ...setParams, ...whereParams)

    return { changes: result.changes }
  }

  async _execDelete(db) {
    const { whereClause, whereParams } = this._buildWhereClause()

    if (whereParams.length === 0) {
      throw new Error('Refusing to delete without WHERE conditions.')
    }

    const sql = `DELETE FROM ${this._table} ${whereClause}`
    const result = await db.runAsync(sql, ...whereParams)

    return { changes: result.changes }
  }

  async update(db, data, options = {}) {
    // Skip triggers: called from Model.update which already handled triggers
    if (options._skipTriggers) return this._execUpdate(db, data, !!options.fromSync)

    // No model or no triggers: fast path
    const hasTriggers = this._model && Object.keys(this._model.triggers).length > 0
    if (!hasTriggers) {
      const result = await this._execUpdate(db, data, !!options.fromSync)
      if (this._model) getEmitter()?.emit(this._model.name)
      return result
    }

    // SELECT affected IDs for trigger context
    const idQuery = this._clone({ select: [`${this._table}.id`], preloads: [] })
    const { sql: idSql, params: idParams } = idQuery._buildSelect()
    const rows = await db.getAllAsync(idSql, ...idParams)
    const ids = rows.map((r) => r.id)

    if (ids.length === 0) return { changes: 0 }

    const fromSync = !!options.fromSync

    // Batch before trigger
    let currentData = data
    const batchResult = await this._model._fireTrigger('beforeUpdateMany', { ids, data: currentData, db, fromSync })
    if (batchResult !== undefined) currentData = batchResult

    // Per-record before triggers
    for (const id of ids) {
      const itemResult = await this._model._fireTrigger('beforeUpdate', { id, data: currentData, db, fromSync })
      if (itemResult !== undefined) currentData = itemResult
    }

    // Execute the update
    const result = await this._execUpdate(db, currentData, fromSync)

    // Per-record after triggers
    for (const id of ids) {
      await this._model._fireTrigger('afterUpdate', { id, data: currentData, db, fromSync })
    }

    // Batch after trigger
    await this._model._fireTrigger('afterUpdateMany', { ids, data: currentData, db, fromSync })

    getEmitter()?.emit(this._model.name)
    return result
  }

  async delete(db, options = {}) {
    if (this._model?.sync) {
      throw new Error(
        `Model "${this._model.name}" is synced — hard deletes would be invisible to sync. Soft delete instead: update(db, { deleted: true })`
      )
    }

    // Skip triggers: called from Model.delete which already handled triggers
    if (options._skipTriggers) return this._execDelete(db)

    // No model or no triggers: fast path
    const hasTriggers = this._model && Object.keys(this._model.triggers).length > 0
    if (!hasTriggers) {
      const result = await this._execDelete(db)
      if (this._model) getEmitter()?.emit(this._model.name)
      return result
    }

    // SELECT affected IDs for trigger context
    const idQuery = this._clone({ select: [`${this._table}.id`], preloads: [] })
    const { sql: idSql, params: idParams } = idQuery._buildSelect()
    const rows = await db.getAllAsync(idSql, ...idParams)
    const ids = rows.map((r) => r.id)

    if (ids.length === 0) return { changes: 0 }

    // Batch before trigger
    await this._model._fireTrigger('beforeDeleteMany', { ids, db })

    // Per-record before triggers
    for (const id of ids) {
      await this._model._fireTrigger('beforeDelete', { id, db })
    }

    // Execute the delete
    const result = await this._execDelete(db)

    // Per-record after triggers
    for (const id of ids) {
      await this._model._fireTrigger('afterDelete', { id, db })
    }

    // Batch after trigger
    await this._model._fireTrigger('afterDeleteMany', { ids, db })

    getEmitter()?.emit(this._model.name)
    return result
  }

  static async insert(db, model, data, options = {}) {
    const tableName = typeof model === 'string' ? model : model.name
    const columns = Object.keys(data)
    const placeholders = columns.map(() => '?').join(', ')
    const values = Object.values(data)

    const conflictClause = Query._buildConflictClause(columns, options.onConflict)
    const sql = `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${placeholders})${conflictClause} RETURNING *`
    const row = await db.getFirstAsync(sql, ...values)

    return model._deserialize ? model._deserialize(row) : row
  }

  static async insertMany(db, model, dataArray, options = {}) {
    if (!dataArray.length) return []

    const tableName = typeof model === 'string' ? model : model.name
    const columns = Object.keys(dataArray[0])
    const conflictClause = Query._buildConflictClause(columns, options.onConflict)

    const rowPlaceholder = `(${columns.map(() => '?').join(', ')})`
    const allPlaceholders = dataArray.map(() => rowPlaceholder).join(', ')
    const allValues = dataArray.flatMap((data) => columns.map((col) => data[col]))

    const sql = `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES ${allPlaceholders}${conflictClause} RETURNING *`
    const rows = await db.getAllAsync(sql, ...allValues)

    if (model._deserialize) rows.forEach((r) => model._deserialize(r))
    return rows
  }

  static async transaction(db, fn) {
    let result
    await db.withTransactionAsync(async () => {
      result = await fn()
    })
    return result
  }

  static _buildConflictClause(columns, onConflict) {
    if (!onConflict) return ''

    if (onConflict === 'ignore') {
      return ' ON CONFLICT DO NOTHING'
    }

    if (onConflict === 'replace') {
      return ' ON CONFLICT DO UPDATE SET ' + columns.map((c) => `${c} = excluded.${c}`).join(', ')
    }

    if (typeof onConflict === 'object') {
      const { target, update } = onConflict
      const targetClause = Array.isArray(target) ? target.join(', ') : target

      let updateColumns
      if (update === 'all') {
        updateColumns = columns.filter((c) => c !== 'id' && c !== 'insertedAt' && c !== target && !target?.includes?.(c))
      } else {
        updateColumns = Array.isArray(update) ? update : [update]
      }

      const updateClause = updateColumns.map((c) => `${c} = excluded.${c}`).join(', ')
      return ` ON CONFLICT(${targetClause}) DO UPDATE SET ${updateClause}`
    }

    return ''
  }

  // ============================================
  // SQL BUILDING
  // ============================================

  _clone(updates) {
    const newQuery = new Query(this._model ?? this._table, { ...this._state, ...updates })
    newQuery._table = this._table
    newQuery._model = this._model
    return newQuery
  }

  _buildSelect() {
    const parts = []
    const params = []

    // SELECT — scope to base table when using default * with joins
    const hasJoins = this._state.joins.length > 0
    const isDefaultSelect = this._state.select.length === 1 && this._state.select[0] === '*'
    const selectClause = (hasJoins && isDefaultSelect) ? `${this._table}.*` : this._state.select.join(', ')
    parts.push(`SELECT ${selectClause}`)

    // FROM
    parts.push(`FROM ${this._table}`)

    // JOINs
    for (const join of this._state.joins) {
      if (join.explicit) {
        parts.push(`${join.type} JOIN ${join.table} ON ${join.on}`)
      } else {
        const { relationName, type, relation } = join

        if (relation.type === 'belongsTo') {
          const relatedModel = getModel(relation.withModel)
          parts.push(`${type} JOIN ${relatedModel.name} ON ${this._table}.${relationName}Id = ${relatedModel.name}.id`)
        } else if (relation.type === 'hasMany' || relation.type === 'hasOne') {
          const relatedModel = getModel(relation.withModel)
          parts.push(`${type} JOIN ${relatedModel.name} ON ${relatedModel.name}.${this._table}Id = ${this._table}.id`)
        }
      }
    }

    // WHERE
    const { whereClause, whereParams } = this._buildWhereClause()
    if (whereClause) {
      parts.push(whereClause)
    }
    params.push(...whereParams)

    // ORDER BY
    if (this._state.orderBy.length > 0) {
      const orders = this._state.orderBy.map((o) => `${o.field} ${o.direction}`)
      parts.push(`ORDER BY ${orders.join(', ')}`)
    }

    // LIMIT
    if (this._state.limit !== null) {
      parts.push(`LIMIT ${this._state.limit}`)
    }

    // OFFSET
    if (this._state.offset !== null) {
      parts.push(`OFFSET ${this._state.offset}`)
    }

    return { sql: parts.join(' '), params }
  }

  _buildWhereClause() {
    if (this._state.where.length === 0) {
      return { whereClause: '', whereParams: [] }
    }

    const clauses = []
    const params = []

    for (const condition of this._state.where) {
      const { clause, params: condParams } = this._processCondition(condition)
      if (clause) clauses.push(clause)
      params.push(...condParams)
    }

    return {
      whereClause: `WHERE ${clauses.join(' AND ')}`,
      whereParams: params,
    }
  }

  _processCondition(condition) {
    // OR group: array of condition objects joined with OR
    if (condition.$or) {
      const orParts = []
      const orParams = []
      for (const cond of condition.$or) {
        const { clause, params } = this._conditionToSQL(cond)
        orParts.push(clause)
        orParams.push(...params)
      }
      return { clause: `(${orParts.join(' OR ')})`, params: orParams }
    }

    // Fragment
    if (condition.$fragment) {
      return this._processFragment(condition)
    }

    // Array comparison: ['field', '>', value]
    if (Array.isArray(condition)) {
      const [field, op, value] = condition
      return { clause: `${field} ${op} ?`, params: [value] }
    }

    // Object conditions
    return this._conditionToSQL(condition)
  }

  _processFragment(fragment) {
    const { sql, values } = fragment
    const params = []
    let processedSQL = sql
    let placeholderIndex = 0

    // Replace ? placeholders with actual values or column refs
    const parts = sql.split('?')
    const resultParts = [parts[0]]

    for (let i = 1; i < parts.length; i++) {
      const value = values[placeholderIndex++]

      if (value?.$column) {
        resultParts.push(value.name)
      } else {
        resultParts.push('?')
        params.push(value)
      }

      resultParts.push(parts[i])
    }

    return { clause: resultParts.join(''), params }
  }

  _conditionToSQL(obj) {
    const parts = []
    const params = []

    for (const [key, value] of Object.entries(obj)) {
      if (value === null) {
        parts.push(`${key} IS NULL`)
      } else if (Array.isArray(value)) {
        // IN clause
        const placeholders = value.map(() => '?').join(', ')
        parts.push(`${key} IN (${placeholders})`)
        params.push(...value)
      } else if (value?.$notIn) {
        // NOT IN clause
        if (value.$values.length === 0) continue
        const placeholders = value.$values.map(() => '?').join(', ')
        parts.push(`${key} NOT IN (${placeholders})`)
        params.push(...value.$values)
      } else if (value?.$op) {
        // Operator: { field: gt(100) }
        parts.push(`${key} ${value.$op} ?`)
        params.push(value.$value)
      } else if (value?.$fragment) {
        // Fragment as value
        const { clause, params: fragParams } = this._processFragment(value)
        parts.push(`${key} = ${clause}`)
        params.push(...fragParams)
      } else {
        parts.push(`${key} = ?`)
        params.push(value)
      }
    }

    return { clause: parts.join(' AND '), params }
  }

  async _hydrateResults(db, rows) {
    // No parent rows -> nothing to hydrate. Also avoids building an invalid
    // `IN ()` clause in the hasMany/hasOne preload paths.
    if (this._state.preloads.length === 0 || !this._model || rows.length === 0) {
      return rows
    }

    for (const { relationName, relation, select, nested } of this._state.preloads) {
      const relatedModel = getModel(relation.withModel)

      // When this relation has nested preloads, force `*`: narrowing columns
      // could strip the FK the nested preload needs to resolve. (There is no
      // per-nested select API yet — nested relations always load `*`.)
      const useSelect = nested?.length ? null : select

      // Build select clause - always include 'id' and FK fields
      const selectClause = useSelect ? ['id', ...useSelect].filter((v, i, a) => a.indexOf(v) === i).join(', ') : '*'

      // The attached related rows (same object refs the parents hold), reused for
      // nested preloads below.
      let related

      if (relation.type === 'belongsTo') {
        const fkField = `${relationName}Id`
        const ids = [...new Set(rows.map((r) => r[fkField]).filter(Boolean))]

        if (ids.length > 0) {
          const placeholders = ids.map(() => '?').join(', ')
          related = await db.getAllAsync(
            `SELECT ${selectClause} FROM ${relatedModel.name} WHERE id IN (${placeholders})`,
            ...ids
          )
          if (relatedModel._deserialize) related.forEach((r) => relatedModel._deserialize(r))
          const relatedMap = Object.fromEntries(related.map((r) => [r.id, r]))

          for (const row of rows) {
            row[relationName] = relatedMap[row[fkField]] ?? null
          }
        } else {
          for (const row of rows) {
            row[relationName] = null
          }
        }
      } else if (relation.type === 'hasMany') {
        const ids = rows.map((r) => r.id)
        const placeholders = ids.map(() => '?').join(', ')

        // Polymorphic: child has `${base}Table` or `${base}Type` (legacy) plus
        // `${base}Id` columns — detected from the related model's declared
        // fields. The stored value is this model's table name (e.g. 'event').
        // Otherwise plain FK.
        const isPoly = !!relation.polymorphic
        const polySuffix = isPoly && relatedModel.fields?.[`${relation.polymorphic}Table`] ? 'Table' : 'Type'
        const fkField = isPoly ? `${relation.polymorphic}Id` : `${this._table}Id`
        const typeField = isPoly ? `${relation.polymorphic}${polySuffix}` : null

        // Include FK (and type) field in select for hasMany
        const baseCols = isPoly ? ['id', typeField, fkField] : ['id', fkField]
        const hasManySelect = useSelect
          ? [...baseCols, ...useSelect].filter((v, i, a) => a.indexOf(v) === i).join(', ')
          : '*'

        const where = isPoly
          ? `${typeField} = ? AND ${fkField} IN (${placeholders})`
          : `${fkField} IN (${placeholders})`
        const params = isPoly ? [this._table, ...ids] : ids
        related = await db.getAllAsync(
          `SELECT ${hasManySelect} FROM ${relatedModel.name} WHERE ${where}`,
          ...params
        )
        if (relatedModel._deserialize) related.forEach((r) => relatedModel._deserialize(r))

        const relatedMap = {}
        for (const r of related) {
          const fk = r[fkField]
          if (!relatedMap[fk]) relatedMap[fk] = []
          relatedMap[fk].push(r)
        }

        for (const row of rows) {
          row[relationName] = relatedMap[row.id] ?? []
        }
      } else if (relation.type === 'hasOne') {
        const ids = rows.map((r) => r.id)
        const fkField = `${this._table}Id`

        // Include FK field in select for hasOne
        const hasOneSelect = useSelect
          ? ['id', fkField, ...useSelect].filter((v, i, a) => a.indexOf(v) === i).join(', ')
          : '*'

        const placeholders = ids.map(() => '?').join(', ')
        related = await db.getAllAsync(
          `SELECT ${hasOneSelect} FROM ${relatedModel.name} WHERE ${fkField} IN (${placeholders})`,
          ...ids
        )
        if (relatedModel._deserialize) related.forEach((r) => relatedModel._deserialize(r))

        const relatedMap = Object.fromEntries(related.map((r) => [r[fkField], r]))

        for (const row of rows) {
          row[relationName] = relatedMap[row.id] ?? null
        }
      }

      // Nested preload: hydrate the attached related rows (same refs, so parents
      // see the nested data). e.g. preload('pet.avatar') on an events query.
      if (nested?.length && related?.length) {
        let q = relatedModel.query()
        for (const path of nested) q = q.preload(path)
        await q._hydrateResults(db, related)
      }
    }

    return rows
  }

  // ============================================
  // STATIC FACTORIES
  // ============================================

  static from(model) {
    return new Query(model)
  }

  static table(name) {
    const query = new Query(null)
    query._table = name
    return query
  }

  static raw(sql, ...params) {
    const query = new Query(null)
    query._state.rawSQL = sql
    query._state.rawParams = params
    return query
  }
}

// Convenience exports
export const from = Query.from
export const table = Query.table
export const raw = Query.raw
