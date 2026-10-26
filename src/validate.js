// Pragmatic email check: one @, no spaces, a dot in the domain, sane lengths.
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

function isValidEmail(email) {
  return typeof email === 'string' && email.length <= 254 && EMAIL_RE.test(email);
}

// Trims spaces; anything that isn't a string (or is blank) comes back as ''.
function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Validates a POST /bookings body.
 * Returns { error } or { value: { slot_id, name, email } } with name/email trimmed
 * and the email lower-cased.
 */
function validateNewBooking(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'request body must be a JSON object' };
  }
  const slot_id = clean(body.slot_id);
  const name = clean(body.name);
  const email = clean(body.email).toLowerCase();

  const missing = [];
  if (!slot_id) missing.push('slot_id');
  if (!name) missing.push('name');
  if (!email) missing.push('email');
  if (missing.length) return { error: `${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} required` };

  if (name.length > 200) return { error: 'name is too long' };
  if (!isValidEmail(email)) return { error: 'email is not valid' };

  return { value: { slot_id, name, email } };
}

module.exports = { validateNewBooking, isValidEmail, clean };
