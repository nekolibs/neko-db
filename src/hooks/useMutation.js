import { useCallback, useRef, useState } from 'react'

import { useCacheContext } from '../CacheProvider'

export function useMutation(mutationFn, options = {}) {
  const { onCompleted, onError, invalidates, update } = options
  const { cache, emitter } = useCacheContext()

  const [state, setState] = useState({ data: null, loading: false, error: null })
  const onCompletedRef = useRef(onCompleted)
  const onErrorRef = useRef(onError)
  onCompletedRef.current = onCompleted
  onErrorRef.current = onError

  const execute = useCallback(async (variables) => {
    setState((prev) => ({ ...prev, loading: true, error: null }))

    try {
      const data = await mutationFn(variables)

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
      onErrorRef.current?.(error)
      throw error
    }
  }, [mutationFn, cache, emitter, invalidates, update])

  const reset = useCallback(() => {
    setState({ data: null, loading: false, error: null })
  }, [])

  return [execute, { ...state, reset }]
}
