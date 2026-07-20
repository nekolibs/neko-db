// Dev-only sync logging. __DEV__ is a Metro/RN global — stripped as dead code
// from prod bundles, so this is a no-op (and absent) in prod builds.
export function syncLog(...args) {
  if (__DEV__) console.log('[sync]', ...args)
}
