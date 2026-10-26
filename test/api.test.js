// Spec-conformance tests for every level.
//
//   Local:    DATABASE_URL=... API_KEY=... npm test        (starts the app in-process)
//   Deployed: BASE_URL=https://your-app API_KEY=... npm test
//
// WARNING: these call POST /reset, which wipes all bookings and slots.
// Set SLOW=1 to also wait out a full rate-limit window (~65s).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const KEY = process.env.API_KEY;
if (!KEY) throw new Error('Set API_KEY to run the tests');

let BASE = process.env.BASE_URL && process.env.BASE_URL.replace(/\/$/, '');
let server;

before(async () => {
  if (!BASE) {
    const app = require('../src/app');
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    BASE = `http://127.0.0.1:${server.address().port}`;
  }
});
after(async () => {
  if (server) {
    server.close();
    await require('../src/db').pool.end();
  }
});

async function call(method, path, { body, headers = {}, key = KEY, raw } = {}) {
  const h = { ...headers };
  if (key !== null) h['X-API-Key'] = key;
  if (body !== undefined || raw !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, {
    method,
    headers: h,
    body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}

const uid = () => crypto.randomBytes(4).toString('hex');
const email = (tag) => `${tag}-${uid()}@example.com`;
const future = (mins) => new Date(Date.now() + mins * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');

async function reset(slots) {
  const r = await call('POST', '/reset', { body: { slots } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
}
function makeSlots(n, provider = 'Dr Ade', offsetMins = 60 * 24) {
  return Array.from({ length: n }, (_, i) => ({
    id: `s${i + 1}`,
    provider,
    start: future(offsetMins + i * 30),
    end: future(offsetMins + i * 30 + 30),
  }));
}
const book = (b, headers) => call('POST', '/bookings', { body: b, headers });

function assertError(r, status) {
  assert.equal(r.status, status, `expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  assert.equal(typeof r.body.error, 'string');
}

// ---------------- Level 1 ----------------

test('L1: reset replaces slots; list is ordered by start and filterable', async () => {
  await reset([
    { id: 'b', provider: 'Dr Bisi', start: '2026-12-10T10:00:00Z', end: '2026-12-10T10:30:00Z' },
    { id: 'a', provider: 'Dr Ade', start: '2026-12-10T09:00:00Z', end: '2026-12-10T09:30:00Z' },
    { id: 'old', provider: 'Dr Ade', start: '2020-01-01T09:00:00Z', end: '2020-01-01T09:30:00Z' },
  ]);
  const r = await call('GET', '/slots');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.slots.map((s) => s.id), ['old', 'a', 'b']);
  assert.deepEqual(r.body.slots[1], {
    id: 'a', provider: 'Dr Ade', start: '2026-12-10T09:00:00Z', end: '2026-12-10T09:30:00Z', available: true,
  });

  const f = await call('GET', '/slots?provider=' + encodeURIComponent('Dr Bisi'));
  assert.deepEqual(f.body.slots.map((s) => s.id), ['b']);
  const none = await call('GET', '/slots?provider=dr%20bisi');
  assert.deepEqual(none.body.slots, [], 'provider match is exact');

  await reset([]);
  assert.deepEqual((await call('GET', '/slots')).body.slots, []);
});

test('L1: book a slot, look it up, slot becomes unavailable', async () => {
  await reset(makeSlots(2));
  const r = await book({ slot_id: 's1', name: 'Ada Obi', email: 'ada@example.com' });
  assert.equal(r.status, 201);
  assert.equal(r.body.status, 'confirmed');
  assert.equal(r.body.slot_id, 's1');
  assert.ok(r.body.id && !Number.isNaN(Date.parse(r.body.created_at)));

  const g = await call('GET', `/bookings/${r.body.id}`);
  assert.equal(g.status, 200);
  assert.deepEqual(g.body, r.body);

  const slots = (await call('GET', '/slots')).body.slots;
  assert.equal(slots.find((s) => s.id === 's1').available, false);
  assert.equal(slots.find((s) => s.id === 's2').available, true);

  assertError(await call('GET', '/bookings/does-not-exist'), 404);
});

test('L1: reset deletes every booking', async () => {
  await reset(makeSlots(1));
  const r = await book({ slot_id: 's1', name: 'A', email: email('reset') });
  await reset(makeSlots(1));
  assertError(await call('GET', `/bookings/${r.body.id}`), 404);
  assert.equal((await call('GET', '/slots')).body.slots[0].available, true);
});

// ---------------- Level 2 ----------------

test('L2: missing or wrong API key is 401 on every endpoint', async () => {
  for (const [m, p] of [['GET', '/slots'], ['POST', '/bookings'], ['GET', '/bookings?email=a@b.co'],
    ['GET', '/bookings/x'], ['DELETE', '/bookings/x'], ['POST', '/reset']]) {
    assertError(await call(m, p, { key: null, body: m === 'POST' ? {} : undefined }), 401);
    assertError(await call(m, p, { key: 'wrong', body: m === 'POST' ? {} : undefined }), 401);
  }
  assertError(await call('POST', '/bookings', { key: null, raw: '{not json' }), 401);
});

test('L2: invalid booking details are 400', async () => {
  await reset(makeSlots(1));
  const ok = { slot_id: 's1', name: 'Ada', email: email('val') };
  const cases = [
    {}, { ...ok, slot_id: undefined }, { ...ok, name: undefined }, { ...ok, email: undefined },
    { ...ok, slot_id: '' }, { ...ok, name: '   ' }, { ...ok, email: '' },
    { ...ok, email: 'not-an-email' }, { ...ok, email: 'a@b' }, { ...ok, email: 'a b@c.com' },
    { ...ok, email: '@example.com' }, { ...ok, name: 42 },
  ];
  for (const c of cases) assertError(await book(c), 400);
  assertError(await call('POST', '/bookings', { raw: '{bad json' }), 400);
  assertError(await call('POST', '/bookings', { raw: '[1,2]' }), 400);
  assert.equal((await call('GET', '/slots')).body.slots[0].available, true, 'nothing was booked');
});

test('L2: unknown slot is 404, started slot is 400', async () => {
  await reset([
    { id: 'past', provider: 'Dr Ade', start: '2020-01-01T09:00:00Z', end: '2020-01-01T09:30:00Z' },
    { id: 'now', provider: 'Dr Ade', start: future(-5), end: future(25) },
  ]);
  assertError(await book({ slot_id: 'nope', name: 'A', email: email('x') }), 404);
  assertError(await book({ slot_id: 'past', name: 'A', email: email('x') }), 400);
  assertError(await book({ slot_id: 'now', name: 'A', email: email('x') }), 400);
});

test('L2: name and email are trimmed; email stored lower-case', async () => {
  await reset(makeSlots(1));
  const tag = uid();
  const r = await book({ slot_id: 's1', name: '  Ada Obi  ', email: `  ADA.${tag}@Example.COM ` });
  assert.equal(r.status, 201);
  assert.equal(r.body.name, 'Ada Obi');
  assert.equal(r.body.email, `ada.${tag}@example.com`);
});

// ---------------- Level 3 ----------------

test('L3: a booked slot returns 409', async () => {
  await reset(makeSlots(1));
  assert.equal((await book({ slot_id: 's1', name: 'A', email: email('a') })).status, 201);
  assertError(await book({ slot_id: 's1', name: 'B', email: email('b') }), 409);
});

test('L3: 50 simultaneous requests for one slot -> exactly one booking', async () => {
  await reset(makeSlots(1));
  const results = await Promise.all(Array.from({ length: 50 }, (_, i) =>
    book({ slot_id: 's1', name: `P${i}`, email: email(`race${i}`) })));
  const codes = results.map((r) => r.status);
  assert.equal(codes.filter((c) => c === 201).length, 1, `codes: ${codes}`);
  assert.equal(codes.filter((c) => c === 409).length, 49, `codes: ${codes}`);
});

test('L3: cancel frees the slot; cancelling twice is 409; unknown is 404', async () => {
  await reset(makeSlots(1));
  const b = (await book({ slot_id: 's1', name: 'A', email: email('c') })).body;
  const d = await call('DELETE', `/bookings/${b.id}`);
  assert.equal(d.status, 200);
  assert.equal(d.body.status, 'cancelled');
  assert.equal(d.body.id, b.id);
  assert.equal((await call('GET', `/bookings/${b.id}`)).body.status, 'cancelled');
  assert.equal((await call('GET', '/slots')).body.slots[0].available, true);
  assertError(await call('DELETE', `/bookings/${b.id}`), 409);
  assertError(await call('DELETE', '/bookings/nope'), 404);
  assert.equal((await book({ slot_id: 's1', name: 'B', email: email('c2') })).status, 201);
});

test('L3: simultaneous cancels -> exactly one succeeds', async () => {
  await reset(makeSlots(1));
  const b = (await book({ slot_id: 's1', name: 'A', email: email('cc') })).body;
  const rs = await Promise.all(Array.from({ length: 10 }, () => call('DELETE', `/bookings/${b.id}`)));
  assert.equal(rs.filter((r) => r.status === 200).length, 1);
  assert.equal(rs.filter((r) => r.status === 409).length, 9);
});

// ---------------- Level 4 ----------------

test('L4: same Idempotency-Key + same body replays the same response', async () => {
  await reset(makeSlots(2));
  const key = 'idem-' + uid();
  const body = { slot_id: 's1', name: 'Ada', email: email('idem') };
  const a = await book(body, { 'Idempotency-Key': key });
  const b = await book({ email: body.email, name: body.name, slot_id: body.slot_id }, { 'Idempotency-Key': key });
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  assert.equal(b.body.id, a.body.id);
  const list = await call('GET', `/bookings?email=${encodeURIComponent(body.email)}`);
  assert.equal(list.body.bookings.length, 1);
});

test('L4: simultaneous retries with one key create one booking', async () => {
  await reset(makeSlots(1));
  const key = 'idem-' + uid();
  const body = { slot_id: 's1', name: 'Ada', email: email('idemrace') };
  const rs = await Promise.all(Array.from({ length: 4 }, () => book(body, { 'Idempotency-Key': key })));
  assert.deepEqual(rs.map((r) => r.status), [201, 201, 201, 201]);
  assert.equal(new Set(rs.map((r) => r.body.id)).size, 1);
});

test('L4: same key with a different body is 422', async () => {
  await reset(makeSlots(2));
  const key = 'idem-' + uid();
  const e = email('idem422');
  assert.equal((await book({ slot_id: 's1', name: 'Ada', email: e }, { 'Idempotency-Key': key })).status, 201);
  assertError(await book({ slot_id: 's2', name: 'Ada', email: e }, { 'Idempotency-Key': key }), 422);
  assert.equal((await call('GET', '/slots')).body.slots[1].available, true);
});

test('L4: error responses replay too; different keys are independent', async () => {
  await reset(makeSlots(1));
  const e1 = email('k1');
  assert.equal((await book({ slot_id: 's1', name: 'A', email: e1 }, { 'Idempotency-Key': 'a-' + uid() })).status, 201);
  const key = 'b-' + uid();
  const body = { slot_id: 's1', name: 'B', email: email('k2') };
  assertError(await book(body, { 'Idempotency-Key': key }), 409);
  assertError(await book(body, { 'Idempotency-Key': key }), 409);
});

test('L4: pages through a person\'s bookings oldest first, case-insensitive', async () => {
  await reset(makeSlots(7));
  const e = email('page');
  const ids = [];
  // 5 bookings: the most one email can make per minute (level 5)
  for (let i = 1; i <= 5; i++) {
    const r = await book({ slot_id: `s${i}`, name: 'Pat', email: i % 2 ? e.toUpperCase() : e });
    assert.equal(r.status, 201);
    ids.push(r.body.id);
  }
  // a cancelled booking still belongs to the person
  await call('DELETE', `/bookings/${ids[1]}`);
  await book({ slot_id: 's6', name: 'Other', email: email('other') });

  const seen = [];
  let cursor = null;
  let pages = 0;
  do {
    const q = `/bookings?email=${encodeURIComponent(e.toUpperCase())}&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const r = await call('GET', q);
    assert.equal(r.status, 200);
    assert.ok(r.body.bookings.length <= 2);
    seen.push(...r.body.bookings.map((b) => b.id));
    cursor = r.body.next_cursor;
    pages++;
  } while (cursor);
  assert.deepEqual(seen, ids);
  assert.equal(pages, 3);
});

test('L4: default limit 10, last page next_cursor null, bad limit/cursor 400', async () => {
  await reset(makeSlots(3));
  const e = email('lim');
  for (const s of ['s1', 's2', 's3']) await book({ slot_id: s, name: 'A', email: e });
  const r = await call('GET', `/bookings?email=${e}`);
  assert.equal(r.body.bookings.length, 3);
  assert.equal(r.body.next_cursor, null);
  const exact = await call('GET', `/bookings?email=${e}&limit=3`);
  assert.equal(exact.body.next_cursor, null, 'no empty extra page');
  assert.equal((await call('GET', `/bookings?email=${e}&limit=50`)).status, 200);
  assert.equal((await call('GET', `/bookings?email=${e}&limit=1`)).body.bookings.length, 1);
  for (const l of ['0', '51', '-1', 'abc', '2.5', '']) {
    assertError(await call('GET', `/bookings?email=${e}&limit=${l}`), 400);
  }
  assertError(await call('GET', `/bookings?email=${e}&cursor=garbage`), 400);
  const empty = await call('GET', `/bookings?email=${email('nobody')}`);
  assert.deepEqual(empty.body, { bookings: [], next_cursor: null });
});

// ---------------- Level 5 ----------------

test('L5: 6th attempt in a minute is 429 with Retry-After; failures count', async () => {
  await reset(makeSlots(10));
  const e = email('spam');
  const codes = [];
  for (let i = 0; i < 5; i++) {
    // mix of successes and failures (unknown slot)
    codes.push((await book({ slot_id: i % 2 ? 'nope' : `s${i + 1}`, name: 'S', email: e })).status);
  }
  assert.deepEqual(codes, [201, 404, 201, 404, 201]);
  const r = await book({ slot_id: 's9', name: 'S', email: e });
  assertError(r, 429);
  const ra = r.headers.get('retry-after');
  assert.match(ra, /^\d+$/);
  assert.ok(Number(ra) >= 1 && Number(ra) <= 60, `Retry-After ${ra}`);

  // same email in different case/spacing is the same person
  assertError(await book({ slot_id: 's9', name: 'S', email: `  ${e.toUpperCase()} ` }), 429);
  // other emails are unaffected
  assert.equal((await book({ slot_id: 's9', name: 'T', email: email('other') })).status, 201);
});

test('L5: invalid-email attempts count too', async () => {
  await reset(makeSlots(1));
  const bad = `bad-${uid()}@nodot`;
  for (let i = 0; i < 5; i++) assertError(await book({ slot_id: 's1', name: 'S', email: bad }), 400);
  assertError(await book({ slot_id: 's1', name: 'S', email: bad }), 429);
});

test('L5: a simultaneous burst lets exactly 5 through', async () => {
  await reset(makeSlots(20));
  const e = email('burst');
  const rs = await Promise.all(Array.from({ length: 20 }, (_, i) =>
    book({ slot_id: `s${i + 1}`, name: 'B', email: e })));
  assert.equal(rs.filter((r) => r.status === 201).length, 5);
  assert.equal(rs.filter((r) => r.status === 429).length, 15);
});

test('L5: limit lifts after Retry-After', { skip: !process.env.SLOW && 'set SLOW=1 to run', timeout: 90_000 }, async () => {
  await reset(makeSlots(10));
  const e = email('wait');
  for (let i = 0; i < 5; i++) await book({ slot_id: 'nope', name: 'W', email: e });
  const r = await book({ slot_id: 's1', name: 'W', email: e });
  assertError(r, 429);
  await new Promise((res) => setTimeout(res, Number(r.headers.get('retry-after')) * 1000 + 500));
  assert.equal((await book({ slot_id: 's1', name: 'W', email: e })).status, 201);
});

// ---------------- general ----------------

test('every error is {"error": string} JSON', async () => {
  const r = await call('GET', '/nope');
  assertError(r, 404);
  assert.match(r.headers.get('content-type'), /application\/json/);
});
