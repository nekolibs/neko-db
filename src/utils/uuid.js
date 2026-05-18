export function generateUUIDv7() {
  const ts = Date.now().toString(16).padStart(12, '0')

  let rand
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const bytes = new Uint8Array(10)
    crypto.getRandomValues(bytes)
    rand = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  } else {
    rand = (Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2)).padEnd(20, '0')
  }

  const randA = rand.slice(0, 3)
  const varNibble = ((parseInt(rand[3], 16) & 0x3) | 0x8).toString(16)
  const randB = varNibble + rand.slice(4, 19)

  const hex = ts + '7' + randA + randB

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-')
}

const UUIDV7_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function isValidUUIDv7(s) {
  return typeof s === 'string' && UUIDV7_REGEX.test(s)
}
