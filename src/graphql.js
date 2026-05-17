import { getModel } from './models'
import { Query } from './query'

/**
 * Build a query from GraphQL resolver info
 * Automatically selects only requested fields and preloads relationships
 *
 * @param {Model|string} model - The model to query
 * @param {GraphQLResolveInfo} info - From resolver's 4th argument
 * @param {object} options - Additional query options (where, orderBy, limit, offset)
 */
export function fromGraphQL(model, info, options = {}) {
  const selections = parseSelections(info)
  return buildQuery(model, selections, options)
}

/**
 * Parse GraphQL info into a selection tree
 */
function parseSelections(info) {
  const fieldNode = info.fieldNodes[0]
  return extractFields(fieldNode.selectionSet)
}

function extractFields(selectionSet) {
  if (!selectionSet) return {}

  const fields = {}
  for (const selection of selectionSet.selections) {
    if (selection.kind === 'Field') {
      const name = selection.name.value
      if (name === '__typename') continue
      fields[name] = {
        nested: selection.selectionSet ? extractFields(selection.selectionSet) : null,
      }
    }
    // Handle fragments
    if (selection.kind === 'InlineFragment') {
      Object.assign(fields, extractFields(selection.selectionSet))
    }
  }
  return fields
}

/**
 * Build Query from parsed selections
 */
function buildQuery(model, selections, options = {}) {
  const modelDef = typeof model === 'string' ? getModel(model) : model

  const { scalarFields, relationFields } = categorizeFields(modelDef, selections)

  // Add FK fields for belongsTo relationships
  const fkFields = relationFields.filter((r) => r.relation.type === 'belongsTo').map((r) => `${r.name}Id`)

  // Always include 'id' for preload hydration
  const selectFields = ['id', ...scalarFields, ...fkFields].filter((v, i, a) => a.indexOf(v) === i)

  let query = Query.from(modelDef).select(...selectFields)

  // Add preloads for relationships with nested field selection
  for (const { name, nested } of relationFields) {
    const nestedFields = nested ? Object.keys(nested) : null
    query = query.preload(name, { select: nestedFields })
  }

  // Apply additional options
  if (options.where) query = query.where(options.where)
  if (options.orderBy) {
    const orderByArray = Array.isArray(options.orderBy) ? options.orderBy : [options.orderBy]
    for (const order of orderByArray) {
      if (Array.isArray(order)) {
        query = query.orderBy(order[0], order[1])
      } else if (typeof order === 'object') {
        query = query.orderBy(order.field, order.direction)
      } else {
        query = query.orderBy(order)
      }
    }
  }
  if (options.limit) query = query.limit(options.limit)
  if (options.offset) query = query.offset(options.offset)

  return query
}

function categorizeFields(model, selections) {
  const scalarFields = []
  const relationFields = []

  for (const [fieldName, fieldInfo] of Object.entries(selections)) {
    const fieldDef = model.fields[fieldName]

    if (!fieldDef) {
      // Might be 'id', '__typename', or computed field
      if (fieldName !== '__typename') {
        scalarFields.push(fieldName)
      }
      continue
    }

    if (['belongsTo', 'hasMany', 'hasOne'].includes(fieldDef.type)) {
      if (fieldInfo.nested) {
        relationFields.push({
          name: fieldName,
          relation: fieldDef,
          nested: fieldInfo.nested,
        })
      }
    } else {
      scalarFields.push(fieldName)
    }
  }

  return { scalarFields, relationFields }
}

/**
 * Helper to extract selections without full info object
 * Useful for testing or manual query building
 */
export function parseGraphQLSelections(info) {
  return parseSelections(info)
}

/**
 * Aggregate typeDefs from models object
 */
export function collectTypeDefs(models) {
  return Object.values(models)
    .map((m) => m.typeDefs)
    .filter(Boolean)
}

/**
 * Aggregate resolvers from models object
 */
export function collectResolvers(models) {
  return Object.values(models).reduce(
    (acc, m) => {
      if (!m.resolvers) return acc
      return {
        Query: { ...acc.Query, ...m.resolvers.Query },
        Mutation: { ...acc.Mutation, ...m.resolvers.Mutation },
      }
    },
    { Query: {}, Mutation: {} }
  )
}
