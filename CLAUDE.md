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
- **useQuery**: builds cache key from SQL + params + watch. Subscribes to all models the query touches (via `Query.models()`) plus any `dependsOn` option. On model emit, re-executes query from SQLite.
- **useMutation**: wraps a DB operation. Model methods auto-emit on write. `invalidates` option for additional models.

### Error handling

- Query hooks: a `queryFn` that throws (at build or execution) surfaces as `error` and calls `onError` — never a silent empty result.
- `useMutation`: errors land in `state.error` and show an error notification by default (`notifyError: false` disables, an object overrides the notification props — handled in the hook, so `_request` files don't need their own `notifier.error` catch). With an `onError` handler the promise resolves (Apollo semantics); without one it rejects, so chain `.catch()`.

### Emit wiring

Every write path emits after success:
- `Model.insert`, `Model.insertMany`, `Model.update`, `Model.delete` — emit `this.name`
- `Query.update`, `Query.delete` (bulk, no `_skipTriggers`) — emit `this._model.name`
- `_skipTriggers` paths don't emit (called from Model which handles its own emit)

### Query key

Built from SQL + params + optional `watch` object. For model queries uses `_buildSelect()`. For raw queries uses `rawSQL` + `rawParams` directly. Same key = same cache entry.

### queryFn contract

`queryFn` receives `watch` object and returns a Query chain — must NOT call `.all()` or `.first()` (those need `db`). Hook calls `.all(db)` internally. Three hooks: `useQuery` (returns array), `useQueryFirst` (adds `.limit(1)` internally, returns single object or null), `useCount` (adds `.select('COUNT(*) as count')`, returns number). All share `useBaseQuery`. `useInfiniteQuery` wraps `useQuery` with a growing LIMIT window (`page * limit`) — its `queryFn` must NOT call `.limit()`; the hook owns the window and exposes `fetchMore`/`isFetchingMore`/`canLoadMore`/`done`.

## Key Files

| File | Purpose |
|------|---------|
| `models.js` | Model class, registry (`getModel`/`registerModels`), emitter bridge (`setEmitter`/`getEmitter`) |
| `query.js` | Immutable chainable query builder. `models()` returns touched model names. `whereIf()` for conditional filters. |
| `fields.js` | Field types: string, int, bool, json, date (dayjs serialize), belongsTo, hasMany, hasOne. Each takes one options object; `hasMany` supports `{ polymorphic }` |
| `cache.js` | `NormalizedCache` — normalize/denormalize entities, query result storage |
| `emitter.js` | `ModelEmitter` — simple pub/sub |
| `CacheProvider.js` | React context providing `{ cache, emitter }` |
| `EmitterBridge.js` | Null component that calls `setEmitter(emitter)` on mount |
| `NekoDB.js` | Top-level provider: SQLiteProvider → CacheProvider → EmitterBridge |
| `hooks/useQuery.js` | Reactive query hooks (useQuery, useQueryFirst, useCount) with fetchPolicy, skip, model subscriptions |
| `hooks/useInfiniteQuery.js` | Infinite scroll hook — growing LIMIT window over useQuery, masks loading during fetchMore |
| `hooks/useMutation.js` | Mutation hook with invalidates, update, callbacks |
| `hooks/useCache.js` | Direct cache read/write/invalidate |

## Conventions

- Query builder is immutable — every chainable method returns a new Query via `_clone()`
- `db` comes from `useSQLiteContext()` (expo-sqlite). Hooks get it internally; Model methods receive it as first arg.
- Relationships: `belongsTo` stores FK as `{relationName}Id` on the owning model. `hasMany`/`hasOne` look up by `{parentModel}Id` on the related model. Polymorphic `hasMany(model, { polymorphic: 'base' })` looks up by `{base}Type`/`{base}Id` instead, where `{base}Type` = the parent's table name (preload-only, no join).
- Field helpers take a single options object: `fields.string({ required: true })`. `required`/`default` are descriptive only — constraints live in migration SQL. NekoDB acts on `serialize`/`deserialize`, `withModel`, and `polymorphic`.
- `fields.date` serializes dayjs → `'YYYY-MM-DD'` for SQLite. Cache denormalize converts back to dayjs.
- Triggers receive raw JS data (before serialization). Serialization happens after triggers.
- Models with no triggers get fast-path writes (no extra SELECT for affected IDs).

## Sync Engine (`src/sync/`)

Offline-first push/pull sync. Design + traps: [SYNC_PLAN.md](SYNC_PLAN.md); server side: `libs/neko-elixir/docs/sync.md`.

- **Opt-in per model**: `new Model('goal', { fields, sync: true })` — stamps `localUpdatedAt` (device clock, monotonic via `syncNow()`) on every local write; hard deletes throw (soft delete only: `deleted: true`). Pull-applied writes pass `localUpdatedAt: null` (presence check suppresses stamping) and `fromSync: true` reaches trigger contexts.
- **Defs are explicit — NO default behaviors** (user decision, do not add defaults back): every `Pull` declares `pull` (API call, free logic, returns `{ cursor, full, ...anything }`) AND `store` (writes SQLite, free logic; `storeRows(model, rows)` handed in = dirty-skip upsert + clean marker); every `Push` declares `collect` (reads SQLite, free logic, any payload shape, null = skip; `collectDirty(model)` handed in) AND `push` (API call, free logic). `model:` on a Push declares which model's pending state it owns (pull-side dirty checks resolve the cursor through it).
- **Push**: dirty = `localUpdatedAt > cursor`; cursor = push START time (mid-flight edits stay dirty); `collectDirty` strips `localUpdatedAt`. **Pull**: opaque server cursor (server `version` column), keyset page loop, per-page transaction; `storeRows` SKIPS locally-dirty rows (correctness mechanism — protects unpushed edits from echo/remote overwrite).
- **Engine**: `dependsOn` topo levels (parallel within level), failure skips downstream subtree, pulls always run after pushes (soft gate), mutex + one queued rerun, cursor clamp at start.
- **Wiring**: `<NekoDB>` provides DB + bridges + `_sync_cursors` only (no sync props). Sync is a separate opt-in provider: mount `<SyncProvider pushes={pushes} pulls={pulls} enabled={bool} config={{ interval, debouncePush, cooldown }} />` where it belongs (e.g. inside the auth tree, `enabled` gated on an active session — toggling `enabled` starts/stops triggers without remounting; defs register once). Triggers: syncOnStart, AppState active, NetInfo reconnect (optional peer), foreground interval (default 15min), debounced push on synced-model emits, cooldown (default 30s) gating rapid full cycles. Hooks: `useSyncStatus`, `useSync`. Cursors in lib-owned `_sync_cursors` (created in NekoDB onInit; `resetDatabase` drops it → full resync).

## Not Yet Built

- Optimistic updates
- Cache garbage collection / eviction
- Cache persistence to disk
- Realtime (push-notification-triggered pulls)
- Sync v2: server conflict check (base_version + rejectedIds + refetch-by-id), tombstone GC, background sync (BGTaskScheduler)
