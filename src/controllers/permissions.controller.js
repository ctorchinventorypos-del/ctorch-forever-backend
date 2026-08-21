// ============================================================
//  Feature-toggle endpoints.
//    GET  /api/permissions/me       effective map for the current user (drives UI)
//    GET  /api/permissions/catalog  features + current overrides (admin grid)
//    PUT  /api/permissions          set an override            (admin)
//    DELETE /api/permissions        clear an override → default (admin)
// ============================================================
const { query } = require('../config/db');
const { FEATURES, FEATURE_KEYS, TOGGLEABLE_ROLES } = require('../config/features');
const { permissionsFor } = require('../utils/permissions');

// What CAN the current user do — used by the frontend to show/hide things.
async function me(req, res, next) {
  try {
    const map = await permissionsFor(req.user);
    res.json({ role: req.user.role, permissions: map });
  } catch (err) { next(err); }
}

// Full catalog + every override, for the admin Permissions grid.
async function catalog(req, res, next) {
  try {
    const { rows } = await query(
      `SELECT feature_key, scope_type, scope_id, allowed FROM permission_overrides`
    );
    const users = await query(
      `SELECT id, full_name, role FROM users
       WHERE role IN ('sales','warehouse') AND is_active = TRUE ORDER BY full_name`
    );
    res.json({
      features: FEATURES,
      roles: TOGGLEABLE_ROLES,
      users: users.rows,
      overrides: rows, // [{feature_key, scope_type, scope_id, allowed}]
    });
  } catch (err) { next(err); }
}

// PUT { feature_key, scope_type:'role'|'user', scope_id, allowed }
async function setOverride(req, res, next) {
  try {
    const { feature_key, scope_type, scope_id, allowed } = req.body;
    if (!FEATURE_KEYS.has(feature_key)) return res.status(400).json({ error: 'Unknown feature.' });
    if (!['role', 'user'].includes(scope_type)) return res.status(400).json({ error: 'Bad scope.' });
    if (scope_type === 'role' && !TOGGLEABLE_ROLES.includes(scope_id)) {
      return res.status(400).json({ error: 'Only sales and warehouse groups can be toggled.' });
    }
    if (typeof allowed !== 'boolean') return res.status(400).json({ error: 'allowed must be true/false.' });

    await query(
      `INSERT INTO permission_overrides (feature_key, scope_type, scope_id, allowed, updated_by, updated_at)
       VALUES ($1,$2,$3,$4,$5, now())
       ON CONFLICT (feature_key, scope_type, scope_id)
       DO UPDATE SET allowed = EXCLUDED.allowed, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [feature_key, scope_type, String(scope_id), allowed, req.user.id]
    );
    res.json({ message: 'Saved.' });
  } catch (err) { next(err); }
}

// DELETE { feature_key, scope_type, scope_id } → revert to default/inherited.
async function clearOverride(req, res, next) {
  try {
    const { feature_key, scope_type, scope_id } = req.body;
    await query(
      `DELETE FROM permission_overrides WHERE feature_key=$1 AND scope_type=$2 AND scope_id=$3`,
      [feature_key, scope_type, String(scope_id)]
    );
    res.json({ message: 'Reset to default.' });
  } catch (err) { next(err); }
}

module.exports = { me, catalog, setOverride, clearOverride };
