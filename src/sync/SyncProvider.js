import { useEffect, useRef } from 'react'

import { setSyncErrorHandler, setSyncHooks } from './engine'
import { registerPulls, registerPushes } from './registry'
import { startTriggers } from './triggers'

// Null component — registers the sync defs once, then runs the triggers while
// `enabled` is true. Toggling `enabled` (e.g. login/logout) starts/stops the
// triggers without re-registering or remounting.
// Config: { disabled, syncOnStart, interval, debouncePush, cooldown }.
// onError (optional): called on every push/pull failure with (error, { id, kind }) —
// a project decides what to do (e.g. report to analytics). Unset = no-op.
// hooks (optional): { before, after } lifecycle callbacks — see engine.setSyncHooks.
export function SyncProvider({ config, pushes, pulls, enabled = true, onError, hooks }) {
  // Keep the latest onError/hooks without re-registering; register stable wrappers.
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError
  const hooksRef = useRef(hooks)
  hooksRef.current = hooks

  useEffect(() => {
    if (pushes) registerPushes(pushes)
    if (pulls) registerPulls(pulls)
    setSyncErrorHandler((error, info) => onErrorRef.current?.(error, info))
    setSyncHooks({
      before: (payload) => hooksRef.current?.before?.(payload),
      after: (payload) => hooksRef.current?.after?.(payload),
    })
    return () => {
      setSyncErrorHandler(null)
      setSyncHooks(null)
    }
  }, [])

  useEffect(() => {
    if (!enabled || config?.disabled) return undefined
    return startTriggers(config || {})
  }, [enabled])

  return null
}
