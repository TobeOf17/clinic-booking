const crypto = require('crypto');

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

// Constant-time comparison, so response timing doesn't leak how much of a key matched.
function keyMatches(given, expected) {
  if (typeof given !== 'string' || !expected) return false;
  return crypto.timingSafeEqual(sha256(given), sha256(expected));
}

/**
 * Every API request needs X-API-Key.
 *  - API_KEY: full access (what the assessment checks use). Keep it secret.
 *  - WEB_KEY: optional second key, embedded in the public booking page. A browser page
 *    can't keep a secret, so this key can do everything except POST /reset.
 */
function requireApiKey(req, res, next) {
  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'server is missing API_KEY' });
  }
  const given = req.get('X-API-Key');
  if (keyMatches(given, apiKey)) {
    req.keyRole = 'admin';
    return next();
  }
  if (keyMatches(given, process.env.WEB_KEY)) {
    if (req.path === '/reset') {
      return res.status(403).json({ error: 'this key cannot reset data' });
    }
    req.keyRole = 'web';
    return next();
  }
  return res.status(401).json({ error: given ? 'invalid API key' : 'missing API key' });
}

module.exports = { requireApiKey, keyMatches };
