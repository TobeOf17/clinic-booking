const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is not set');
}

// Hosted Postgres (Neon, Supabase, Render) needs TLS; a local database usually doesn't.
const isLocal = /@(localhost|127\.0\.0\.1)(:|\/)/.test(connectionString);

const pool = new Pool({
  connectionString,
  ssl: isLocal ? false : { rejectUnauthorized: false },
  // Serverless instances each hold their own pool, so keep it small.
  max: Number(process.env.PG_POOL_MAX) || 5,
  idleTimeoutMillis: 10_000,
});

// Each statement is idempotent so the schema can be applied on every cold start.
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS slots (
     id        TEXT PRIMARY KEY,
     provider  TEXT NOT NULL,
     start_raw TEXT NOT NULL,          -- echoed back exactly as it was sent
     end_raw   TEXT NOT NULL,
     start_at  TIMESTAMPTZ NOT NULL,   -- used for ordering and the "already started" check
     end_at    TIMESTAMPTZ NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS slots_start_idx ON slots (start_at, id)`,
  `CREATE TABLE IF NOT EXISTS bookings (
     seq        BIGSERIAL UNIQUE,      -- insertion order, used for "oldest first"
     id         TEXT PRIMARY KEY,
     slot_id    TEXT NOT NULL,
     name       TEXT NOT NULL,
     email      TEXT NOT NULL,
     status     TEXT NOT NULL CHECK (status IN ('confirmed', 'cancelled')),
     created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
   )`,
  // Level 3: at most one confirmed booking per slot, enforced by the database itself,
  // so it holds no matter how many requests (or serverless instances) race for a slot.
  // Cancelled bookings fall out of the index, which frees the slot.
  `CREATE UNIQUE INDEX IF NOT EXISTS bookings_one_confirmed_per_slot
     ON bookings (slot_id) WHERE status = 'confirmed'`,
  // Level 4: a person's bookings, oldest first.
  `CREATE INDEX IF NOT EXISTS bookings_email_seq_idx ON bookings (email, seq)`,
  // Level 4: the stored response for each Idempotency-Key.
  `CREATE TABLE IF NOT EXISTS idempotency_keys (
     key          TEXT PRIMARY KEY,
     request_hash TEXT NOT NULL,
     status_code  INT NOT NULL,
     response     JSONB NOT NULL,
     created_at   TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
   )`,
  // Level 5: every booking attempt per email, for a sliding one-minute window.
  `CREATE TABLE IF NOT EXISTS booking_attempts (
     id           BIGSERIAL PRIMARY KEY,
     email        TEXT NOT NULL,
     attempted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
   )`,
  `CREATE INDEX IF NOT EXISTS booking_attempts_email_idx ON booking_attempts (email, attempted_at)`,
];

// Every table and index SCHEMA creates. If all of them exist, the schema is up to date.
const SCHEMA_OBJECTS = [
  'slots', 'slots_start_idx', 'bookings', 'bookings_one_confirmed_per_slot',
  'bookings_email_seq_idx', 'idempotency_keys', 'booking_attempts', 'booking_attempts_email_idx',
];

let ready;
function migrate() {
  if (!ready) {
    ready = (async () => {
      // Fast path, taken on every cold start once the schema exists: a catalog lookup that
      // takes no table locks. Running DDL here instead (even CREATE INDEX IF NOT EXISTS,
      // which locks the table before checking) deadlocks against bookings in flight when
      // a traffic burst starts many serverless instances at once.
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM unnest($1::text[]) AS o(name)
         WHERE to_regclass('public.' || o.name) IS NOT NULL`,
        [SCHEMA_OBJECTS]
      );
      if (rows[0].n === SCHEMA_OBJECTS.length) return;

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // First deploy only: serialise instances racing to create the schema.
        await client.query('SELECT pg_advisory_xact_lock(7262201)');
        for (const sql of SCHEMA) await client.query(sql);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    })().catch((err) => {
      ready = undefined; // let the next request retry
      throw err;
    });
  }
  return ready;
}

async function query(text, params) {
  await migrate();
  return pool.query(text, params);
}

// Runs fn(client) inside a transaction and commits, or rolls back if it throws.
async function tx(fn) {
  await migrate();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, tx, migrate };
