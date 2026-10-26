const crypto = require('crypto');

// JSON with object keys sorted, so {"a":1,"b":2} and {"b":2,"a":1} count as the same body.
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function hashBody(body) {
  return crypto.createHash('sha256').update(canonicalJson(body)).digest('hex');
}

/**
 * Takes a transaction-scoped lock on the key, so concurrent requests with the same key
 * run one at a time: the first does the work, the rest see its stored response.
 * Returns the stored record, or null if this key hasn't been used.
 */
async function lockAndLoad(client, key) {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['idem:' + key]);
  const { rows } = await client.query(
    'SELECT request_hash, status_code, response FROM idempotency_keys WHERE key = $1',
    [key]
  );
  return rows[0] || null;
}

async function save(client, key, requestHash, statusCode, response) {
  await client.query(
    `INSERT INTO idempotency_keys (key, request_hash, status_code, response)
     VALUES ($1, $2, $3, $4)`,
    [key, requestHash, statusCode, JSON.stringify(response)]
  );
}

module.exports = { hashBody, lockAndLoad, save, canonicalJson };
