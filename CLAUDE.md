# @neko-os/db

SQLite ORM for React Native (Expo) apps. Query builder, model system, migrations, and reactive hooks.

## Architecture

```
Component
    ↕ useQuery / useMutation (React hooks)
Normalized Cache (in-memory, entity store by model:id)
    ↕ read / write-through
SQLite (via expo-sqlite, source of truth)
```

NekoDB wraps `SQLiteProvider` + `CacheProvider`. Cache and emitter live in React context. `EmitterBridge` syncs the context emitter to a module-level ref so Model/Query methods can emit without React context.

## Reactive System

- **ModelEmitter** (`emitter.js`): pub/sub by model name. `subscribe(modelName, cb)` returns unsubscribe fn.
- **NormalizedCache** (`cache.js`): entities keyed by `modelName:id`. Queries stored with model list + entity refs. Normalize flattens relationships, denormalize reassembles (including dayjs conversion for date fields).
- **useQuery**: builds cache key from SQL + params + watch. Subscribes to all models the query touches (via `Query.models()`). On model emit, re-executes query from SQLite.
- **useMutation**: wraps a DB operation. Model methods auto-emit on write. `invalidates` option for additional models.

### Emit wiring

Every write path emits after success:
- `Model.insert`, `Model.insertMany`, `Model.update`, `Model.delete` — emit `this.name`
- `Query.update`, `Query.delete` (bulk, no `_skipTriggers`) — emit `this._model.name`
- `_skipTriggers` paths don't emit (called from Model which handles its own emit)

### Query key

Built from SQL + params + optional `watch` object. For model queries uses `_buildSelect()`. For raw queries uses `rawSQL` + `rawParams` directly. Same key = same cache entry.

### queryFn contract

`queryFn` receives `watch` object and returns a Query chain — must NOT call `.all()` or `.first()` (those need `db`). Hook calls `.all(db)` internally. Three hooks: `useQuery` (returns array), `useQueryFirst` (adds `.limit(1)` internally, returns single object or null), `useCount` (adds `.select('COUNT(*) as count')`, returns number). All share `useBaseQuery`.

## Key Files

| File | Purpose |
|------|---------|
| `models.js` | Model class, registry (`getModel`/`registerModels`), emitter bridge (`setEmitter`/`getEmitter`) |
| `query.js` | Immutable chainable query builder. `models()` returns touched model names. `whereIf()` for conditional filters. `dependsOn()` for raw query model deps. |
| `fields.js` | Field types: string, int, bool, json, date (with dayjs serialize), belongsTo, hasMany, hasOne |
| `cache.js` | `NormalizedCache` — normalize/denormalize entities, query result storage |
| `emitter.js` | `ModelEmitter` — simple pub/sub |
| `CacheProvider.js` | React context providing `{ cache, emitter }` |
| `EmitterBridge.js` | Null component that calls `setEmitter(emitter)` on mount |
| `NekoDB.js` | Top-level provider: SQLiteProvider → CacheProvider → EmitterBridge |
| `hooks/useQuery.js` | Reactive query hooks (useQuery, useQueryFirst, useCount) with fetchPolicy, skip, model subscriptions |
| `hooks/useMutation.js` | Mutation hook with invalidates, update, callbacks |
| `hooks/useCache.js` | Direct cache read/write/invalidate |

## Conventions

- Query builder is immutable — every chainable method returns a new Query via `_clone()`
- `db` comes from `useSQLiteContext()` (expo-sqlite). Hooks get it internally; Model methods receive it as first arg.
- Relationships: `belongsTo` stores FK as `{relationName}Id` on the owning model. `hasMany`/`hasOne` look up by `{parentModel}Id` on the related model.
- `fields.date` serializes dayjs → `'YYYY-MM-DD'` for SQLite. Cache denormalize converts back to dayjs.
- Triggers receive raw JS data (before serialization). Serialization happens after triggers.
- Models with no triggers get fast-path writes (no extra SELECT for affected IDs).

## Not Yet Built

- Optimistic updates
- Pagination / infinite scroll
- Cache garbage collection / eviction
- Cache persistence to disk
- Subscription/realtime support
