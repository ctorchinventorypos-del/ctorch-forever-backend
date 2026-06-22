// ============================================================
//  authenticate: protects routes by checking the login token AND
//  confirming the account is still valid on every request.
//
//  Verifying the JWT signature alone is not enough: if an admin disables
//  someone or changes their role, their existing token would otherwise keep
//  working until it expired (up to 12h). So we also look the user up in the
//  database and reject if they are missing, disabled, or their role changed.
//  The fresh role from the DB (not the token) is what the app trusts.
// ============================================================
const jwt = require('jsonwebtoken');
const { query } = require('../config/db');

async function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Not logged in.' });
  }

  try {
    // Throws if the token is fake, tampered with, or expired.
    const payload = jwt.verify(token, process.env.JWT_SECRET);

    // Confirm the account still exists and is still allowed in.
    const { rows } = await query(
      'SELECT id, username, full_name, role, is_active FROM users WHERE id = $1',
      [payload.id]
    );
    const user = rows[0];

    if (!user || !user.is_active) {
      return res.status(401).json({ error: 'Session expired. Please log in again.' });
    }

    // Trust the DB, not the token, for role and name (covers role changes).
    req.user = {
      id: user.id,
      username: user.username,
      full_name: user.full_name,
      role: user.role,
    };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Session expired. Please log in again.' });
  }
}

module.exports = { authenticate };
