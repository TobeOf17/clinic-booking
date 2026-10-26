const crypto = require('crypto');
const express = require('express');
const db = require('./db');
const { requireApiKey } = require('./auth');
const { validateNewBooking } = require('./validate');
const idempotency = require('./idempotency');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

// ---------- helpers ----------

class HttpError extends Error {
  constructor(status, message, headers) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function toBooking(row) {
  return {
    id: row.id,
    slot_id: row.slot_id,
    name: row.name,
    email: row.email,
    status: row.status,
    created_at: new Date(row.created_at).toISOString(),
  };
}

function newBookingId() {
  return 'bk_' + crypto.randomUUID().replace(/-/g, '');
}

// CORS, so browser-based clients (and checkers) can call the API from another origin.
app.use((req, res, next) => {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-API-Key, Idempotency-Key',
    'Access-Control-Expose-Headers': 'Retry-After',
    'Access-Control-Max-Age': '600',
  });
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// Level 2: auth runs before the body is parsed, so a bad key is always a 401.
app.use(requireApiKey);

app.use(express.json({ limit: '1mb' }));

/**
 * Inserts a confirmed booking. The slot's existence and start time are checked in the
 * same statement as the insert, and the partial unique index turns a double booking
 * into a unique violation, so there is no check-then-insert race.
 * `conn` is a client inside a transaction; a savepoint keeps the transaction usable
 * after a unique violation so the outcome can still be recorded.
 */
async function createBooking(conn, { slot_id, name, email }) {
  let rows;
  await conn.query('SAVEPOINT create_booking');
  try {
    ({ rows } = await conn.query(
      `INSERT INTO bookings (id, slot_id, name, email, status)
       SELECT $1, s.id, $3, $4, 'confirmed'
       FROM slots s
       WHERE s.id = $2 AND s.start_at > clock_timestamp()
       RETURNING *`,
      [newBookingId(), slot_id, name, email]
    ));
    await conn.query('RELEASE SAVEPOINT create_booking');
  } catch (err) {
    await conn.query('ROLLBACK TO SAVEPOINT create_booking');
    if (err.code === '23505') throw new HttpError(409, 'slot is already booked');
    throw err;
  }
  if (rows.length) return toBooking(rows[0]);

  // Nothing inserted: work out why.
  const slot = await conn.query('SELECT 1 FROM slots WHERE id = $1', [slot_id]);
  if (!slot.rows.length) throw new HttpError(404, 'slot not found');
  throw new HttpError(400, 'slot has already started');
}

// ---------- Level 1: reset ----------

app.post('/reset', wrap(async (req, res) => {
  const slots = req.body && req.body.slots;
  if (!Array.isArray(slots)) throw new HttpError(400, 'slots must be an array');

  const seen = new Set();
  const rows = slots.map((s, i) => {
    if (!s || typeof s !== 'object') throw new HttpError(400, `slots[${i}] must be an object`);
    for (const f of ['id', 'provider', 'start', 'end']) {
      if (typeof s[f] !== 'string' || s[f].trim() === '') {
        throw new HttpError(400, `slots[${i}].${f} is required`);
      }
    }
    if (Number.isNaN(Date.parse(s.start)) || Number.isNaN(Date.parse(s.end))) {
      throw new HttpError(400, `slots[${i}] has an invalid start or end`);
    }
    if (seen.has(s.id)) throw new HttpError(400, `duplicate slot id ${s.id}`);
    seen.add(s.id);
    return s;
  });

  await db.tx(async (c) => {
    // Stored idempotent responses point at bookings that no longer exist, so they go too.
    await c.query('TRUNCATE bookings, slots, idempotency_keys');
    if (rows.length) {
      await c.query(
        `INSERT INTO slots (id, provider, start_raw, end_raw, start_at, end_at)
         SELECT x.id, x.provider, x.start_raw, x.end_raw, x.start_raw::timestamptz, x.end_raw::timestamptz
         FROM jsonb_to_recordset($1::jsonb) AS x(id text, provider text, start_raw text, end_raw text)`,
        [JSON.stringify(rows.map((s) => ({ id: s.id, provider: s.provider, start_raw: s.start, end_raw: s.end })))]
      );
    }
  });

  res.status(200).json({ ok: true, slots: rows.length });
}));

// ---------- Level 1: list slots ----------

app.get('/slots', wrap(async (req, res) => {
  const provider = typeof req.query.provider === 'string' ? req.query.provider : null;
  const { rows } = await db.query(
    `SELECT s.id, s.provider, s.start_raw, s.end_raw,
            NOT EXISTS (SELECT 1 FROM bookings b
                        WHERE b.slot_id = s.id AND b.status = 'confirmed') AS available
     FROM slots s
     WHERE $1::text IS NULL OR s.provider = $1
     ORDER BY s.start_at, s.id`,
    [provider]
  );
  res.json({
    slots: rows.map((r) => ({
      id: r.id,
      provider: r.provider,
      start: r.start_raw,
      end: r.end_raw,
      available: r.available,
    })),
  });
}));

// ---------- Level 1: book a slot ----------

// Runs the booking itself and returns { status, body } instead of throwing,
// so every outcome (including errors) can be stored against an Idempotency-Key.
async function attemptBooking(client, rawBody) {
  try {
    const { error, value } = validateNewBooking(rawBody);
    if (error) throw new HttpError(400, error);
    return { status: 201, body: await createBooking(client, value) };
  } catch (err) {
    if (err instanceof HttpError) return { status: err.status, body: { error: err.message } };
    throw err;
  }
}

app.post('/bookings', wrap(async (req, res) => {
  const rawKey = req.get('Idempotency-Key');
  const idemKey = rawKey && rawKey.trim() ? rawKey.trim() : null;
  if (idemKey && idemKey.length > 255) throw new HttpError(400, 'Idempotency-Key is too long');
  const requestHash = idemKey ? idempotency.hashBody(req.body) : null;

  const result = await db.tx(async (client) => {
    if (idemKey) {
      const stored = await idempotency.lockAndLoad(client, idemKey);
      if (stored) {
        if (stored.request_hash !== requestHash) {
          return { status: 422, body: { error: 'Idempotency-Key was already used with a different request body' } };
        }
        return { status: stored.status_code, body: stored.response, replayed: true };
      }
    }

    const outcome = await attemptBooking(client, req.body);
    if (idemKey) await idempotency.save(client, idemKey, requestHash, outcome.status, outcome.body);
    return outcome;
  });

  if (result.replayed) res.set('Idempotent-Replayed', 'true');
  res.status(result.status).json(result.body);
}));

// ---------- Level 4: list a person's bookings ----------

const encodeCursor = (seq) => Buffer.from(JSON.stringify({ s: String(seq) })).toString('base64url');
function decodeCursor(cursor) {
  try {
    const { s } = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof s === 'string' && /^\d{1,18}$/.test(s)) return s;
  } catch { /* fall through */ }
  return null;
}

app.get('/bookings', wrap(async (req, res) => {
  const { email, limit: rawLimit, cursor } = req.query;

  if (typeof email !== 'string' || !email.trim()) throw new HttpError(400, 'email is required');

  let limit = 10;
  if (rawLimit !== undefined) {
    if (typeof rawLimit !== 'string' || !/^\d+$/.test(rawLimit)) {
      throw new HttpError(400, 'limit must be a whole number from 1 to 50');
    }
    limit = Number(rawLimit);
    if (limit < 1 || limit > 50) throw new HttpError(400, 'limit must be a whole number from 1 to 50');
  }

  let afterSeq = '0';
  if (cursor !== undefined && cursor !== '') {
    afterSeq = typeof cursor === 'string' ? decodeCursor(cursor) : null;
    if (afterSeq === null) throw new HttpError(400, 'cursor is not valid');
  }

  // Emails are stored lower-cased, so lower-casing the query makes the match case-insensitive.
  const { rows } = await db.query(
    `SELECT * FROM bookings
     WHERE email = $1 AND seq > $2::bigint
     ORDER BY seq
     LIMIT $3`,
    [email.trim().toLowerCase(), afterSeq, limit + 1]
  );

  const page = rows.slice(0, limit);
  res.json({
    bookings: page.map(toBooking),
    next_cursor: rows.length > limit ? encodeCursor(page[page.length - 1].seq) : null,
  });
}));

// ---------- Level 1: get a booking ----------

app.get('/bookings/:id', wrap(async (req, res) => {
  const { rows } = await db.query('SELECT * FROM bookings WHERE id = $1', [req.params.id]);
  if (!rows.length) throw new HttpError(404, 'booking not found');
  res.json(toBooking(rows[0]));
}));

// ---------- Level 3: cancel a booking ----------

app.delete('/bookings/:id', wrap(async (req, res) => {
  // A single conditional UPDATE, so two simultaneous cancels can't both succeed.
  const { rows } = await db.query(
    `UPDATE bookings SET status = 'cancelled'
     WHERE id = $1 AND status = 'confirmed'
     RETURNING *`,
    [req.params.id]
  );
  if (rows.length) return res.json(toBooking(rows[0]));

  const existing = await db.query('SELECT status FROM bookings WHERE id = $1', [req.params.id]);
  if (!existing.rows.length) throw new HttpError(404, 'booking not found');
  throw new HttpError(409, 'booking is already cancelled');
}));

// ---------- fallbacks ----------

app.use((req, res) => res.status(404).json({ error: 'not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof HttpError) {
    if (err.headers) res.set(err.headers);
    return res.status(err.status).json({ error: err.message });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'request body must be valid JSON' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'request body too large' });
  }
  console.error(err);
  res.status(500).json({ error: 'internal server error' });
});

module.exports = app;
module.exports.HttpError = HttpError;
