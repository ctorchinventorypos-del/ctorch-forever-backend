// ============================================================
//  Creates the FIRST admin user so you can log in.
//  Run once:  npm run seed
//  It reads ADMIN_USERNAME / ADMIN_PASSWORD / ADMIN_FULLNAME from .env.
//  Safe to run again — it won't create a duplicate.
// ============================================================
const bcrypt = require('bcryptjs');
const { pool, query } = require('../src/config/db');
require('dotenv').config();

async function seed() {
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD;
  const fullName = process.env.ADMIN_FULLNAME || 'System Administrator';

  if (!password) {
    console.error('Set ADMIN_PASSWORD in your .env file first, then run again.');
    process.exit(1);
  }

  try {
    const existing = await query('SELECT id FROM users WHERE username = $1', [username]);
    if (existing.rows.length) {
      console.log(`User "${username}" already exists. Nothing to do.`);
      return;
    }

    const hash = await bcrypt.hash(password, 12); // 12 = strong, slow-to-crack
    await query(
      `INSERT INTO users (username, password_hash, full_name, role, is_active)
       VALUES ($1, $2, $3, 'admin', TRUE)`,
      [username, hash, fullName]
    );
    console.log(`Admin user "${username}" created. You can now log in.`);
  } catch (err) {
    console.error('Seed failed:', err.message);
  } finally {
    await pool.end();
  }
}

seed();
