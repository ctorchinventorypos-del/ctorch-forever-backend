// ============================================================
//  Auth controller: login and "who am I".
//  Security features:
//   - bcrypt password check (passwords are never stored in plain text)
//   - generic error message so attackers can't probe valid usernames
//   - disabled accounts are blocked
//   - account locks for 15 minutes after 5 wrong passwords
// ============================================================
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { query } = require('../config/db');
const { logAction } = require('../utils/audit');

const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

async function login(req, res, next) {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Enter username and password.' });
    }

    const { rows } = await query('SELECT * FROM users WHERE username = $1', [username]);
    const user = rows[0];

    // Same message whether the username or the password is wrong.
    const invalid = () =>
      res.status(401).json({ error: 'Incorrect username or password.' });

    if (!user) return invalid();

    // Admin disabled this account?
    if (!user.is_active) {
      return res
        .status(403)
        .json({ error: 'Your access has been disabled. Contact an admin.' });
    }

    // Currently locked out from too many failed attempts?
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      return res
        .status(403)
        .json({ error: 'Too many failed attempts. Please try again later.' });
    }

    const ok = await bcrypt.compare(password, user.password_hash);

    if (!ok) {
      const attempts = user.failed_login_attempts + 1;
      const lockUntil =
        attempts >= MAX_ATTEMPTS
          ? new Date(Date.now() + LOCK_MINUTES * 60 * 1000)
          : null;
      await query(
        'UPDATE users SET failed_login_attempts = $1, locked_until = $2 WHERE id = $3',
        [attempts, lockUntil, user.id]
      );
      return invalid();
    }

    // Success: clear the counters and stamp the login time.
    await query(
      `UPDATE users
         SET failed_login_attempts = 0, locked_until = NULL, last_login = now()
       WHERE id = $1`,
      [user.id]
    );

    const token = jwt.sign(
      {
        id: user.id,
        username: user.username,
        role: user.role,
        full_name: user.full_name,
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '12h' }
    );

    await logAction({
      userId: user.id,
      action: 'login',
      entity: 'user',
      entityId: user.id,
      ip: req.ip,
    });

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        full_name: user.full_name,
        role: user.role,
      },
    });
  } catch (err) {
    next(err);
  }
}

// Returns the logged-in user. The frontend calls this on page load to know
// who is signed in and whether they're an admin.
async function me(req, res) {
  res.json({ user: req.user });
}

module.exports = { login, me };
