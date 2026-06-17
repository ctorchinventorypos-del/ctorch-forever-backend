// ============================================================
//  Database connection (PostgreSQL on Render)
//  Every query in the app goes through this one shared pool.
// ============================================================
const { Pool } = require('pg');
require('dotenv').config();

// Render's hosted Postgres needs SSL for outside connections.
// Set DATABASE_SSL=false in .env only if you ever run a local DB without SSL.
const useSsl = process.env.DATABASE_SSL !== 'false';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSsl ? { rejectUnauthorized: false } : false,
  max: 10,                        // max simultaneous connections
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => {
  console.error('Unexpected database error:', err);
});

// Helper used everywhere: const { rows } = await query('SELECT ...', [values])
// Using $1, $2 placeholders (never string concatenation) blocks SQL injection.
const query = (text, params) => pool.query(text, params);

// Runs several queries as ONE all-or-nothing unit. If anything throws,
// every change is rolled back. Used for transfers, sales, returns, etc.
//   await withTransaction(async (client) => { await client.query(...); ... });
async function withTransaction(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, withTransaction };
