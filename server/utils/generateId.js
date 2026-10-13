const { ulid } = require('ulid');

function generateId(prefix = '') {
  const raw = ulid();
  return prefix ? `${prefix}_${raw}` : raw;
}

module.exports = { generateId };
