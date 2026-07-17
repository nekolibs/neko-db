let _lastIssued = 0

// Monotonic device timestamp for localUpdatedAt stamps and push cursors.
// Backward clock jumps mid-session can't produce a timestamp below one
// already issued, so a pending row can never hide behind the push cursor.
export function syncNow() {
  const now = Date.now()
  _lastIssued = now > _lastIssued ? now : _lastIssued + 1
  return new Date(_lastIssued).toISOString()
}
