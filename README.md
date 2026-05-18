# NekoDB

A lightweight ORM and query builder for Expo SQLite, inspired by Ecto.

## Table of Contents

**ORM & Query Builder**
- [Setup](#setup)
- [Models](#models)
- [Timestamps](#timestamps)
- [Triggers](#triggers)
- [Migrations](#migrations)
- [Query Builder](#query-builder)
- [Write Operations](#write-operations)
- [Operators](#operators)
- [Relationships](#relationships)
- [Raw SQL](#raw-sql)
- [Reset Database](#reset-database)
- [Database Viewer](#database-viewer)

**GraphQL Integration (optional)**
- [GraphQL Integration](#graphql-integration)
  - [GraphQLResolver](#graphqlresolver)
  - [fromGraphQL](#fromgraphql)

---

## Setup

### 1. Install expo-sqlite

```bash
yarn install @neko-os/db
npx expo install expo-sqlite
```

### 2. Wrap your app with NekoDB

```javascript
// App.js
import { NekoDB } from '@neko-os/db'
import { models } from './src/data/models'
import migrations from './src/data/migrations'

export default function App() {
  return (
    <NekoDB models={models} migrations={migrations}>
      {/* Your app */}
    </NekoDB>
  )
}
```

### 3. Access the database in components

```javascript
import { useSQLiteContext } from 'expo-sqlite'

function MyComponent() {
  const db = useSQLiteContext()

  // Use db with queries...
}
```

---

## Models

Models define your data structure and relationships. GraphQL integration is optional — see [GraphQL Integration](#graphql-integration) if you need it.

### Defining a Model

```javascript
import { Model, fields } from '@neko-os/db'

export const GoalModel = new Model('goal', {
  fields: {
    name: fields.string({ required: true }),
    color: fields.string({ default: 'green' }),
    type: fields.string({ default: 'check' }),
    score: fields.int(),
    active: fields.bool(),

    // Relationships
    category: fields.belongsTo('category'),
    updates: fields.hasMany('goalUpdate'),
  },
})
```

### Field Types

| Type | Description |
|------|-------------|
| `fields.string()` | Text field |
| `fields.int()` | Integer field |
| `fields.bool()` | Boolean field |
| `fields.json()` | JSON field — stored as TEXT, auto-serialized/deserialized |
| `fields.belongsTo(model)` | Many-to-one relationship |
| `fields.hasMany(model)` | One-to-many relationship |
| `fields.hasOne(model)` | One-to-one relationship |

### Field Serialization

Fields can define `serialize` and `deserialize` functions to automatically convert values when writing to and reading from the database. The built-in `fields.json()` uses this:

```javascript
// fields.json() stores arrays/objects as TEXT in SQLite
tags: fields.json({ default: [] }),

// Insert — JS array is serialized to JSON string for SQLite
await GoalModel.insert(db, { name: 'Run', tags: ['health', 'cardio'] })
// DB stores: '["health","cardio"]'

// Query — JSON string is deserialized back to JS array
const goal = await GoalModel.get(db, 'some-uuid')
console.log(goal.tags) // ['health', 'cardio']
```

### Custom Fields

Any field can define its own `serialize`/`deserialize`. This lets you create reusable field types or one-off conversions:

```javascript
// Reusable custom field type
const csvField = (...props) => ({
  type: 'csv',
  serialize: (v) => (v != null ? v.join(',') : null),
  deserialize: (v) => (v != null ? v.split(',') : null),
  ...props,
})

// Use in a model
export const TaskModel = new Model('task', {
  fields: {
    name: fields.string({ required: true }),
    assignees: csvField({ default: [] }),
  },
})

// Inline custom field (no factory needed)
export const EventModel = new Model('event', {
  fields: {
    name: fields.string(),
    metadata: {
      type: 'custom',
      serialize: (v) => (v != null ? JSON.stringify(v) : null),
      deserialize: (v) => (v != null ? JSON.parse(v) : null),
    },
  },
})
```

### Registering Models

```javascript
// src/data/models/index.js
import { GoalModel } from './goal'
import { CategoryModel } from './category'
import { registerModels } from '@neko-os/db'

export const models = registerModels([
  GoalModel,
  CategoryModel,
])
```

### Model Shortcuts

Models have built-in methods for common operations:

```javascript
const db = useSQLiteContext()

// Get all records
const goals = await GoalModel.all(db)

// Get by ID
const goal = await GoalModel.get(db, 'a1b2c3d4-...')

// Get first matching
const goal = await GoalModel.first(db, { type: 'check' })

// Insert (auto-generates UUID id)
const newGoal = await GoalModel.insert(db, {
  name: 'Learn Spanish',
  type: 'check',
})

// Update by ID
await GoalModel.update(db, newGoal.id, { name: 'Updated Name' })

// Delete by ID
await GoalModel.delete(db, newGoal.id)

// Start a custom query
const results = await GoalModel.query()
  .where({ type: 'check' })
  .orderBy('name')
  .all(db)
```

---

## Timestamps

Models automatically manage `insertedAt` and `updatedAt` fields on every write operation. This is enabled by default for all models.

### Behavior

| Operation | `insertedAt` | `updatedAt` |
|-----------|-------------|-------------|
| `insert` | Auto-set | Auto-set |
| `insertMany` | Auto-set | Auto-set |
| Upsert (`onConflict`) | Auto-set on new row, preserved on conflict | Auto-set |
| `update` | Not touched | Auto-set |
| Bulk `update` (query) | Not touched | Auto-set |

```javascript
const goal = await GoalModel.insert(db, { name: 'Run' })
console.log(goal.insertedAt) // '2026-01-15T12:00:00.000Z'
console.log(goal.updatedAt)  // '2026-01-15T12:00:00.000Z'

await GoalModel.update(db, goal.id, { name: 'Run 5K' })
// updatedAt is automatically refreshed

// Bulk updates also get timestamps
await from(GoalModel).where({ type: 'check' }).update(db, { color: 'green' })
// updatedAt is set for all affected rows
```

### Explicit Values Take Precedence

If you pass `insertedAt` or `updatedAt` explicitly, the auto-value is skipped:

```javascript
await GoalModel.insert(db, {
  name: 'Imported Goal',
  insertedAt: '2025-06-01T00:00:00.000Z',
  updatedAt: '2025-06-01T00:00:00.000Z',
})
```

### Opting Out

Disable automatic timestamps for a model by setting `timestamps: false`:

```javascript
export const AuditLogModel = new Model('auditLog', {
  fields: { ... },
  timestamps: false,
})
```

---

## Triggers

Models support lifecycle triggers (hooks) that run custom logic before/after write operations. Use cases include cascading deletes, validation, and syncing related data.

### Defining Triggers

```javascript
export const GoalModel = new Model('goal', {
  fields: { ... },

  triggers: {
    // Modify data before insert by returning a new object
    beforeInsert: async ({ data, db }) => {
      return { ...data, score: computeScore(data) }
    },

    // React after insert (e.g. sync related data)
    afterInsert: async ({ data, result, db }) => {
      await syncRelatedData(db, result)
    },

    // Modify data before update
    beforeUpdate: async ({ id, data, db }) => {
      return { ...data, score: computeScore(data) }
    },

    afterUpdate: async ({ id, data, db }) => { },
    beforeDelete: async ({ id, db }) => { },
    afterDelete: async ({ id, db }) => { },
  },
})
```

### Trigger Types

**Per-record triggers** fire once for each affected record:

| Trigger | Context | Can modify? |
|---------|---------|-------------|
| `beforeInsert` | `{ data, db }` | Return new data |
| `afterInsert` | `{ data, result, db }` | No |
| `beforeUpdate` | `{ id, data, db }` | Return new data |
| `afterUpdate` | `{ id, data, db }` | No |
| `beforeDelete` | `{ id, db }` | No |
| `afterDelete` | `{ id, db }` | No |
| `beforeUpsert` | `{ data, db }` | Return new data |
| `afterUpsert` | `{ data, result, db }` | No |

**Batch triggers** fire once per operation, wrapping all per-record triggers:

| Trigger | Context | Can modify? |
|---------|---------|-------------|
| `beforeInsertMany` | `{ data, db }` | Return new array |
| `afterInsertMany` | `{ data, results, db }` | No |
| `beforeUpdateMany` | `{ ids, data, db }` | Return new data |
| `afterUpdateMany` | `{ ids, data, db }` | No |
| `beforeDeleteMany` | `{ ids, db }` | No |
| `afterDeleteMany` | `{ ids, db }` | No |
| `beforeUpsertMany` | `{ data, db }` | Return new array |
| `afterUpsertMany` | `{ data, results, db }` | No |

### Upsert vs Insert

When `onConflict` is present, **upsert** triggers fire instead of insert triggers:

```javascript
// Fires beforeInsert / afterInsert
await GoalModel.insert(db, data)

// Fires beforeUpsert / afterUpsert
await GoalModel.insert(db, data, { onConflict: { target: 'id', update: 'all' } })
```

### Execution Order

Batch triggers **always fire**, even for single operations (with single-item arrays).

**Single operations** (`Model.insert`, `Model.update`, `Model.delete`):

```
beforeOpMany([data]) → beforeOp(data) → SQL → afterOp(data) → afterOpMany([data])
```

**Bulk insert** (`Model.insertMany`):

```
beforeOpMany(allData) → beforeOp(each) → SQL → afterOp(each) → afterOpMany(allData)
```

**Bulk query** (`from(Model).where({...}).update/delete`):

```
SELECT affected IDs → beforeOpMany(ids) → beforeOp(each id) → SQL → afterOp(each id) → afterOpMany(ids)
```

> The extra `SELECT` to find affected IDs only runs when the model has triggers defined. Models without triggers have zero overhead.

### Data in Triggers

`data` is the **raw caller input** — before serialization. This means JSON fields are still JS objects, not strings. Triggers can inspect the full input including non-column keys the caller may have added.

### Bypassing Triggers

`Query.insert` and `Query.insertMany` (static methods) do **not** fire triggers. Use them as an escape hatch when needed:

```javascript
// No triggers
await Query.insert(db, GoalModel, data)

// With triggers
await GoalModel.insert(db, data)
```

---

## Migrations

Migrations manage your database schema changes.

### Creating a Migration

```javascript
// src/data/migrations/001_create_category.js
export default {
  version: 1,
  name: 'createCategoryTable',

  async up(db) {
    await db.execAsync(`
      CREATE TABLE category (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        color TEXT,
        icon TEXT,
        insertedAt TEXT DEFAULT CURRENT_TIMESTAMP,
        updatedAt TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `)
  },
}
```

### Migration with Foreign Keys

```javascript
// src/data/migrations/002_create_goal.js
export default {
  version: 2,
  name: 'createGoalTable',

  async up(db) {
    await db.execAsync(`
      CREATE TABLE goal (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        color TEXT DEFAULT 'green',
        type TEXT DEFAULT 'check',
        categoryId TEXT REFERENCES category(id) ON DELETE SET NULL,
        insertedAt TEXT DEFAULT CURRENT_TIMESTAMP,
        updatedAt TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `)
  },
}
```

### Registering Migrations

```javascript
// src/data/migrations/index.js
import createCategoryTable from './001_create_category'
import createGoalTable from './002_create_goal'

const migrations = [
  createCategoryTable,
  createGoalTable,
]

export default migrations
```

### Migration Features

- **Version tracking**: Uses SQLite's `PRAGMA user_version`
- **Transactions**: Each migration runs in a transaction
- **Foreign keys**: Automatically enabled via `PRAGMA foreign_keys = ON`
- **Sequential**: Migrations run in version order
- **Idempotent**: Already-applied migrations are skipped

---

## Query Builder

The query builder provides a chainable, immutable API for building SQL queries.

### Starting a Query

```javascript
import { from, table, raw } from '@neko-os/db'

// From a model (enables relationships)
from(GoalModel).all(db)

// From a table name (no model features)
table('goal').all(db)

// Raw SQL
raw('SELECT * FROM goal WHERE id = ?', 1).all(db)
```

### Selecting Columns

```javascript
from(GoalModel)
  .select('id', 'name', 'color')
  .all(db)

// With aliases
from(GoalModel)
  .select('id', 'name as title')
  .all(db)
```

### Where Conditions

```javascript
// Simple equality
from(GoalModel)
  .where({ type: 'check' })
  .all(db)

// Multiple conditions (AND)
from(GoalModel)
  .where({ type: 'check', color: 'green' })
  .all(db)

// Chained where (AND)
from(GoalModel)
  .where({ type: 'check' })
  .where({ color: 'green' })
  .all(db)

// OR conditions (each argument is OR'd together)
from(GoalModel)
  .orWhere({ type: 'check' }, { type: 'measure' })
  .all(db)

// OR with NULL — e.g. "endDate >= ? OR endDate IS NULL"
from(GoalModel)
  .orWhere({ endDate: gte('2026-01-01') }, { endDate: null })
  .all(db)

// NULL check
from(GoalModel)
  .where({ categoryId: null })
  .all(db)

// IN clause (array of values)
from(GoalModel)
  .where({ type: ['check', 'measure', 'streak'] })
  .all(db)

// Comparison with array syntax
from(GoalModel)
  .where(['score', '>', 100])
  .all(db)
```

### Ordering

```javascript
from(GoalModel)
  .orderBy('name')
  .all(db)

from(GoalModel)
  .orderBy('insertedAt', 'DESC')
  .all(db)

// Multiple order columns
from(GoalModel)
  .orderBy('type')
  .orderBy('name')
  .all(db)
```

### Pagination

```javascript
// Limit results
from(GoalModel)
  .limit(10)
  .all(db)

// Pagination (page 2, 20 per page)
from(GoalModel)
  .limit(20)
  .offset(20)
  .all(db)
```

### Execution Methods

| Method | Description |
|--------|-------------|
| `all(db)` | Returns all matching rows |
| `first(db)` | Returns first row or `null` |
| `one(db)` | Returns exactly one row, throws if 0 or >1 |
| `count(db)` | Returns count of matching rows |
| `exists(db)` | Returns `true` if any rows match |

```javascript
// Get all
const goals = await from(GoalModel).all(db)

// Get first or null
const goal = await from(GoalModel)
  .where({ type: 'check' })
  .first(db)

// Get exactly one (throws if not found or multiple)
const goal = await from(GoalModel)
  .where({ id: 'some-uuid' })
  .one(db)

// Count
const count = await from(GoalModel)
  .where({ type: 'check' })
  .count(db)

// Check existence
const hasGoals = await from(GoalModel).exists(db)
```

---

## Write Operations

### Insert

```javascript
// Via Model shortcut
const newGoal = await GoalModel.insert(db, {
  name: 'Learn Spanish',
  type: 'check',
  color: 'blue',
})
console.log(newGoal.id) // Auto-generated UUID (e.g. 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d')

// Via Query
import { Query } from '@neko-os/db'
const newGoal = await Query.insert(db, GoalModel, { name: 'Test' })
```

### Insert with Conflict Handling

```javascript
// Skip if conflicts (unique constraint violation)
await GoalModel.insert(db, { name: 'Existing' }, {
  onConflict: 'ignore'
})

// Upsert - update all columns on conflict
await GoalModel.insert(db, { name: 'Existing', color: 'red' }, {
  onConflict: 'replace'
})

// Upsert - update specific columns
await GoalModel.insert(db, data, {
  onConflict: {
    target: 'name',           // unique column to match
    update: ['color', 'type'] // columns to update on conflict
  }
})
```

### Bulk Insert

Bulk inserts use a single multi-row `INSERT` statement for performance.

```javascript
// Insert multiple records
const goals = await GoalModel.insertMany(db, [
  { name: 'Goal 1', type: 'check', color: 'green' },
  { name: 'Goal 2', type: 'measure', color: 'blue' },
  { name: 'Goal 3', type: 'check', color: 'red' },
])
```

### Bulk Insert with Conflict Handling

```javascript
// Skip conflicts
await GoalModel.insertMany(db, data, {
  onConflict: 'ignore'
})

// Upsert - update all columns on conflict
await GoalModel.insertMany(db, data, {
  onConflict: 'replace'
})

// Upsert - update specific columns on conflict
await GoalModel.insertMany(db, data, {
  onConflict: {
    target: 'name',           // unique column
    update: ['color', 'type'] // columns to update
  }
})

// Upsert - update all columns except id and target
await GoalModel.insertMany(db, data, {
  onConflict: {
    target: 'name',
    update: 'all'
  }
})

// Multiple conflict targets (composite unique)
await GoalModel.insertMany(db, data, {
  onConflict: {
    target: ['userId', 'date'],
    update: ['score', 'notes']
  }
})
```

### Conflict Options

| Option | SQL | Description |
|--------|-----|-------------|
| `'ignore'` | `ON CONFLICT DO NOTHING` | Skip conflicting rows |
| `'replace'` | `ON CONFLICT DO UPDATE SET ...` | Update all columns |
| `{ target, update }` | `ON CONFLICT(col) DO UPDATE SET ...` | Update specific columns |

### Update

```javascript
// Update by ID (Model shortcut)
await GoalModel.update(db, 'some-uuid', { name: 'New Name' })

// Bulk update with query
await from(GoalModel)
  .where({ type: 'check' })
  .update(db, { color: 'green' })

// Update with multiple conditions
await from(GoalModel)
  .where({ type: 'check', active: false })
  .update(db, { archived: true })
```

### Delete

```javascript
// Delete by ID (Model shortcut)
await GoalModel.delete(db, 'some-uuid')

// Bulk delete with query (requires where for safety)
await from(GoalModel)
  .where({ type: 'deprecated' })
  .delete(db)

// Delete with conditions
await from(GoalModel)
  .where({ active: false })
  .where(['insertedAt', '<', '2024-01-01'])
  .delete(db)
```

> **Note:** `delete()` requires a `where()` clause to prevent accidental full table deletion.

### Transactions

Wrap multiple operations in a transaction so they all succeed or all roll back.

```javascript
import { Query } from '@neko-os/db'

// If either insert fails, both are rolled back
await Query.transaction(db, async () => {
  const goal = await GoalModel.insert(db, { name: 'Run', type: 'check' })
  await GoalUpdateModel.insert(db, { goalId: goal.id, value: 1, date: '2026-01-15' })
})
```

Any queries, inserts, updates, or deletes inside the callback share the same transaction. If an error is thrown, all changes are rolled back.

---

## Operators

Operators allow comparison expressions in where clauses.

```javascript
import { gt, gte, lt, lte, ne, like, notLike, notIn } from '@neko-os/db'
```

| Operator | SQL | Example |
|----------|-----|---------|
| `gt(value)` | `>` | `{ score: gt(100) }` |
| `gte(value)` | `>=` | `{ score: gte(100) }` |
| `lt(value)` | `<` | `{ score: lt(50) }` |
| `lte(value)` | `<=` | `{ score: lte(50) }` |
| `ne(value)` | `!=` | `{ type: ne('check') }` |
| `like(pattern)` | `LIKE` | `{ name: like('%run%') }` |
| `notLike(pattern)` | `NOT LIKE` | `{ name: notLike('%test%') }` |
| `notIn(array)` | `NOT IN` | `{ id: notIn(['a', 'b', 'c']) }` |

> **Note:** Arrays without an operator produce `IN` clauses: `{ type: ['check', 'measure'] }` → `type IN (?, ?)`. Use `notIn()` for the inverse.

### Examples

```javascript
// Greater than
from(GoalModel)
  .where({ score: gt(100) })
  .all(db)

// LIKE pattern
from(GoalModel)
  .where({ name: like('%running%') })
  .all(db)

// NOT IN — exclude specific IDs
from(ReminderModel)
  .where({ goalId: 'some-uuid', id: notIn(keepIds) })
  .delete(db)

// Combined
from(GoalModel)
  .where({ score: gte(50), score: lte(100) })
  .all(db)
```

---

## Relationships

### Defining Relationships

```javascript
// Goal belongs to Category (goal.categoryId -> category.id)
category: fields.belongsTo('category')

// Goal has many Updates (goal_update.goalId -> goal.id)
updates: fields.hasMany('goalUpdate')

// User has one Profile (profile.userId -> user.id)
profile: fields.hasOne('profile')
```

### JOIN (SQL Join)

Use `join()` when you need to filter or select from related tables.

```javascript
// Inner join
from(GoalModel)
  .join('category')
  .where({ 'category.name': 'Health' })
  .all(db)

// Left join
from(GoalModel)
  .join('category', 'LEFT')
  .all(db)

// Select from joined table
from(GoalModel)
  .join('category')
  .select('goal.*', 'category.name as category_name')
  .all(db)
```

### Explicit JOIN (Without Model Relationship)

```javascript
from(GoalModel)
  .joinTable('category', 'goal.categoryId = category.id', 'LEFT')
  .all(db)

// Complex join condition
from(GoalModel)
  .joinTable('audit_log', 'audit_log.recordId = goal.id AND audit_log.table_name = "goal"')
  .all(db)
```

### Preload (Separate Queries)

Use `preload()` to load related records in separate queries. This is more efficient for `hasMany` relationships as it avoids row multiplication.

```javascript
// Preload belongsTo
const goals = await from(GoalModel)
  .preload('category')
  .all(db)

goals.forEach(goal => {
  console.log(goal.name, goal.category?.name)
})

// Preload hasMany
const goals = await from(GoalModel)
  .preload('updates')
  .all(db)

goals.forEach(goal => {
  console.log(goal.name, goal.updates.length)
})

// Multiple preloads
const goals = await from(GoalModel)
  .preload('category')
  .preload('updates')
  .all(db)
```

### JOIN vs Preload

| Feature | JOIN | Preload |
|---------|------|---------|
| SQL queries | 1 | N+1 (optimized to 2) |
| Filter on related | Yes | No |
| hasMany efficiency | Row duplication | Clean |
| Data attachment | Manual select | Automatic |

---

## Raw SQL

### Fragment

Use `fragment()` for raw SQL expressions within queries.

```javascript
import { fragment, col } from '@neko-os/db'

// Raw SQL in where
from(GoalModel)
  .where(fragment('score > ? AND score < ?', 10, 100))
  .all(db)

// Reference columns with col()
from(GoalModel)
  .where(fragment('lower(?) = ?', col('name'), 'running'))
  .all(db)

// In select
from(GoalModel)
  .select('id', fragment('COUNT(*) as total'))
  .all(db)

// Date functions
from(GoalModel)
  .where(fragment('date(insertedAt) = date(?)', '2024-01-15'))
  .all(db)
```

### Raw Queries

For complex queries (CTEs, UNIONs, etc.), use `raw()`.

```javascript
import { raw } from '@neko-os/db'

// Simple raw query
const goals = await raw(
  'SELECT * FROM goal WHERE type = ?',
  'check'
).all(db)

// Complex query with CTE
const results = await raw(`
  WITH active_goals AS (
    SELECT * FROM goal WHERE active = 1
  )
  SELECT * FROM active_goals WHERE type = ?
`, 'check').all(db)

// Raw with first()
const goal = await raw(
  'SELECT * FROM goal ORDER BY insertedAt DESC LIMIT 1'
).first(db)
```

### Query Without Model

Use `table()` for queries on tables without a model.

```javascript
import { table } from '@neko-os/db'

const logs = await table('audit_log')
  .where({ action: 'create' })
  .orderBy('insertedAt', 'DESC')
  .limit(100)
  .all(db)
```

---

## GraphQL Integration

> **Optional.** Everything above works without GraphQL or Apollo. This section is only needed if you want to add a GraphQL API on top of your models. Requires `@apollo/client` as a peer dependency.

NekoDB integrates with Apollo GraphQL. Models define their own typeDefs and resolvers, which are auto-collected for Apollo.

### Setup

```javascript
// src/utils/apollo/schema.js
import { gql } from '@apollo/client'
import { models } from '../../data/models'
import { collectTypeDefs } from '@neko-os/db'

const baseTypeDefs = gql`
  type Query
  type Mutation
`

export const typeDefs = [baseTypeDefs, ...collectTypeDefs(models)]
```

```javascript
// src/utils/apollo/resolvers.js
import { models } from '../../data/models'
import { collectResolvers } from '@neko-os/db'

export const resolvers = collectResolvers(models)
```

With this setup, adding a new model with `typeDefs` and `resolvers` to the models registry automatically includes them in Apollo.

### GraphQLResolver

Use `GraphQLResolver` to split queries and mutations into individual files. Each resolver defines its schema signature, optional extra types, and the resolver function.

```javascript
import { GraphQLResolver, fromGraphQL, getModel, raw } from '@neko-os/db'

// Simple query
export const goalsQuery = new GraphQLResolver({
  schema: 'goals(initDate: [String]): [Goal!]!',
  resolver: (_, args, { db }, info) => {
    return fromGraphQL(getModel('goal'), info).all(db)
  },
})

// Query with extra types
export const monthlyProgressQuery = new GraphQLResolver({
  schema: 'monthlyProgress(goalId: String, date: [String]): [MonthlyProgress!]!',
  types: `type MonthlyProgress {
    date: String!
    progress: Int!
  }`,
  resolver: (_, { goalId, date }, { db }) => {
    return raw(`SELECT ...`).all(db)
  },
})
```

Wire them into the model:

```javascript
import { Model, fields } from '@neko-os/db'
import { goalsQuery } from './queries/goals'
import { upsertGoalMutation } from './mutations/upsertGoal'

export const GoalModel = new Model('goal', {
  fields: { ... },
  types: `
    type Goal { id: String!, name: String! }
    input GoalInput { name: String }
  `,
  queries: [goalsQuery],
  mutations: [upsertGoalMutation],
})
```

The Model constructor assembles `typeDefs` and `resolvers` from these parts automatically.

#### Folder structure

```
src/data/models/
  goal/
    index.js          // re-exports GoalModel
    model.js          // fields, types, wires queries/mutations
    queries/
      goals.js        // GraphQLResolver
      goal.js
    mutations/
      upsertGoal.js   // GraphQLResolver
      deleteGoal.js
```

#### Using getModel()

Resolver files use `getModel()` to access models, avoiding circular imports:

```javascript
import { getModel } from '@neko-os/db'

const GoalModel = getModel('goal')       // resolved at runtime
const ReminderModel = getModel('reminder')
```

### fromGraphQL

The `fromGraphQL` function reads the GraphQL query's selection set and:
- Selects only requested fields
- Auto-preloads relationships
- Only fetches requested columns from related tables

```javascript
import { fromGraphQL } from '@neko-os/db'

// In your model's resolvers
resolvers: {
  Query: {
    goals: (_, args, { db }, info) => {
      return fromGraphQL(GoalModel, info, {
        where: args.where,
        limit: args.limit,
      }).all(db)
    },

    goal: (_, { id }, { db }, info) => {
      return fromGraphQL(GoalModel, info, { where: { id } }).first(db)
    },
  },
}
```

### How It Works

Given this GraphQL query:

```graphql
query {
  goals {
    id
    name
    category {
      name
      color
    }
  }
}
```

NekoDB generates:

```sql
-- Main query (only requested fields + FK)
SELECT id, name, categoryId FROM goal

-- Preload query (only requested fields from related table)
SELECT id, name, color FROM category WHERE id IN (?, ?, ?)
```

### Options

`fromGraphQL(model, info, options)` accepts:

| Option | Type | Description |
|--------|------|-------------|
| `where` | object | Filter conditions |
| `orderBy` | array/object | Sorting: `['name', 'DESC']` or `{ field: 'name', direction: 'DESC' }` |
| `limit` | number | Limit results |
| `offset` | number | Skip results |

```javascript
fromGraphQL(GoalModel, info, {
  where: { type: 'check', active: true },
  orderBy: ['name', 'ASC'],
  limit: 10,
  offset: 20,
}).all(db)
```

### Schema Example

```graphql
type Query {
  goals(where: GoalFilter, orderBy: OrderBy, limit: Int): [Goal!]!
  goal(id: String!): Goal
}

type Goal {
  id: String!
  name: String!
  color: String
  type: String
  category: Category
  updates: [GoalUpdate!]!
}

type Category {
  id: String!
  name: String!
  color: String
  icon: String
}

input GoalFilter {
  type: String
  active: Boolean
}

input OrderBy {
  field: String!
  direction: String
}
```

### Smart Preloading

Relationships are automatically detected and preloaded:

- **belongsTo**: Fetches parent record(s) via FK
- **hasMany**: Fetches child records in batch
- **hasOne**: Fetches single related record

All preloads use batch loading (`IN` clauses) to prevent N+1 queries.

### Manual Preload Selection

You can also use smart preload selection without GraphQL:

```javascript
from(GoalModel)
  .select('id', 'name')
  .preload('category', { select: ['name', 'color'] })
  .all(db)
```

---

## Reset Database

For development and testing, you can reset the database to a clean state.

### Usage

```javascript
import { useSQLiteContext } from 'expo-sqlite'
import { resetDatabase, runMigrations } from '@neko-os/db'
import migrations from './data/migrations'

function DevTools() {
  const db = useSQLiteContext()

  const handleReset = async () => {
    await resetDatabase(db)
    await runMigrations(db, migrations)
  }

  return <Button onPress={handleReset} title="Reset DB" />
}
```

### What It Does

1. Drops all tables (except SQLite internals)
2. Resets schema version to 0
3. After calling `runMigrations`, recreates tables fresh

---

## Database Viewer

Built-in views for inspecting database content at runtime. Useful for development and debugging.

### Setup

Add the two views to your router:

```javascript
import { ModelListView, ModelDataView } from '@neko-os/db'

<Stack.Screen name="nekodb/models" component={ModelListView} />
<Stack.Screen name="nekodb/model" component={ModelDataView} />
```

Then navigate to the model list from anywhere (e.g. a settings screen):

```javascript
navigation.push('nekodb/models')
```

### ModelListView

Lists all registered models. Tapping a model navigates to its data view.

| Prop | Default | Description |
|------|---------|-------------|
| `dataViewRoute` | `'nekodb/model'` | Route name for the data view screen |

### ModelDataView

Shows all rows in a model's table as formatted JSON. Receives the model name via `route.params.model`.

---

## File Structure

```
@neko-os/db
├── index.js           # Exports
├── models.js          # Model class, fields, GraphQLResolver
├── query.js           # Query builder
├── operators.js       # Comparison operators (gt, gte, lt, lte, ne, like, notLike, notIn)
├── migrator.js        # Migration runner
├── graphql.js         # GraphQL integration (optional)
├── NekoDB.js          # React provider (SQLiteProvider wrapper)
└── views/
    ├── ModelListView.js   # Dev: browse models
    └── ModelDataView.js   # Dev: inspect table data
```

---

## API Reference

### Query Methods (Chainable)

| Method | Description |
|--------|-------------|
| `select(...fields)` | Columns to select |
| `where(conditions)` | Filter conditions (AND) |
| `orWhere(...conditions)` | Filter conditions (OR) |
| `join(relation, type?)` | JOIN via model relationship |
| `joinTable(table, on, type?)` | Explicit JOIN |
| `preload(relation)` | Load related in separate query |
| `orderBy(field, direction?)` | Sort results |
| `limit(n)` | Limit rows |
| `offset(n)` | Skip rows |

### Query Methods (Execution)

| Method | Returns |
|--------|---------|
| `all(db)` | `Promise<Object[]>` |
| `first(db)` | `Promise<Object \| null>` |
| `one(db)` | `Promise<Object>` (throws if not exactly 1) |
| `count(db)` | `Promise<number>` |
| `exists(db)` | `Promise<boolean>` |
| `update(db, data)` | `Promise<{changes: number}>` |
| `delete(db)` | `Promise<{changes: number}>` |

### Static Methods

| Method | Description |
|--------|-------------|
| `Query.from(model)` | Start query from model |
| `Query.table(name)` | Start query from table |
| `Query.raw(sql, ...params)` | Raw SQL query |
| `Query.insert(db, model, data, options?)` | Insert record |
| `Query.insertMany(db, model, dataArray, options?)` | Insert multiple records |
| `Query.transaction(db, fn)` | Run operations in a transaction |

### Model Methods

| Method | Description |
|--------|-------------|
| `query()` | Start a query for this model |
| `all(db)` | Get all records |
| `first(db, where?)` | Get first matching |
| `get(db, id)` | Get by ID |
| `insert(db, data, options?)` | Insert record |
| `insertMany(db, dataArray, options?)` | Insert multiple records |
| `update(db, id, data)` | Update by ID |
| `delete(db, id)` | Delete by ID |

### Utility Functions

| Function | Description |
|----------|-------------|
| `generateId()` | Generate a UUID v4 string for use as a primary key |
| `resetDatabase(db)` | Drop all tables and reset schema version |
| `runMigrations(db, migrations)` | Run pending migrations |
| `collectTypeDefs(models)` | Aggregate typeDefs from registered models |
| `collectResolvers(models)` | Aggregate resolvers from registered models |
