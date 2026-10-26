const crypto = require('crypto');
const express = require('express');
const db = require('./db');

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

app.use(express.json({ limit: '1mb' }));

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
    await c.query('TRUNCATE bookings, slots');
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

app.post('/bookings', wrap(async (req, res) => {
  const body = req.body || {};
  const { slot_id, name, email } = body;
  const { rows } = await db.query(
    `INSERT INTO bookings (id, slot_id, name, email, status)
     VALUES ($1, $2, $3, $4, 'confirmed') RETURNING *`,
    [newBookingId(), slot_id, name, email]
  );
  res.status(201).json(toBooking(rows[0]));
}));

// ---------- Level 1: get a booking ----------

app.get('/bookings/:id', wrap(async (req, res) => {
  const { rows } = await db.query('SELECT * FROM bookings WHERE id = $1', [req.params.id]);
  if (!rows.length) throw new HttpError(404, 'booking not found');
  res.json(toBooking(rows[0]));
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
