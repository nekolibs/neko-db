export const fields = {
  string(...props) {
    return { type: 'string', ...props }
  },

  int(...props) {
    return {
      type: 'int',
      deserialize: (v) => (v != null ? Math.round(v) : v),
      ...props,
    }
  },

  bool(...props) {
    return { type: 'bool', ...props }
  },

  json(...props) {
    return {
      type: 'json',
      serialize: (v) => (v != null ? JSON.stringify(v) : null),
      deserialize: (v) => (v != null ? JSON.parse(v) : null),
      ...props,
    }
  },

  belongsTo(name, ...props) {
    return { type: 'belongsTo', withModel: name, ...props }
  },

  hasMany(name, ...props) {
    return { type: 'hasMany', withModel: name, ...props }
  },

  hasOne(name, ...props) {
    return { type: 'hasOne', withModel: name, ...props }
  },
}
