import { sync, push, pull } from '../engine'
import { useSyncStatus } from './useSyncStatus'

// Manual controls + live status: { sync, push, pull, syncing, lastResult, lastError, lastSyncAt }
export function useSync() {
  const status = useSyncStatus()

  return { sync, push, pull, ...status }
}
