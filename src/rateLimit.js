const MAX_ATTEMPTS = 5;
const WINDOW_SECONDS = 60;

/**
 * Sliding-window limit: at most MAX_ATTEMPTS booking attempts per email in any
 * WINDOW_SECONDS, failed attempts included. Lives in Postgres so it holds across
 * serverless instances, and takes a per-email transaction lock so a burst of
 * simultaneous requests can't all read "4 so far" and slip through.
 *
 * Returns null if the attempt is allowed (and records it), or { retryAfter } in
 * whole seconds if it isn't. Rejected attempts are not recorded, so Retry-After
 * stays accurate: once it has passed, the next attempt is allowed.
 */
async function checkAndRecord(client, email) {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['rl:' + email]);

  await client.query(
    `DELETE FROM booking_attempts
     WHERE email = $1 AND attempted_at <= clock_timestamp() - make_interval(secs => $2)`,
    [email, WINDOW_SECONDS]
  );

  const { rows } = await client.query(
    `SELECT count(*)::int AS n,
            ceil(extract(epoch FROM min(attempted_at) + make_interval(secs => $2) - clock_timestamp()))::int AS wait
     FROM booking_attempts
     WHERE email = $1`,
    [email, WINDOW_SECONDS]
  );

  if (rows[0].n >= MAX_ATTEMPTS) {
    return { retryAfter: Math.max(1, rows[0].wait || 1) };
  }

  await client.query('INSERT INTO booking_attempts (email) VALUES ($1)', [email]);
  return null;
}

module.exports = { checkAndRecord, MAX_ATTEMPTS, WINDOW_SECONDS };
