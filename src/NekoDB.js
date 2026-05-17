import { SQLiteProvider } from 'expo-sqlite'

import { runMigrations } from './migrator'

export function NekoDB({ children, dbName = 'app.db', models, migrations, ...props }) {
  return (
    <SQLiteProvider databaseName={dbName} onInit={(db) => runMigrations(db, migrations)} {...props}>
      {children}
    </SQLiteProvider>
  )
}
