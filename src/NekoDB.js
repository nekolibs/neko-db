import { SQLiteProvider } from 'expo-sqlite'

import { runMigrations } from './migrator'
import { CacheProvider } from './CacheProvider'
import { EmitterBridge } from './EmitterBridge'

export function NekoDB({ children, dbName = 'app.db', models, migrations, ...props }) {
  return (
    <SQLiteProvider databaseName={dbName} onInit={(db) => runMigrations(db, migrations)} {...props}>
      <CacheProvider>
        <EmitterBridge />
        {children}
      </CacheProvider>
    </SQLiteProvider>
  )
}
