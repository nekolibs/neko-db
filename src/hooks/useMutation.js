import { useCallback, useRef, useState } from 'react'
import { useSQLiteContext } from 'expo-sqlite'
import { useNotifier } from '@neko-os/ui'

import { useCacheContext } from '../CacheProvider'

export function useMutation(mutationFn, options = {}) {
  // notifyError: true (default) shows an error notification on failure;
  // false disables it; an object overrides the notification props.
  // useNotifier is a safe no-op when no NekoUI provider is mounted.
  const { onCompleted, onError, invalidates, update, notifyError = true } = options
  const db = useSQLiteContext()
  const { cache, emitter } = useCacheContext()
  const notifier = useNotifier()

  const [state, setState] = useState({ data: null, loading: false, error: null })
  const onCompletedRef = useRef(onCompleted)
  const onErrorRef = useRef(onError)
  const notifierRef = useRef(notifier)
  const notifyErrorRef = useRef(notifyError)
  onCompletedRef.current = onCompleted
  onErrorRef.current = onError
  notifierRef.current = notifier
  notifyErrorRef.current = notifyError

  const execute = useCallback(async (variables) => {
    setState((prev) => ({ ...prev, loading: true, error: null }))

    try {
      const data = await mutationFn(variables, db)

      if (update) {
        update(cache, { data })
      }

      setState({ data, loading: false, error: null })
      onCompletedRef.current?.(data)

      if (invalidates) {
        for (const model of invalidates) {
          emitter.emit(model)
        }
      }

      return data
    } catch (error) {
      setState((prev) => ({ ...prev, loading: false, error }))

      const notify = notifyErrorRef.current
      if (notify) {
        const custom = typeof notify === 'object' ? notify : null
        // Cover `throw 'some message'` as well as Error objects.
        const message = typeof error === 'string' ? error : error?.message
        notifierRef.current.error({ title: 'Error', description: message, ...custom })
      }

      // Apollo semantics: an onError handler marks the error as handled, so the
      // promise resolves (undefined) instead of rejecting — avoids unhandled
      // rejections from fire-and-forget calls. Without one, rethrow for .catch().
      if (onErrorRef.current) {
        onErrorRef.current(error)
        return
      }
      throw error
    }
  }, [mutationFn, cache, emitter, invalidates, update])

  const reset = useCallback(() => {
    setState({ data: null, loading: false, error: null })
  }, [])

  return [execute, { ...state, reset }]
}
