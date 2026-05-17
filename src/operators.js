// Comparison operators
export const gt = (value) => ({ $op: '>', $value: value })
export const gte = (value) => ({ $op: '>=', $value: value })
export const lt = (value) => ({ $op: '<', $value: value })
export const lte = (value) => ({ $op: '<=', $value: value })
export const ne = (value) => ({ $op: '!=', $value: value })
export const like = (value) => ({ $op: 'LIKE', $value: value })
export const notLike = (value) => ({ $op: 'NOT LIKE', $value: value })

// Array operators
export const notIn = (values) => ({ $notIn: true, $values: values })

// Raw SQL helpers
export function fragment(sql, ...values) {
  return { $fragment: true, sql, values }
}

export function col(name) {
  return { $column: true, name }
}
