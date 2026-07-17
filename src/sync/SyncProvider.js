import { useEffect, useRef } from 'react'

import { setSyncErrorHandler } from './engine'
import { registerPulls, registerPushes } from './registry'
import { startTriggers } from './triggers'

// Null component — registers the sync defs once, then runs the triggers while
// `enabled` is true. Toggling `enabled` (e.g. login/logout) starts/stops the
// triggers without re-registering or remounting.
// Config: { disabled, syncOnStart, interval, debouncePush, cooldown }.
// onError (optional): called on every push/pull failure with (error, { id, kind }) —
// a project decides what to do (e.g. report to analytics). Unset = no-op.
export function SyncProvider({ config, pushes, pulls, enabled = true, onError }) {
  // Keep the latest onError without re-registering; register one stable wrapper.
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError

  useEffect(() => {
    if (pushes) registerPushes(pushes)
    if (pulls) registerPulls(pulls)
    setSyncErrorHandler((error, info) => onErrorRef.current?.(error, info))
    return () => setSyncErrorHandler(null)
  }, [])

  useEffect(() => {
    if (!enabled || config?.disabled) return undefined
    return startTriggers(config || {})
  }, [enabled])

  return null
}
