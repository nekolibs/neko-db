import { useCallback, useEffect, useRef, useState } from 'react'
import { useSQLiteContext } from 'expo-sqlite'

import { useCacheContext } from '../CacheProvider'

// Throws if queryFn throws (e.g. unknown relation in preload) — callers surface
// that as the hook's `error` instead of swallowing it as "no query".
function computeQueryKey(queryFn, watch, prefix) {
  const query = queryFn(watch)
  let sql, params
  if (query._state?.rawSQL) {
    sql = query._state.rawSQL
    params = query._state.rawParams || []
  } else {
    ;({ sql, params } = query._buildSelect())
  }
  const base = (prefix || '') + sql + '|' + JSON.stringify(params)
  if (watch) return base + '|' + JSON.stringify(watch)
  return base
}

function getQueryModels(queryFn, watch) {
  // Swallowing is fine here: only used to set up subscriptions, and a query
  // that can't build already surfaced its error via the queryKey path.
  try {
    return queryFn(watch).models()
  } catch {
    return []
  }
}

function useBaseQuery(queryFn, options, single) {
  const { fetchPolicy = 'cache-first', skip = false, onCompleted, onError, watch, dependsOn } = options
  const db = useSQLiteContext()
  const { cache, emitter } = useCacheContext()

  const [state, setState] = useState({ data: null, loading: !skip, error: null })
  const mountedRef = useRef(true)
  const queryFnRef = useRef(queryFn)
  const watchRef = useRef(watch)
  const dbRef = useRef(db)
  const cacheRef = useRef(cache)
  const onCompletedRef = useRef(onCompleted)
  const onErrorRef = useRef(onError)
  const dependsOnRef = useRef(dependsOn)

  queryFnRef.current = queryFn
  watchRef.current = watch
  dbRef.current = db
  cacheRef.current = cache
  onCompletedRef.current = onCompleted
  onErrorRef.current = onError
  dependsOnRef.current = dependsOn

  const prefix = single ? 'first|' : ''
  let queryKey = null
  let buildError = null
  if (!skip) {
    try {
      queryKey = computeQueryKey(queryFn, watch, prefix)
    } catch (error) {
      buildError = error
    }
  }
  const queryKeyRef = useRef(queryKey)
  queryKeyRef.current = queryKey
  const buildErrorRef = useRef(buildError)
  buildErrorRef.current = buildError
  // queryFn throws a fresh Error object every render — key the effect on the
  // message so it doesn't loop on identity.
  const buildErrorKey = buildError ? buildError.message || String(buildError) : null

  const execute = useCallback(async () => {
    const fn = queryFnRef.current
    const w = watchRef.current
    const currentDb = dbRef.current
    const currentCache = cacheRef.current

    try {
      const key = computeQueryKey(fn, w, prefix)
      const query = fn(w)
      const models = query.models()
      let data

      if (single) {
        const rows = await query.limit(1).all(currentDb)
        data = rows[0] ?? null
      } else {
        data = await query.all(currentDb)
      }

      currentCache.storeQueryResult(key, models, data, dependsOnRef.current)

      if (mountedRef.current) {
        setState({ data, loading: false, error: null })
        onCompletedRef.current?.(data)
      }
    } catch (error) {
      if (mountedRef.current) {
        setState((prev) => ({ ...prev, loading: false, error }))
        onErrorRef.current?.(error)
      }
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  useEffect(() => {
    if (skip) {
      setState({ data: null, loading: false, error: null })
      return
    }

    if (!queryKey) {
      // Key couldn't be built because queryFn threw — surface it, don't
      // silently render an empty result.
      const error = buildErrorRef.current ?? null
      setState({ data: null, loading: false, error })
      if (error) onErrorRef.current?.(error)
      return
    }

    if (fetchPolicy === 'cache-only') {
      const cached = cache.readQueryResult(queryKey)
      setState({ data: cached ?? null, loading: false, error: null })
      return
    }

    if (fetchPolicy === 'cache-first' || fetchPolicy === 'cache-and-network') {
      const cached = cache.readQueryResult(queryKey)
      if (cached !== undefined) {
        setState({ data: cached, loading: false, error: null })
        if (fetchPolicy === 'cache-first') return
      }
    }

    if (fetchPolicy !== 'cache-only') {
      if (fetchPolicy !== 'cache-and-network' || !cache.hasQuery(queryKey)) {
        setState((prev) => ({ ...prev, loading: true }))
      }
      execute()
    }
  }, [skip, fetchPolicy, queryKey, buildErrorKey])

  useEffect(() => {
    if (skip) return

    const queryModels = getQueryModels(queryFnRef.current, watchRef.current)
    const extra = dependsOnRef.current
    const models = extra?.length ? [...new Set([...queryModels, ...extra])] : queryModels
    if (!models.length) return

    const unsubscribes = models.map((model) =>
      emitter.subscribe(model, () => {
        if (fetchPolicy === 'cache-only') {
          const key = queryKeyRef.current
          if (key) {
            const cached = cacheRef.current.readQueryResult(key)
            if (mountedRef.current) setState({ data: cached ?? null, loading: false, error: null })
          }
        } else {
          cacheRef.current.invalidateModel(model)
          execute()
        }
      })
    )

    return () => unsubscribes.forEach((unsub) => unsub())
  }, [skip, queryKey, emitter, fetchPolicy, execute])

  const refetch = useCallback(() => {
    setState((prev) => ({ ...prev, loading: true }))
    return execute()
  }, [execute])

  return { data: state.data, loading: state.loading, error: state.error, refetch }
}

export function useQuery(queryFn, options = {}) {
  return useBaseQuery(queryFn, options, false)
}

export function useQueryFirst(queryFn, options = {}) {
  return useBaseQuery(queryFn, options, true)
}

export function useCount(queryFn, options = {}) {
  const result = useBaseQuery(
    (watch) => queryFn(watch).select('COUNT(*) as count'),
    options,
    true
  )
  return { ...result, data: result.data?.count ?? 0 }
}
