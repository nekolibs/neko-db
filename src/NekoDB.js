import { SQLiteProvider } from 'expo-sqlite'

import { runMigrations, setMigrations } from './migrator'
import { CacheProvider } from './CacheProvider'
import { EmitterBridge } from './EmitterBridge'
import { DbBridge } from './sync/DbBridge'
import { ensureCursorsTable } from './sync/cursors'

// Provides the DB + cache + emitter + db bridge + the _sync_cursors table.
// Sync is opt-in and separate: mount <SyncProvider pushes pulls enabled /> where
// it belongs in the app (e.g. gated on an active session).
export function NekoDB({ children, dbName = 'app.db', models, migrations, ...props }) {
  // In the body, not inside onInit: onInit is async and resolves after children mount, so a
  // descendant calling useResetDatabase() before then would rebuild against an empty list.
  setMigrations(migrations)

  const onInit = async (db) => {
    await runMigrations(db, migrations)
    await ensureCursorsTable(db)
  }

  return (
    <SQLiteProvider databaseName={dbName} onInit={onInit} {...props}>
      <CacheProvider>
        <EmitterBridge />
        <DbBridge />
        {children}
      </CacheProvider>
    </SQLiteProvider>
  )
}
