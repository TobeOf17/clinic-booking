# Clinic Booking API

An API that lets patients book clinic appointment slots, plus a web page that uses it.
Built to the [Koya assessment spec](https://koyaacademy.com/assessment-api), levels 1–5.

- **Stack:** Node.js + Express, PostgreSQL (`pg`)
- **Hosting:** Vercel (serverless function) + Neon (Postgres)
- **Web page:** served at `/`; the API is at the root paths below

## Endpoints

Every request needs `X-API-Key`. Every error is `{"error": "<message>"}`.

| Method | Path | Level | Notes |
|---|---|---|---|
| `POST` | `/reset` | 1 | Deletes every booking, replaces all slots |
| `GET` | `/slots?provider=` | 1 | Earliest first, with `available` |
| `POST` | `/bookings` | 1–5 | `201` booking · `400` · `404` · `409` · `422` · `429` |
| `GET` | `/bookings/{id}` | 1 | `404` if unknown |
| `DELETE` | `/bookings/{id}` | 3 | Cancels and frees the slot · `404` · `409` if already cancelled |
| `GET` | `/bookings?email=&limit=&cursor=` | 4 | Oldest first, cursor paging, `limit` 1–50 (default 10) |

## How each level is met

**Level 1.** Slots and bookings live in Postgres, so they persist across requests and
serverless instances. Slot `start`/`end` are echoed back exactly as sent and ordered by
their parsed timestamps.

**Level 2.** Auth runs before the body is parsed, so a bad key is always `401`, and keys
are compared in constant time. Bookings are rejected with `400` for missing, blank or
non-string fields, an invalid email, or a slot that has already started; `404` for an
unknown slot. `name` and `email` are trimmed and `email` is stored in lower case.

**Level 3.** A partial unique index allows only one *confirmed* booking per slot:

```sql
CREATE UNIQUE INDEX bookings_one_confirmed_per_slot ON bookings (slot_id) WHERE status = 'confirmed';
```

Postgres enforces it, so it holds however many requests (or serverless instances) race;
the loser's unique violation becomes `409`. The slot check is part of the same `INSERT`,
so there's no check-then-insert gap. Cancelling is a single conditional `UPDATE`, which
drops the booking out of the index and frees the slot. Tested with 50 simultaneous
requests for one slot: exactly one `201`.

**Level 4.** Responses are stored per `Idempotency-Key` with a hash of the body (key order
ignored). Each request takes a Postgres advisory lock on its key for the length of its
transaction, so simultaneous retries queue up: the first books, the rest replay its
stored response (same status, same booking `id`). Error responses are replayed too. A
reused key with a different body gets `422`. Booking lists use an opaque cursor over
insertion order; the last page has `next_cursor: null`.

**Level 5.** A sliding 60-second window per email, stored in Postgres. A per-email
advisory lock makes check-and-record atomic, so a burst of 20 simultaneous requests lets
exactly 5 through. Failed attempts (validation errors, unknown slots, 409s) count. The
6th gets `429` with `Retry-After` in whole seconds, computed from the oldest attempt in
the window. Rejected attempts aren't recorded, so `Retry-After` is accurate.

### Judgement calls

- **Idempotent replays don't count toward the rate limit.** A retry of a request that
  already happened isn't a new attempt, and replaying the stored response is what the
  level 4 contract promises.
- **`/reset` also clears stored idempotent responses and rate-limit counters**, since
  they refer to bookings that no longer exist.
- **The web page has its own key.** A page in a browser can't keep a secret, so instead
  of embedding `API_KEY`, the server accepts a second `WEB_KEY` that is injected into the
  page and can do everything except `POST /reset` (which returns `403` for it).
  `API_KEY` stays private. The per-email rate limit still applies to the page.

## Run locally

```bash
npm install
cp .env.example .env   # fill in DATABASE_URL, API_KEY, WEB_KEY
export $(cat .env | xargs)
npm start              # http://localhost:3000
npm run seed           # demo slots for the next two weeks
```

The schema is created automatically on the first request.

## Tests

```bash
# against a local database (starts the app in-process)
DATABASE_URL=... API_KEY=... npm test

# against the live deployment
BASE_URL=https://your-app.vercel.app API_KEY=... npm test

# add SLOW=1 to also wait out a rate-limit window (~65s)
```

The tests call `/reset`, which wipes all data. Re-run `npm run seed` afterwards if you
want demo slots back on the page.

## Deploy (Vercel + Neon, both free)

1. **Database.** Create a project at [neon.tech](https://neon.tech) in AWS **US East
   (N. Virginia)** (same area as the Vercel function, `iad1`). Copy the **pooled**
   connection string (host contains `-pooler`).
2. **Code.** Push this repo to GitHub.
3. **Vercel.** Import the repo at [vercel.com/new](https://vercel.com/new). Leave the
   framework as "Other" and the build settings empty. Add environment variables:
   - `DATABASE_URL`: the Neon pooled string
   - `API_KEY`: a long random value (`node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"`)
   - `WEB_KEY`: a different random value
4. Deploy, then check it:
   ```bash
   curl https://your-app.vercel.app/slots -H "X-API-Key: $API_KEY"   # {"slots":[]}
   BASE_URL=https://your-app.vercel.app API_KEY=$API_KEY npm test
   BASE_URL=https://your-app.vercel.app API_KEY=$API_KEY npm run seed
   ```
5. Submit the URL and `API_KEY`. After submitting, don't redeploy or change env vars.

## Project layout

```
api/index.js        Vercel entry point
server.js           Local entry point
src/app.js          Routes
src/db.js           Pool, schema, transactions
src/auth.js         X-API-Key / WEB_KEY check
src/validate.js     Booking validation
src/idempotency.js  Idempotency-Key storage and locking
src/rateLimit.js    Per-email sliding window
public/index.html   Patient web page
scripts/seed.js     Demo slots
test/api.test.js    Spec tests
```
