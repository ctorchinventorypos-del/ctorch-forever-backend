// ============================================================
//  logAction: writes a row to audit_log (who did what, when, from where).
//  Call it after important actions. A failure here never breaks the
//  main action — it only logs a warning.
// ============================================================
const { query } = require('../config/db');

async function logAction({ userId, action, entity, entityId, details, ip }) {
  try {
    await query(
      `INSERT INTO audit_log (user_id, action, entity, entity_id, details, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        userId || null,
        action,
        entity || null,
        entityId || null,
        details ? JSON.stringify(details) : null,
        ip || null,
      ]
    );
  } catch (err) {
    console.error('Audit log failed:', err.message);
  }
}

module.exports = { logAction };
