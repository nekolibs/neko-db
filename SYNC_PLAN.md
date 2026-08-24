# neko-db Sync Engine — Implementation Plan

Offline-first push/pull sync engine for `@neko-os/db`. Designed 2026-07.

> **Server side is BUILT** (2026-07-10): commit-ordered `version` counter in neko-elixir + `neko gen.sync` in nekocli — see [neko-elixir/docs/sync.md](../neko-elixir/docs/sync.md) for the server adoption guide. Pull cursors use the server `version` column, NOT timestamps (this superseded the original timestamp-cursor design; sections below are updated). Column named plain `version` — a dead `document.version` column (half-built 2024 file-revision feature, write-only, never read) was removed to free the name. Original kora pilot dropped — first backend adoption will be kochy, later. This file covers the MOBILE engine, still to build.

## Core principles (decided, do not relitigate)

1. **Timestamps never leave their birth clock.** Device timestamps (dirty check) compare only against device timestamps. The pull side doesn't use timestamps AT ALL anymore — server `version` counter (below). No offset/diff correction schemes — rejected after analysis (measurement fuzz ±1–2s, mid-session jumps uncovered, no consumer for the corrected values).
2. **Pull cursor = server `version` column** — BIGINT assigned by a commit-ordered counter trigger on the server (never a PG sequence or timestamp; both become visible out of order and permanently skip rows). Versions are unique, monotonic in visibility order → "max version received" is always a safe cursor, keyset pagination for free, no overlap window needed. Built: [neko-elixir/docs/sync.md](../neko-elixir/docs/sync.md).
3. **Push before pull**, always. Soft ordering, not a hard gate — a failing push must never block pulls forever.
4. **Ordering is an optimization; the dirty-skip check is the correctness mechanism.** Pull `store()` must skip locally-dirty rows regardless of when it runs.
5. **LWW whole-record on the server** (bulk upsert, last push wins). No server-side conflict check in v1 — see Deferred (the `version` column makes it cheap later: `base_version` echo).
6. **Client-generated UUIDv7 ids everywhere** (already the case — `models.js:95-97`, `utils/uuid.js`). No id remapping, ever. Any synced model must never use server-generated ids.
7. **Soft delete only** for synced models, both directions — server convention is a `deleted` boolean flag (+ loaders hide `deleted: true` unless `includeDeleted`). neko-db `Model.delete` is a hard DELETE (`models.js:196-214`) — synced models must not use it (convention + runtime guard).
8. **Naming: push/pull** (not mutation/fetcher — collides with `useMutation`).

## Data model

### Columns on every synced model

| Column | Source | Written by | Used for |
|---|---|---|---|
| `localUpdatedAt` TEXT (ISO ms) | device clock | auto-stamp on local writes; `null` on pull-applied writes | dirty check: `localUpdatedAt > lastPushAt` |
| `version` INTEGER | server counter (commit-ordered) | server trigger on every save; reaches the device via pull/echo — never written locally | pull cursor: `version > cursor` |
| `deleted` BOOL | — | soft delete both directions (matches server + existing kora convention) | delete propagation |
| `id` TEXT UUIDv7 | — | client | identity, upsert target |

`updatedAt` keeps existing behavior but plays NO role in sync decisions anymore.

Precision note: `fields.date` serializes day-only (`YYYY-MM-DD`) — sync bookkeeping uses raw ISO strings, never `fields.date`.

### Cursors table (lib-owned)

```sql
CREATE TABLE IF NOT EXISTS _sync_cursors (
  id TEXT PRIMARY KEY,       -- 'push:goals' | 'pull:goals'
  cursor TEXT,               -- device ISO timestamp for push, last received version for pull
  lastSuccessAt TEXT,
  lastError TEXT,
  errorCount INTEGER DEFAULT 0
);
```

Created idempotently in `NekoDB.js` onInit right after `runMigrations` — cannot be a numbered migration because `PRAGMA user_version` is a single app-owned counter (`migrator.js:27-58`). `resetDatabase` (`migrator.js:10-25`) drops it too → automatic full resync (desired; note: unpushed local changes are lost on reset).

## Sync algorithms (final, from design discussion)

### Push (per push definition)

```
1. start = syncNow()                          // device clock, monotonic
2. rows  = SELECT * WHERE localUpdatedAt > cursor('push:<id>')   // dirty
3. if rows empty → done (no API call)
4. send bulk to API (free logic in def) — server upserts LWW, stamps updatedAt = server now()
5. on success: cursor = start                 // START time, NOT end — mid-flight edits stay dirty
6. on failure: nothing changes; retry next cycle. Crash-safe by construction (nothing cleared before confirm)
```

### Pull (per pull definition)

```
1. rows = call API (free logic):
     filter: { version: [{ type: "gt", value: cursor('pull:<id>') }], includeDeleted: true }
     sort: version asc, limit: n, ignoreCache: true
2. store: dirtyIds = ids WHERE localUpdatedAt > cursor('push:<matching model>')
          upsert rows EXCEPT dirtyIds         // protects unpushed edits from echo/remote overwrite
          pulled rows get localUpdatedAt = null (clean), triggers get fromSync: true
3. cursor = last row's version             // server-born by construction, commit-ordered
4. loop while pages come back full (keyset pagination — `page` never used)
```

No overlap window, no serverNow, no clock anywhere on the pull side — version's commit-ordered visibility makes "max received" exact. Full recipe details: [neko-elixir/docs/sync.md](../neko-elixir/docs/sync.md).

### Clock-jump guard

- `syncNow()` = `max(now, lastIssued + 1ms)` — monotonic within session, backward jumps can't produce timestamps below cursor
- At engine start: `if (now < pushCursor) pushCursor = now - 1s` — heals closed-app backward jumps; worst case some clean rows re-flagged dirty → idempotent re-push, LWW shrugs

### Engine orchestration

- `dependsOn` per side → topo sort, cycle detection at registration. Same-level nodes run in parallel (matches the intent in the existing `sync/sync.js` stub).
- **Failure propagation**: node fails → all downstream nodes SKIP this run (e.g. `filesPush` fails → `eventsPush` skips, else event lands on server referencing missing file). Whole subtree retries together next cycle.
- Pulls always run even when pushes failed — dirty-skip protects the failed rows; gating pulls on push success would let one poison row starve the app of updates.
- **Mutex**: one sync run at a time; trigger during a run sets `rerunRequested`, engine loops once more at the end.
- Push batch must be atomic server-side (transaction). Partial-success responses are NOT supported in v1 — cursor advance on partial success would mark failed rows clean.

### Scheduling triggers

- App open (engine start after DbBridge mounts) → sync
- AppState → `active` → sync
- Connectivity restored (NetInfo, **optional peer** — degrade gracefully when absent) → sync
- Interval while foregrounded (configurable)
- Debounced push (~2s) after local writes to synced models (listens on the module emitter; echo-driven emits collect zero dirty rows → no-op, cheap). **Per push def**: a write to model A schedules only A's def(s) + their `dependsOn` closure, each on its own timer. A def sets `autoPush: false` to skip this trigger (still pushed by other triggers / manual push — for chatty edit flows), or `debounce: <sec>` to override the global delay.
- Manual: `sync()`, `push({ ids })`, `pull({ ids })`

## Lib-side changes

### New/replaced files — `libs/neko-db/src/sync/`

Existing stubs (`sync.js` skeleton, empty `fetch.js`/`mutate.js`) get replaced by:

```
src/sync/
├── index.js          # public exports
├── engine.js         # orchestrator: mutex, run loop, topo sort, failure propagation, rerun flag
├── registry.js       # registerPush / registerPull (mirror model registry pattern, models.js:1-17)
├── push.js           # push runner (algorithm above)
├── pull.js           # pull runner + dirty-skip store
├── cursors.js        # _sync_cursors CRUD + clamp-at-start
├── clock.js          # syncNow() monotonic guard
├── DbBridge.js       # null component: bridges db handle to module level (EmitterBridge pattern)
├── triggers.js       # AppState / NetInfo / interval / debounce wiring
└── hooks/
    ├── useSyncStatus.js   # { syncing, lastSyncAt, pendingCount, errors }
    └── useSync.js         # { sync, push, pull }
```

### DbBridge (critical constraint from code map)

- `SQLiteProvider` closes the handle on unmount (`expo-sqlite` hooks) — **never capture the handle**; read `getDb()` per operation, tolerate `null`, `setDb(null)` on cleanup like `EmitterBridge`.
- **Never** open a second connection via `openDatabaseSync` — two native connections to the same file risk `database is locked` (no WAL/busy_timeout configured).
- Engine starts from DbBridge mount (handle guaranteed migrated by then), not at module import.

### Touch points in existing files

| File | Change |
|---|---|
| `models.js` `_applyTimestamps` (39-46) | stamp `localUpdatedAt = syncNow()` for synced models, same presence-check pattern as `updatedAt` — passing the key explicitly suppresses stamping (this is how pull writes stay clean) |
| `query.js` `_execUpdate` (206-221) | same stamp — single choke point ALL update paths flow through (bulk `Query.update` never calls `_applyTimestamps`) |
| `models.js` `Model` constructor | `new Model(name, { fields, sync: true })` — opt-in flag; non-sync models completely untouched |
| `models.js` write pipelines | thread `fromSync: true` into trigger payloads so app triggers can skip side effects (e.g. kora reminder notification scheduling) — pull-applied writes must not blindly re-fire device side effects, but the app decides (a pulled reminder SHOULD schedule its notification) |
| `models.js` `Model.delete` | runtime guard: throw for `sync: true` models — enforce soft delete |
| `NekoDB.js` | `sync` config prop; create `_sync_cursors` in onInit after `runMigrations`; mount `DbBridge` next to `EmitterBridge` |
| `src/index.js` | export sync module (currently `sync/` is not exported at all) |
| `package.json` | `@react-native-community/netinfo` as **optional** peerDependency (`peerDependenciesMeta`, matching the `@neko-os/ui` pattern) — guarded require in `triggers.js` |
| `CLAUDE.md` | document sync module + update "Not Yet Built" |

Pull store writes go through `Model.insertMany(db, rows, { onConflict: { target: 'id', update: 'all' }, fromSync: true })` — emits for free via the module-level emitter (UI updates), `DO UPDATE SET` includes `localUpdatedAt` so the explicit `null` lands. Note existing lib caveat: bulk `Query.update` skips `_serialize` — sync store avoids it by using the insertMany path.

### Push/pull definition shape (app-side API)

```js
// sync/push/goals.js
export const goalsPush = {
  id: 'goals',
  dependsOn: [],
  models: ['goal'],                    // default collect = dirty rows of these models
  push: async ({ rowsByModel }) => {   // free logic — app owns transport
    await api.post('/rest/goals/push', { inputs: rowsByModel.goal })
  },
}

// sync/pull/goals.js
export const goalsPull = {
  id: 'goals',
  dependsOn: [],
  models: ['goal'],
  pull: async ({ cursor }) => {
    const rows = await api.listGoals({
      filter: { version: [{ type: 'gt', value: cursor || 0 }], includeDeleted: true },
      sort: [{ field: 'version', type: 'asc' }],
      limit: 500,
      ignoreCache: true,
    })
    return { rowsByModel: { goal: rows }, cursor: rows.at(-1)?.version, full: rows.length === 500 }
  },
  // store optional — engine default: dirty-skip upsert per model; engine loops while `full`
}
```

Lib owns cursors, dirty logic, ordering, scheduling. App owns endpoints, payload shape, auth headers. Multi-model defs supported (one def, several models) — cursor is per-def, so one failing model store must not advance the shared cursor (store is all-or-nothing per def).

A def may also carry an optional `enabled({ db })` predicate (sync/async): false → the engine skips it for that cycle before collect/pull runs and does not advance the cursor (recorded via `markRun`), so a push's dirty rows stay dirty and a pull resumes from the same cursor once re-enabled. Declarative per-def run condition (e.g. only push while logged in). See README / CLAUDE for the shipped shape.

A **Push** may also tune the write-trigger: `autoPush: false` opts it out of the per-write debounced push (still pushed by other triggers + manual `push()`), and `debounce: <sec>` overrides the global `debouncePush` for that def. See README / CLAUDE for the shipped shape.

## Server contract — BUILT

Server side implemented in neko-elixir + nekocli (2026-07-10), verified on Postgres 17. Full guide: [neko-elixir/docs/sync.md](../neko-elixir/docs/sync.md).

- Per-table adoption: `neko gen.sync <entity> -m <module>` — `version BIGINT` column + index + commit-ordered counter trigger + backfill, model/GraphQL/read-schema fields, test
- Pull = existing list endpoints: `filter: { version: gt cursor, includeDeleted: true }`, sort `version asc`, `ignoreCache: true`
- Push = existing bulk upsert path (array body, `on_conflict` replace by client UUIDv7 id, LWW, atomic per 750-chunk); soft deletes pushed as `deleted: true` upserts
- Soft delete = server's `deleted` boolean convention (not deletedAt)

Remaining server-side gaps (deferred to kochy backend adoption): pull auth for login-less apps (public token + device_id vs per-device secret), actual endpoints wiring per app. Account switching must `resetDatabase` — cursors and rows belong to the previous account.

## Milestones (implementation order)

1. **Infra** — `clock.js`, `cursors.js`, `DbBridge.js`, `_sync_cursors` creation in NekoDB onInit. Verify: cursor CRUD + clamp behavior via a throwaway screen.
2. **Stamping** — `sync: true` model flag, `_applyTimestamps` + `_execUpdate` stamps, `fromSync` trigger payload, `Model.delete` guard. Verify: local writes stamp `localUpdatedAt`; explicit-key writes don't.
3. **Push runner** — dirty collect, cursor = start-time semantics, per-def atomic. Verify: mid-flight edit stays dirty (manual test with delayed fake API).
4. **Pull runner** — version cursor + keyset page loop, dirty-skip store, `localUpdatedAt: null`. Verify: echo does not clobber a pending edit (the 10:00→10:03 trap timeline).
5. **Engine** — topo sort, cycle detection, failure propagation (downstream skip), mutex + rerun flag, clamp at start.
6. **Scheduling** — AppState, NetInfo (optional), interval, debounced push.
7. **React surface** — `NekoDB` `sync` prop, `useSyncStatus`, `useSync`.
8. **Pilot app** (kochy, when its backend exists — kora pilot dropped) —
   - mobile migrations: add `localUpdatedAt`, `version`, `deleted` where missing
   - **convert hard deletes to soft** (e.g. kora `saveGoal.js:43-46` bulk-deletes reminders — invisible to sync)
   - app triggers handle `fromSync` (device side effects like notification scheduling: idempotent identifiers to survive echo)
   - sync defs `push/*.js`, `pull/*.js`; server side per [neko-elixir/docs/sync.md](../neko-elixir/docs/sync.md) (`neko gen.sync` per table + auth decision)
9. **Docs + release** — CLAUDE.md, `yarn build` (dist is stale — web consumers won't see sync exports until rebuilt), yalc publish via `nekom`.

## Deferred to v2 (conscious decisions, revisit later)

| Feature | Why deferred | Notes for future |
|---|---|---|
| **Server conflict check** | "Too much work for now" — LWW accepted | Now cheap thanks to `version`: client echoes each row's last-known `version` as `base_version`; server `ON CONFLICT ... WHERE t.version <= excluded.base_version`; API returns `rejectedIds`; client REFETCHES rejected ids by id (dirty-skip discarded the server version, cursor pulls won't return it again). Per-def `checkConflicts` flag. |
| **Outbox / field-level patches** | Server bulk upsert requires uniform columns across rows (`insert_all`); whole-record LWW accepted | Outbox = separate `_outbox` queue table; enables per-field merge, op ordering, no dirty-flag races by construction. If multi-user clobbering starts hurting, this is the answer. |
| **Realtime** | v1 is interval + event driven | Server push notification "something changed" → trigger `pull()`. Config hook (`realtime` option) can exist as a no-op placeholder. |
| **Background sync (app closed)** | iOS BGTaskScheduler is opportunistic — ~15min floor, skipped for days on rarely-opened apps, never after force-quit. Apple review is fine with it (data sync is the documented use case) — the problem is reliability, not policy | Ship later as pure bonus (daily push shrinks the stale-clobber window). Never a correctness mechanism. |
| **Pull pagination loop** | Kora datasets are small | Response shape already carries `hasMore`. Bootstrap full-fetch on a big dataset is the forcing function. |
| **Tombstone purge / GC** | Soft-deleted rows accumulate | Purging server-side risks resurrection by clients that never learned of the delete. Needs a "min client cursor" or retention-window strategy. |
| **Pull auth for login-less apps** | No pilot backend yet; decide per app (kochy first) | Public token + device_id (spoofable, pilot-grade) vs per-device registration secret. On account switch: `resetDatabase` (wipes rows + cursors → full resync). Warn about unpushed changes. |
| **Retry backoff / poison-row surfacing** | v1: simple retry-next-cycle, `errorCount` in cursors table | If a row fails server validation forever, its whole push def retries forever. `useSyncStatus` should eventually surface persistent errors. |

## Known traps this version does NOT solve (for the record)

1. **LWW whole-record clobber.** Stale offline edit (2 days old) overwrites another user's fresher server changes on push. Accepted deliberately. The v2 conflict check is the fix. Daily background push only shrinks the window, doesn't bound it.
2. ~~**Commit-order hole.**~~ **SOLVED** by the `version` counter — the counter-row lock makes versions visible strictly in commit order (verified: concurrent writer blocks until the earlier transaction commits), so the cursor can never advance past an unseen row. This was the reason timestamps + overlap were abandoned.
3. **Forward clock jump.** Device jumps forward (rows stamped in the future), then corrects back → those rows stay dirty and re-push every cycle until real time passes the stamped time. Idempotent LWW makes this harmless-but-noisy. Monotonic guard prevents the reverse (missed rows), which is the dangerous direction. v2 could detect absurd-future `localUpdatedAt` and rewrite.
4. **Delete-vs-edit conflict.** Device A soft-deletes a row; device B edits it. Row-level LWW: whoever pushes last wins — edit may resurrect the delete or vice versa. No merge semantics.
5. **Cross-device edit ordering.** Two devices editing the same row resolve by push arrival order (LWW), not edit time. Harmless under LWW; recorded for completeness. (Pull-side ties are gone entirely — `version` values are unique.)
6. **Pull echo bandwidth.** Every push causes its rows to return on the next pull (server bumped their `version`). Accepted — idempotent upsert, small payloads. The v2 conflict-check work (push response returns new `version`s) would also enable skipping the echo.
7. **Trigger side effects on pulled writes.** `fromSync` gives app triggers the information, but correctness is the app's responsibility (kora reminders: must use idempotent notification identifiers or echo re-fires scheduling).
8. **Second SQLite connection.** Anything in the app opening its own connection to `app.db` alongside the provider risks lock errors with a background sync loop writing concurrently. Convention: only the bridged handle, ever.
9. **Multi-def cursor granularity.** One def covering several models shares one cursor — a def whose `store` partially applied (crash mid-transaction) relies on the store transaction being atomic. Engine wraps store in `Query.transaction`; keep defs small if in doubt.
