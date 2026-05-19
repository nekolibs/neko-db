import { useCallback } from 'react'

import { useCacheContext } from '../CacheProvider'

export function useCache() {
  const { cache, emitter } = useCacheContext()

  const read = useCallback((modelName, id) => {
    return cache.denormalize(modelName, id)
  }, [cache])

  const write = useCallback((modelName, id, data) => {
    cache.writeEntity(modelName, id, data)
    emitter.emit(modelName)
  }, [cache, emitter])

  const invalidate = useCallback((modelName) => {
    cache.invalidateModel(modelName)
    emitter.emit(modelName)
  }, [cache, emitter])

  const invalidateAll = useCallback(() => {
    cache.invalidateAll()
  }, [cache])

  return { read, write, invalidate, invalidateAll }
}
