import { useCallback } from 'react'
import { useSQLiteContext } from 'expo-sqlite'

import { ensureCursorsTable } from '../sync/cursors'
import { getMigrations, resetDatabase, runMigrations } from '../migrator'
import { resetSyncStatus } from '../sync/engine'
import { useCacheContext } from '../CacheProvider'

// Full local wipe that leaves a usable app behind — resetDatabase alone drops every table
// and resets user_version, so on its own it needs a process restart to be survivable.
// Dropping _sync_cursors too means the next cycle is a cursor-less full resync.
// Callers MUST disable sync and unmount live consumers before running this.
export function useResetDatabase() {
  const db = useSQLiteContext()
  const { cache, emitter } = useCacheContext()

  return useCallback(async () => {
    await resetDatabase(db)
    await runMigrations(db, getMigrations())
    await ensureCursorsTable(db) // lib-owned, outside the numbered migrations
    cache.reset() // entities as well as queries — useQuery is cache-first
    resetSyncStatus() // lastSyncAt described the data we just dropped
    emitter.emitAll() // refetch whatever is still mounted
  }, [db, cache, emitter])
}
