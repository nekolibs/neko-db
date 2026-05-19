import { useEffect } from 'react'

import { useCacheContext } from './CacheProvider'
import { setEmitter } from './models'

export function EmitterBridge() {
  const { emitter } = useCacheContext()

  useEffect(() => {
    setEmitter(emitter)
    return () => setEmitter(null)
  }, [emitter])

  return null
}
