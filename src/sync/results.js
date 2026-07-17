// A push/pull returns its transport result (e.g. an Apollo { data, errors }).
// If it carries errors, the runner throws — so the cursor is NOT advanced and
// the rows stay dirty for retry. This is what stops a server-rejected push from
// being silently marked clean (Apollo's errorPolicy: 'all' resolves instead of
// throwing, so without this the failed rows would be lost).
//
// A def may also just `throw` — that blocks too. This only adds the "returned
// { errors } → throw formatted" path.
export function assertNoErrors(result, defId) {
  const errors = result?.errors
  const has = Array.isArray(errors) ? errors.length > 0 : !!errors
  if (!has) return

  const message = Array.isArray(errors)
    ? errors.map((e) => e?.message || String(e)).join('; ')
    : String(errors?.message || errors)

  throw new Error(`[sync] "${defId}" returned errors: ${message}`)
}
