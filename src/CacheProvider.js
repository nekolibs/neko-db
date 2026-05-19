import { createContext, useContext, useMemo } from 'react'

import { NormalizedCache } from './cache'
import { ModelEmitter } from './emitter'

const CacheContext = createContext(null)

export function CacheProvider({ children }) {
  const value = useMemo(() => ({
    cache: new NormalizedCache(),
    emitter: new ModelEmitter(),
  }), [])

  return <CacheContext.Provider value={value}>{children}</CacheContext.Provider>
}

export function useCacheContext() {
  const ctx = useContext(CacheContext)
  if (!ctx) throw new Error('useCacheContext must be used within NekoDB')
  return ctx
}
