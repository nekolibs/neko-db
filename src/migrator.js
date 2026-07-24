// Registered by <NekoDB> so a reset can rebuild the schema — resetDatabase drops every
// table AND sets user_version = 0, so runMigrations has to re-run from scratch after it.
// Same bridge idiom as setEmitter/setDb.
let _migrations = []

export function setMigrations(migrations) {
  _migrations = migrations || []
}

export function getMigrations() {
  return _migrations
}

async function getSchemaVersion(db) {
  const result = await db.getFirstAsync('PRAGMA user_version')
  return result?.user_version ?? 0
}

async function setSchemaVersion(db, version) {
  await db.execAsync(`PRAGMA user_version = ${version}`)
}

export async function resetDatabase(db) {
  const tables = await db.getAllAsync(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
  )

  await db.execAsync('PRAGMA foreign_keys = OFF')

  for (const { name } of tables) {
    await db.execAsync(`DROP TABLE IF EXISTS "${name}"`)
  }

  await db.execAsync('PRAGMA user_version = 0')
  await db.execAsync('PRAGMA foreign_keys = ON')

  console.log('[RESET] Database cleared')
}

export async function runMigrations(db, migrations) {
  await db.execAsync('PRAGMA foreign_keys = ON')

  const currentVersion = await getSchemaVersion(db)

  const sortedMigrations = [...migrations].sort((a, b) => a.version - b.version)
  const pendingMigrations = sortedMigrations.filter((m) => m.version > currentVersion)

  if (pendingMigrations.length === 0) {
    console.log(`[MIGRATION] Database up to date (version ${currentVersion})`)
    return
  }

  console.log(`[MIGRATION] Running ${pendingMigrations.length} migration(s)...`)

  for (const migration of pendingMigrations) {
    console.log(`[MIGRATION] ${migration.version}: ${migration.name}`)

    try {
      await db.withTransactionAsync(async () => {
        await migration.up(db)
      })

      await setSchemaVersion(db, migration.version)
    } catch (error) {
      throw new Error(`[MIGRATION] ${migration.version} (${migration.name}) failed: ${error.message}`)
    }
  }

  const finalVersion = await getSchemaVersion(db)
  console.log(`[MIGRATION] Complete (version ${finalVersion})`)
}
