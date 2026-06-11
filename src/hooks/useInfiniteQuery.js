import { useCallback, useEffect, useRef, useState } from 'react'

import { useQuery } from './useQuery'

// Infinite scroll via a growing LIMIT window: a single reactive query with
// limit = page * pageSize. fetchMore widens the window and re-runs the query,
// so model invalidations keep the whole visible list consistent — no page
// accumulation, no cursor drift. queryFn must NOT call .limit(); the hook owns it.
export function useInfiniteQuery(queryFn, options = {}) {
  const { limit = 20, watch, ...rest } = options

  const watchKey = JSON.stringify(watch ?? null)
  const [pageState, setPageState] = useState({ page: 1, watchKey, fetchingMore: false })

  // Watch (filters) changed → reset the window during render, before useQuery
  // compiles a stale "old page + new filters" key.
  if (pageState.watchKey !== watchKey) {
    setPageState({ page: 1, watchKey, fetchingMore: false })
  }
  const page = pageState.watchKey === watchKey ? pageState.page : 1

  const response = useQuery((w) => queryFn(w).limit(page * limit), { ...rest, watch })
  const { data, loading: baseLoading, error } = response

  // Clear fetchingMore when the widened query settles — on new data/error or
  // on loading flipping back false. The guard matters: deps are unchanged in
  // the commit where fetchMore() sets the flag, and the next commit (loading
  // true) bails here, so the flag only clears once the result actually lands.
  // Covers async execute, sync cache-hits, and memoized-identical data refs.
  useEffect(() => {
    if (baseLoading) return
    setPageState((s) => (s.fetchingMore ? { ...s, fetchingMore: false } : s))
  }, [data, error, baseLoading])

  const result = data ?? []
  const done = data != null && data.length < page * limit
  const canLoadMore = data != null && !done && !baseLoading && !error

  const canLoadMoreRef = useRef(canLoadMore)
  canLoadMoreRef.current = canLoadMore

  // Stable identity — safe to pass straight to onEndReached, which can re-fire.
  const fetchMore = useCallback(() => {
    if (!canLoadMoreRef.current) return
    setPageState((s) => (s.fetchingMore ? s : { ...s, page: s.page + 1, fetchingMore: true }))
  }, [])

  return {
    ...response,
    result,
    loading: baseLoading && !pageState.fetchingMore,
    isFetchingMore: pageState.fetchingMore,
    fetchMore,
    canLoadMore,
    done,
    page,
    limit,
  }
}
