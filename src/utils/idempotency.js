// ============================================================
//  Idempotency: protect create-endpoints (sales, returns) from
//  duplicate submissions caused by flaky connections/retries.
//
//  Flow:
//   - The client sends a unique "Idempotency-Key" header per action, and
//     reuses the SAME key if it has to retry.
//   - begin(): claims the key. If already claimed, returns either the stored
//     response (replay) or a "still processing" signal.
//   - finish(): stores the response so a later retry replays it.
//   - fail(): releases the key so a genuine retry can proceed.
// ============================================================
const { query } = require('../config/db');

// Returns { proceed:true } to run the operation, or
// { proceed:false, replay } to return a stored result, or
// { proceed:false, busy:true } if an identical request is still in flight.
async function begin(key, endpoint) {
  if (!key) return { proceed: true };
  const claim = await query(
    `INSERT INTO idempotency_keys (key, endpoint) VALUES ($1, $2)
     ON CONFLICT (key) DO NOTHING RETURNING key`,
    [key, endpoint]
  );
  if (claim.rowCount === 1) return { proceed: true }; // we claimed it first

  const prev = await query('SELECT response FROM idempotency_keys WHERE key = $1', [key]);
  if (prev.rows[0] && prev.rows[0].response) {
    return { proceed: false, replay: prev.rows[0].response };
  }
  return { proceed: false, busy: true };
}

async function finish(key, response) {
  if (!key) return;
  await query('UPDATE idempotency_keys SET response = $1 WHERE key = $2', [JSON.stringify(response), key]);
}

async function fail(key) {
  if (!key) return;
  // Release the key so the user can genuinely retry after a real error.
  await query('DELETE FROM idempotency_keys WHERE key = $1 AND response IS NULL', [key]);
}

module.exports = { begin, finish, fail };
