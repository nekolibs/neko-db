import { useCallback, useEffect, useRef, useState } from 'react'
import { useSQLiteContext } from 'expo-sqlite'

import { useCacheContext } from '../CacheProvider'

function computeQueryKey(queryFn, variables, prefix) {
  try {
    const query = queryFn()
    let sql, params
    if (query._state?.rawSQL) {
      sql = query._state.rawSQL
      params = query._state.rawParams || []
    } else {
      ;({ sql, params } = query._buildSelect())
    }
    const base = (prefix || '') + sql + '|' + JSON.stringify(params)
    if (variables) return base + '|' + JSON.stringify(variables)
    return base
  } catch {
    return null
  }
}

function getQueryModels(queryFn) {
  try {
    return queryFn().models()
  } catch {
    return []
  }
}

function useBaseQuery(queryFn, options, single) {
  const { fetchPolicy = 'cache-first', skip = false, onCompleted, onError, variables } = options
  const db = useSQLiteContext()
  const { cache, emitter } = useCacheContext()

  const [state, setState] = useState({ data: null, loading: !skip, error: null })
  const mountedRef = useRef(true)
  const queryFnRef = useRef(queryFn)
  const variablesRef = useRef(variables)
  const dbRef = useRef(db)
  const cacheRef = useRef(cache)
  const onCompletedRef = useRef(onCompleted)
  const onErrorRef = useRef(onError)

  queryFnRef.current = queryFn
  variablesRef.current = variables
  dbRef.current = db
  cacheRef.current = cache
  onCompletedRef.current = onCompleted
  onErrorRef.current = onError

  const prefix = single ? 'first|' : ''
  const queryKey = skip ? null : computeQueryKey(queryFn, variables, prefix)
  const queryKeyRef = useRef(queryKey)
  queryKeyRef.current = queryKey

  const execute = useCallback(async () => {
    const fn = queryFnRef.current
    const vars = variablesRef.current
    const currentDb = dbRef.current
    const currentCache = cacheRef.current
    const key = computeQueryKey(fn, vars, prefix)
    if (!key) return

    try {
      const query = fn()
      const models = query.models()
      let data

      if (single) {
        const rows = await query.limit(1).all(currentDb)
        data = rows[0] ?? null
      } else {
        data = await query.all(currentDb)
      }

      currentCache.storeQueryResult(key, models, data)

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
      setState({ data: null, loading: false, error: null })
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
  }, [skip, fetchPolicy, queryKey])

  useEffect(() => {
    if (skip) return

    const models = getQueryModels(queryFnRef.current)
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
    () => queryFn().select('COUNT(*) as count'),
    options,
    true
  )
  return { ...result, data: result.data?.count ?? 0 }
}
