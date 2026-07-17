import { useEffect } from 'react'

import { registerPulls, registerPushes } from './registry'
import { startTriggers } from './triggers'

// Null component — registers the sync defs once, then runs the triggers while
// `enabled` is true. Toggling `enabled` (e.g. login/logout) starts/stops the
// triggers without re-registering or remounting.
// Config: { disabled, syncOnStart, interval, debouncePush, cooldown }.
export function SyncProvider({ config, pushes, pulls, enabled = true }) {
  useEffect(() => {
    if (pushes) registerPushes(pushes)
    if (pulls) registerPulls(pulls)
  }, [])

  useEffect(() => {
    if (!enabled || config?.disabled) return undefined
    return startTriggers(config || {})
  }, [enabled])

  return null
}
