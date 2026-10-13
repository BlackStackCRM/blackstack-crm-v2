function camelToSnake(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(camelToSnake);
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    const snakeKey = key.replace(/[A-Z]/g, m => '_' + m.toLowerCase());
    result[snakeKey] = camelToSnake(value);
  }
  return result;
}

function snakeToCamel(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(snakeToCamel);
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    const camelKey = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    result[camelKey] = snakeToCamel(value);
  }
  return result;
}

module.exports = { camelToSnake, snakeToCamel };
