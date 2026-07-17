import { useEffect } from 'react'
import { useSQLiteContext } from 'expo-sqlite'

// SQLiteProvider closes the handle on unmount — never capture it.
// Always read getDb() per operation and tolerate null.
let _db = null

export function setDb(db) {
  _db = db
}

export function getDb() {
  return _db
}

export function DbBridge() {
  const db = useSQLiteContext()

  useEffect(() => {
    setDb(db)
    return () => setDb(null)
  }, [db])

  return null
}
