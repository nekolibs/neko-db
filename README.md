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

**Reactive Hooks**
- [useQuery](#usequery)
- [useCount](#usecount)
- [useInfiniteQuery](#useinfinitequery)
- [useMutation](#usemutation)
- [useCache](#usecache)

**Offline Sync**
- [Sync Engine](#sync-engine)
- [Push & Pull Definitions](#push--pull-definitions)
- [SyncProvider](#syncprovider)
- [Sync Hooks](#sync-hooks)

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
import { migrations } from './src/data/migrations'

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

Models define your data structure and relationships.

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
| `fields.date()` | Date field — dayjs ⇄ `'YYYY-MM-DD'` string |
| `fields.json()` | JSON field — stored as TEXT, auto-serialized/deserialized |
| `fields.belongsTo(model, opts?)` | Many-to-one relationship |
| `fields.hasMany(model, opts?)` | One-to-many relationship (supports `opts.polymorphic`) |
| `fields.hasOne(model, opts?)` | One-to-one relationship |

Each helper takes a single options object — e.g. `fields.string({ required: true })`, `fields.int({ default: 0 })`. Note that `required` and `default` are **descriptive metadata**: the actual column constraints (NOT NULL, defaults) live in the migration SQL, which is the source of truth. The options NekoDB acts on are `serialize`/`deserialize` (see below) and relationship options (`polymorphic`).

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
export const createCategoryMigration = {
  version: 1,
  name: 'create_category',

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
export const createGoalMigration = {
  version: 2,
  name: 'create_goal',

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
import { createCategoryMigration } from './001_create_category'
import { createGoalMigration } from './002_create_goal'

export const migrations = [
  createCategoryMigration,
  createGoalMigration,
]
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

// Conditional where (only applied when condition is truthy)
from(GoalModel)
  .whereIf(type, { type })
  .whereIf(date, { date: gte(date) })
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

### Polymorphic Relationships

A `hasMany` can be **polymorphic** — the related table attaches to *any* model through two columns (`{base}Table` + `{base}Id`) instead of a dedicated foreign key. One table (e.g. `document`) can then hold rows for events, pets, anything. Pass `{ polymorphic: '<base>' }`:

```javascript
// On each owner model — e.g. EventModel, PetModel:
documents: fields.hasMany('document', { polymorphic: 'origin' })
```

The related table needs `{base}Table` / `{base}Id` columns (index them together), and the related **model** must declare a matching `{base}Table` field so the preload knows the suffix:

```javascript
export const DocumentModel = new Model('document', {
  fields: {
    originTable: fields.string(),   // owner's table name, e.g. 'event'
    originId: fields.string(),      // owner's id
    uri: fields.string({ required: true }),
  },
})
```

```sql
CREATE TABLE document (
  id TEXT PRIMARY KEY,
  originTable TEXT NOT NULL,   -- owner's table name, e.g. 'event'
  originId TEXT NOT NULL,      -- owner's id
  uri TEXT NOT NULL
);
CREATE INDEX idx_document_origin ON document (originTable, originId);
```

When writing rows, set `{base}Table` to the **owner model's table name** and `{base}Id` to its id:

```javascript
await DocumentModel.insert(db, {
  originTable: 'event',
  originId: event.id,
  uri: '...',
})
```

`preload('documents')` resolves them with `WHERE originTable = '<ownerTable>' AND originId IN (...)`, grouping per owner. Polymorphic relations are **preload-only** — `join()` isn't supported (there's no single FK to join on).

> **Type-column suffix:** the preload picks the suffix from the related model's declared fields — `{base}Table` if present, otherwise the legacy `{base}Type`. So both `originTable`/`originId` and older `resourceType`/`resourceId` shapes work; just declare the matching field on the model.

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

// Preload a polymorphic hasMany (see Polymorphic Relationships)
const events = await from(EventModel)
  .preload('documents')
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

// Raw queries have no model — use dependsOn hook option for reactivity
const { data } = useQuery(
  () => raw(`SELECT ... FROM goalUpdate ...`, goalId),
  { dependsOn: ['goalUpdate'] }
)
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

## useQuery

Reactive data fetching hook backed by SQLite and an in-memory normalized cache. Queries automatically re-execute when mutations change their dependent models.

### Basic Usage

```javascript
import { useQuery } from '@neko-os/db'
import { PetModel } from '../data/models'

function PetsList() {
  const { data: pets, loading, error, refetch } = useQuery(() =>
    PetModel.query().orderBy('name')
  )

  if (loading) return <Loading />
  return pets.map(pet => <PetCard key={pet.id} pet={pet} />)
}
```

### Single Record

```javascript
import { useQueryFirst } from '@neko-os/db'

const { data: pet } = useQueryFirst(
  ({ id }) => PetModel.query().where({ id }),
  { watch: { id } }
)
```

### With Preloaded Relationships

```javascript
const { data: events } = useQuery(() =>
  EventModel.query().preload('pet').orderBy('date', 'DESC')
)
// events[0].pet is auto-loaded
```

### Parameters

| Param | Type | Description |
|-------|------|-------------|
| `queryFn` | `(watch) => Query` | Receives `watch` object, returns a neko-db Query chain. Don't call `.all()`/`.first()` — execution handled internally. Use `useQueryFirst` for single records. |
| `options.fetchPolicy` | `string` | `'cache-first'` (default), `'cache-and-network'`, `'network-only'`, `'cache-only'` |
| `options.skip` | `boolean` | Skip execution when true |
| `options.watch` | `object` | Dependencies passed to `queryFn` and appended to cache key. Query re-runs when watch values change. |
| `options.dependsOn` | `string[]` | Model names to subscribe to for reactivity. Use with `raw()` queries that have no auto-detected model. |
| `options.onCompleted` | `(data) => void` | Called after successful fetch |
| `options.onError` | `(error) => void` | Called on error |

### Returns

| Field | Type | Description |
|-------|------|-------------|
| `data` | `any` | Query result — array for `useQuery`, single object or `null` for `useQueryFirst` |
| `loading` | `boolean` | `true` while fetching |
| `error` | `Error \| null` | Error if query failed |
| `refetch` | `() => Promise` | Force re-fetch from SQLite |

### Fetch Policies

| Policy | Behavior |
|--------|----------|
| `cache-first` | Return cache if available, otherwise fetch. Default. |
| `cache-and-network` | Return cache immediately, also fetch in background. Re-render if data changed. |
| `network-only` | Always fetch from SQLite, update cache. |
| `cache-only` | Only return from cache, never touch SQLite. |

### Auto-Reactivity

`useQuery` detects which models the query touches (base model + preloaded relations). When any `Model.insert`, `update`, or `delete` fires on those models, the query automatically re-executes.

```javascript
// This query subscribes to both 'event' and 'pet' models
const { data } = useQuery(() =>
  EventModel.query().preload('pet')
)

// Any of these will trigger a re-fetch:
await EventModel.insert(db, { ... })
await PetModel.update(db, id, { name: 'New Name' })
```

No `refetchQueries` needed.

---

## useCount

Reactive count hook. Wraps `useQueryFirst` with `SELECT COUNT(*)`.

### Basic Usage

```javascript
import { useCount } from '@neko-os/db'

function GoalStats() {
  const { data: count, loading } = useCount(
    () => GoalModel.query().where({ deleted: false })
  )

  return <Text>{count} active goals</Text>
}
```

### Parameters

Same as `useQueryFirst` — `queryFn` returns a Query chain (don't add `.select()` — `useCount` handles it).

### Returns

| Field | Type | Description |
|-------|------|-------------|
| `data` | `number` | Count value (defaults to 0) |
| `loading` | `boolean` | `true` while fetching |
| `error` | `Error \| null` | Error if query failed |
| `refetch` | `() => Promise` | Force re-fetch |

Auto-reactive like `useQuery` — re-executes when the query's models change.

---

## useInfiniteQuery

Infinite scroll hook. Runs a single reactive query with a growing `LIMIT` window (`page * limit`, no offset) — `fetchMore` widens the window and re-runs the query. Because there's only one query, model invalidations keep the whole visible list consistent: no page accumulation, no deduplication, no cursor drift.

### Basic Usage

```javascript
import { useInfiniteQuery } from '@neko-os/db'

function EventsList() {
  const { result, loading, fetchMore, isFetchingMore } = useInfiniteQuery(
    () => EventModel.query().where({ deleted: false }).orderBy('date', 'DESC'),
    { limit: 20 }
  )

  return (
    <FlatList
      data={result}
      onEndReached={fetchMore}
      onEndReachedThreshold={0.5}
      ListFooterComponent={isFetchingMore ? <Loading /> : null}
    />
  )
}
```

### Parameters

Same as `useQuery`, plus `limit` (page size, default `20`). `queryFn` must NOT call `.limit()` — the hook owns the window. When `watch` changes, the window resets to the first page.

### Returns

Everything `useQuery` returns, plus:

| Field | Type | Description |
|-------|------|-------------|
| `result` | `array` | Query result, `[]` while null |
| `loading` | `boolean` | `true` on initial load / watch change / refetch only — NOT during `fetchMore` |
| `isFetchingMore` | `boolean` | `true` while a `fetchMore` page loads |
| `fetchMore` | `() => void` | Widen the window by one page. No-ops while loading or when `done`. Stable identity — safe for `onEndReached` |
| `canLoadMore` | `boolean` | More rows likely exist |
| `done` | `boolean` | Last query returned fewer rows than the window — list is complete |
| `page` | `number` | Current page (1-based) |
| `limit` | `number` | Page size |

---

## useMutation

Mutation hook for write operations.

### Basic Usage

```javascript
import { useMutation } from '@neko-os/db'
import { PetModel } from '../data/models'

function EditPet() {
  const db = useSQLiteContext()
  const [savePet, { loading }] = useMutation(
    (input) => PetModel.insert(db, input, { onConflict: { target: 'id', update: 'all' } })
  )

  const handleSave = () => savePet({ id, name, type })
}
```

### Parameters

| Param | Type | Description |
|-------|------|-------------|
| `mutationFn` | `(input) => Promise` | The DB operation to execute |
| `options.onCompleted` | `(data) => void` | Called after success |
| `options.onError` | `(error) => void` | Called on error |
| `options.invalidates` | `string[]` | Additional model names to emit change events for |
| `options.update` | `(cache, { data }) => void` | Manual cache update function |

### Returns

`[executeFn, { data, loading, error, reset }]`

| Field | Type | Description |
|-------|------|-------------|
| `executeFn` | `(input) => Promise` | Call to run the mutation |
| `data` | `any` | Last mutation result |
| `loading` | `boolean` | `true` while executing |
| `error` | `Error \| null` | Error if mutation failed |
| `reset` | `() => void` | Reset state to initial |

### Auto-Invalidation

Model write methods (`insert`, `update`, `delete`) automatically emit change events. All `useQuery` hooks subscribed to that model re-execute. No manual `refetchQueries` needed.

Use `invalidates` for side effects that touch models the mutation doesn't directly write to:

```javascript
const [archivePet, state] = useMutation(
  (id) => PetModel.update(db, id, { archived: true }),
  { invalidates: ['event'] }  // also refresh event queries
)
```

---

## useCache

Direct cache access for edge cases.

```javascript
import { useCache } from '@neko-os/db'

function MyComponent() {
  const cache = useCache()

  // Read a single entity from cache
  const pet = cache.read('pet', 'abc-123')

  // Write to cache + notify subscribers
  cache.write('pet', 'abc-123', { id: 'abc-123', name: 'Updated' })

  // Invalidate all queries touching a model
  cache.invalidate('pet')

  // Invalidate everything
  cache.invalidateAll()
}
```

---

## Sync Engine

Offline-first sync between the local SQLite DB and a server. Each synced model is
the source of truth on the device; the engine pushes local changes up and pulls
remote changes down, resolving conflicts so an unpushed local edit is never
silently clobbered.

**The transport is yours.** The engine never talks to a network — your push/pull
definitions own the API calls (Apollo, fetch, anything) and the shape of what's
sent and stored. The engine owns cursors, ordering, one-run-at-a-time, and the
correctness rules (dirty tracking, echo-clobber protection).

### Enabling sync on a model

Set `sync: true`. The engine then auto-stamps a `localUpdatedAt` column on every
local write (this is the "dirty" marker), and **hard deletes are blocked** — synced
models must soft-delete (`deleted: true`) so deletions can propagate.

```javascript
export const PetModel = new Model('pet', {
  sync: true,
  fields: {
    name: fields.string({ required: true }),
    deleted: fields.bool({ default: false }),
    // ...
  },
})
```

The table needs `localUpdatedAt TEXT` plus whatever cursor column the server uses
(commonly a monotonic `version`). Pull-applied writes pass `localUpdatedAt: null`
explicitly so they land "clean" (not re-pushed).

### How it works

- **Push**: collects rows changed since this push's last success (`whereDirty(cursor)`),
  hands them to your `push`. The cursor advances to the push's *start* time — an edit
  made mid-request stays dirty and ships next cycle. Nothing is cleared until the
  server confirms, so a crash mid-push is safe.
- **Pull**: calls your `pull` with the stored cursor, loops pages until one isn't
  full, commits each page + its cursor in one transaction. Storing **skips
  locally-dirty rows** — that's what stops a remote/echo copy from erasing an edit
  you haven't pushed yet.
- **Ordering**: pushes run before pulls; `dependsOn` orders defs within each side
  (same-level in parallel); a failed def skips its dependents that cycle.
- **One run at a time**: a trigger firing mid-run queues exactly one rerun.

### Push & Pull Definitions

Every step is free logic. Register the defs and the app owns the transport.

```javascript
import { Push, Pull, registerPushes, registerPulls } from '@neko-os/db'

export const petsPush = new Push('pets', {
  model: 'pet',                                  // which model's dirty rows this push owns
  dependsOn: [],                                 // other push ids that must run first
  collect: async ({ db, cursor }) => {
    // Read whatever needs pushing. whereDirty(cursor) = rows changed since last push.
    // Return an empty array / null to skip the API call this cycle.
    return PetModel.query().whereDirty(cursor).all(db)
  },
  push: async ({ records, db, cursor }) => {
    // Shape and send however you want.
    await api.upsertPets(records.map(cleanInput))
  },
})

export const petsPull = new Pull('pets', {
  dependsOn: [],
  pull: async ({ cursor, db }) => {
    // Fetch from the server (slow work belongs here, not in store).
    const rows = await api.listPets({ since: cursor })
    // Return your own shape + the next cursor; `full` drives pagination.
    return { rows, cursor: rows.at(-1)?.version, full: rows.length === PAGE }
  },
  store: async ({ db, result, storeRows, dirtyIds }) => {
    // Save to SQLite however you want (any tables, any shape).
    // storeRows(model, rows) is the safe upsert: skips locally-dirty rows,
    // marks stored rows clean, emits for reactivity.
    await storeRows('pet', result.rows)
  },
})

registerPushes([petsPush])
registerPulls([petsPull])
```

`Push` requires `collect` + `push`; `Pull` requires `pull` + `store`. There are no
default behaviors — every step is explicit.

| Push field | Purpose |
|-----------|---------|
| `id` | Unique def id; its cursor is stored under `push:<id>` |
| `model` / `models` | Which model(s)' pending state this push owns (pull-side dirty checks resolve their cursor through it) |
| `dependsOn` | Push ids that must succeed first |
| `collect({ db, cursor })` | Read rows to push; `Model.query().whereDirty(cursor)` is the dirty predicate. Empty/null → skip |
| `push({ records, db, cursor })` | Send to the server |

| Pull field | Purpose |
|-----------|---------|
| `id` | Unique def id; its cursor is stored under `pull:<id>` |
| `dependsOn` | Pull ids that must run first |
| `pull({ cursor, db })` | Fetch a page; return `{ ...anything, cursor, full }` — loop while `full` is true |
| `store({ db, result, storeRows, dirtyIds })` | Persist the page. `storeRows(model, rows)` = safe dirty-skip upsert; `dirtyIds(model)` = the current dirty id set |

### SyncProvider

Sync is opt-in and separate from `NekoDB` (which only provides the DB, bridges, and
the `_sync_cursors` table). Mount `SyncProvider` where it belongs — commonly gated on
an active session:

```javascript
import { SyncProvider } from '@neko-os/db'

function SyncControl() {
  const session = useSession()          // your app's auth
  return <SyncProvider pushes={pushes} pulls={pulls} enabled={!!session?.token} />
}
```

- Registers the defs **once** on mount.
- `enabled` starts/stops the triggers without remounting or re-registering — flip it
  on login/logout and sync follows.

**Config** (`config` prop):

| Option | Default | Description |
|--------|---------|-------------|
| `syncOnStart` | `true` | Run a full cycle when triggers start |
| `interval` | `900` | Seconds between foreground cycles (0 disables) |
| `debouncePush` | `2` | Seconds to debounce a push after a local write (0 disables) |
| `cooldown` | `30` | Skip a foreground/reconnect/interval cycle if the last finished sooner |
| `disabled` | `false` | Hard-off switch |

**Triggers**: sync-on-start, app foreground (`AppState` → `active`), connectivity
restored (`@react-native-community/netinfo`, optional peer — degrades gracefully if
absent), foreground interval, and a debounced push after writes to synced models.

### Sync Hooks

```javascript
import { useSync, useSyncStatus, sync, push, pull } from '@neko-os/db'

// Manual controls + live status
const { sync, push, pull, syncing, lastSyncAt, lastError } = useSync()

// Status only
const { syncing, lastResult, lastError, lastSyncAt } = useSyncStatus()
```

| Export | Description |
|--------|-------------|
| `sync({ pushIds?, pullIds? })` | Run a full cycle (or scoped subset); resolves when done |
| `push({ ids? })` / `pull({ ids? })` | Run only that side |
| `useSyncStatus()` | Reactive `{ syncing, lastResult, lastError, lastSyncAt }` |
| `useSync()` | `useSyncStatus()` fields + `{ sync, push, pull }` |

Manual `sync()`/`push()`/`pull()` calls bypass the `cooldown` (a pull-to-refresh
must always run).

---

## Reset Database

For development and testing, you can reset the database to a clean state.

### Usage

```javascript
import { useSQLiteContext } from 'expo-sqlite'
import { resetDatabase, runMigrations } from '@neko-os/db'
import { migrations } from './data/migrations'

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
├── index.js             # Exports
├── models.js            # Model class, model registry, emitter bridge
├── query.js             # Query builder
├── fields.js            # Field type definitions (string, int, bool, json, date, relationships)
├── operators.js         # Comparison operators (gt, gte, lt, lte, ne, like, notLike, notIn)
├── migrator.js          # Migration runner
├── NekoDB.js            # React provider (SQLite + cache context)
├── CacheProvider.js     # React context for normalized cache + emitter
├── EmitterBridge.js     # Syncs emitter from React context to module scope
├── cache.js             # Normalized entity cache (in-memory)
├── emitter.js           # Model change pub/sub
├── hooks/
│   ├── useQuery.js      # Reactive query hook
│   ├── useMutation.js   # Mutation hook
│   └── useCache.js      # Direct cache access hook
├── sync/                # Offline sync engine
│   ├── engine.js        # Orchestrator: ordering, mutex, run loop
│   ├── push.js          # Push runner (dirty collect → your push)
│   ├── pull.js          # Pull runner (page loop, dirty-skip store, storeRows)
│   ├── defs.js          # Push / Pull declaration classes
│   ├── registry.js      # registerPushes / registerPulls
│   ├── cursors.js       # _sync_cursors table + clamp
│   ├── clock.js         # Monotonic syncNow()
│   ├── triggers.js      # AppState / NetInfo / interval / debounced push
│   ├── DbBridge.js      # Module-level db handle bridge
│   ├── SyncProvider.js  # Registers defs + runs triggers while enabled
│   └── hooks/           # useSyncStatus, useSync
└── views/
    ├── ModelListView.js # Dev: browse models
    └── ModelDataView.js # Dev: inspect table data
```

---

## API Reference

### Query Methods (Chainable)

| Method | Description |
|--------|-------------|
| `select(...fields)` | Columns to select |
| `where(conditions)` | Filter conditions (AND) |
| `whereIf(condition, conditions)` | Conditional where — only applied when condition is truthy |
| `whereDirty(cursor)` | Rows changed since `cursor` (sync: `localUpdatedAt > cursor`, or all locally-written rows when cursor is null) |
| `orWhere(...conditions)` | Filter conditions (OR) |
| `join(relation, type?)` | JOIN via model relationship |
| `joinTable(table, on, type?)` | Explicit JOIN |
| `preload(relation)` | Load related in separate query |
| `orderBy(field, direction?)` | Sort results |
| `limit(n)` | Limit rows |
| `offset(n)` | Skip rows |
| `models()` | Returns model names this query touches (base + preloads) |

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

### Hooks

| Hook | Description |
|------|-------------|
| `useQuery(queryFn, options?)` | Reactive list query — `{ data, loading, error, refetch }` |
| `useQueryFirst(queryFn, options?)` | Reactive single-record query — `{ data, loading, error, refetch }` |
| `useCount(queryFn, options?)` | Reactive count — `{ data: number, loading, error, refetch }` |
| `useInfiniteQuery(queryFn, options?)` | Infinite scroll via growing LIMIT window — adds `{ result, fetchMore, isFetchingMore, canLoadMore, done, page, limit }` |
| `useMutation(mutationFn, options?)` | Mutation — `[executeFn, { data, loading, error, reset }]` |
| `useCache()` | Direct cache access — `{ read, write, invalidate, invalidateAll }` |
| `useSyncStatus()` | Reactive sync status — `{ syncing, lastResult, lastError, lastSyncAt }` |
| `useSync()` | Sync status + controls — `{ sync, push, pull, ...status }` |

### Utility Functions

| Function | Description |
|----------|-------------|
| `generateId()` | Generate a UUID v4 string for use as a primary key |
| `resetDatabase(db)` | Drop all tables and reset schema version |
| `runMigrations(db, migrations)` | Run pending migrations |
