import { useEffect, useState } from 'react'

import { getSyncStatus, subscribeSyncStatus } from '../engine'

// { syncing, lastResult, lastError, lastSyncAt }
export function useSyncStatus() {
  const [status, setStatus] = useState(getSyncStatus)

  useEffect(() => subscribeSyncStatus(setStatus), [])

  return status
}
