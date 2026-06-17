// ============================================================
//  Users (admin only): list, create, update (role / active /
//  name), and reset password. Users are global — they aren't
//  tied to one company.
//  Safety: an admin can't disable or demote their own account.
// ============================================================
const bcrypt = require('bcryptjs');
const { query } = require('../config/db');
const { logAction } = require('../utils/audit');

async function listUsers(req, res, next) {
  try {
    const { rows } = await query(
      `SELECT id, username, full_name, role, is_active, last_login, created_at
       FROM users ORDER BY created_at`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

async function createUser(req, res, next) {
  try {
    const username = (req.body.username || '').trim().toLowerCase();
    const fullName = (req.body.full_name || '').trim();
    const password = req.body.password;
    const role = req.body.role === 'admin' ? 'admin' : 'sales';

    if (!username) return res.status(400).json({ error: 'Enter a username.' });
    if (!fullName) return res.status(400).json({ error: 'Enter a full name.' });
    if (!password || password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }

    const hash = await bcrypt.hash(password, 12);
    const { rows } = await query(
      `INSERT INTO users (username, password_hash, full_name, role, is_active, created_by)
       VALUES ($1, $2, $3, $4, TRUE, $5)
       RETURNING id, username, full_name, role, is_active`,
      [username, hash, fullName, role, req.user.id]
    );
    await logAction({ userId: req.user.id, action: 'create_user', entity: 'user', entityId: rows[0].id, ip: req.ip });
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'That username is already taken.' });
    next(err);
  }
}

async function updateUser(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    const { full_name, role, is_active } = req.body;

    if (id === req.user.id && (is_active === false || (role && role !== 'admin'))) {
      return res.status(400).json({ error: "You can't disable or demote your own account." });
    }

    const fields = [];
    const params = [];
    if (full_name !== undefined) { params.push(full_name.trim()); fields.push(`full_name = $${params.length}`); }
    if (role !== undefined) { params.push(role === 'admin' ? 'admin' : 'sales'); fields.push(`role = $${params.length}`); }
    if (is_active !== undefined) { params.push(!!is_active); fields.push(`is_active = $${params.length}`); }
    if (!fields.length) return res.status(400).json({ error: 'Nothing to update.' });

    params.push(id);
    const { rows } = await query(
      `UPDATE users SET ${fields.join(', ')} WHERE id = $${params.length}
       RETURNING id, username, full_name, role, is_active`,
      params
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found.' });
    await logAction({ userId: req.user.id, action: 'update_user', entity: 'user', entityId: id, ip: req.ip });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
}

async function resetPassword(req, res, next) {
  try {
    const password = req.body.password;
    if (!password || password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }
    const hash = await bcrypt.hash(password, 12);
    const { rowCount } = await query(
      'UPDATE users SET password_hash = $1, failed_login_attempts = 0, locked_until = NULL WHERE id = $2',
      [hash, req.params.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'User not found.' });
    await logAction({ userId: req.user.id, action: 'reset_password', entity: 'user', entityId: parseInt(req.params.id, 10), ip: req.ip });
    res.json({ message: 'Password reset.' });
  } catch (err) {
    next(err);
  }
}

module.exports = { listUsers, createUser, updateUser, resetPassword };
