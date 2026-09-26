// ============================================================
//  Effective feature permissions.
//  Order of precedence for a sales/warehouse user:
//     per-user override  →  per-role override  →  built-in default
//  Admins & super-admins always get every feature.
// ============================================================
const { query } = require('../config/db');
const { FEATURES, FEATURE_KEYS } = require('../config/features');

function isAdminRole(role) { return role === 'admin' || role === 'super_admin'; }

// Load overrides that apply to a given user (their role + their own id).
async function loadOverridesFor(user) {
  const { rows } = await query(
    `SELECT feature_key, scope_type, scope_id, allowed FROM permission_overrides
     WHERE (scope_type = 'role' AND scope_id = $1)
        OR (scope_type = 'user' AND scope_id = $2)`,
    [user.role, String(user.id)]
  );
  const roleOv = {};
  const userOv = {};
  for (const r of rows) {
    if (r.scope_type === 'role') roleOv[r.feature_key] = r.allowed;
    else userOv[r.feature_key] = r.allowed;
  }
  return { roleOv, userOv };
}

// Compute the full { key: bool } map for a user.
async function permissionsFor(user) {
  const map = {};
  if (isAdminRole(user.role)) {
    for (const f of FEATURES) map[f.key] = true;
    return map;
  }
  const { roleOv, userOv } = await loadOverridesFor(user);
  for (const f of FEATURES) {
    if (Object.prototype.hasOwnProperty.call(userOv, f.key)) map[f.key] = userOv[f.key];
    else if (Object.prototype.hasOwnProperty.call(roleOv, f.key)) map[f.key] = roleOv[f.key];
    else map[f.key] = f.defaults[user.role] === true; // sales / warehouse default (false for any other role)
  }
  return map;
}

// True/false for one feature (used by requireFeature).
async function can(user, featureKey) {
  if (!FEATURE_KEYS.has(featureKey)) return false;
  if (isAdminRole(user.role)) return true;
  const { roleOv, userOv } = await loadOverridesFor(user);
  if (Object.prototype.hasOwnProperty.call(userOv, featureKey)) return userOv[featureKey];
  if (Object.prototype.hasOwnProperty.call(roleOv, featureKey)) return roleOv[featureKey];
  const f = FEATURES.find((x) => x.key === featureKey);
  return !!(f && f.defaults[user.role] === true);
}

// Express middleware: block the request unless the user has the feature.
function requireFeature(featureKey) {
  return async (req, res, next) => {
    try {
      if (await can(req.user, featureKey)) return next();
      return res.status(403).json({ error: 'You do not have access to this action.' });
    } catch (err) { next(err); }
  };
}


// Passes if the user has ANY of the given features (used for reads that several
// roles legitimately need, e.g. the customer list is needed to view OR to sell).
async function canAny(user, keys) {
  for (const k of keys) { if (await can(user, k)) return true; }
  return false;
}
// Middleware form of canAny.
function requireAny(keys) {
  return async (req, res, next) => {
    try {
      if (await canAny(req.user, keys)) return next();
      return res.status(403).json({ error: 'You do not have access to this.' });
    } catch (err) { next(err); }
  };
}

module.exports = { permissionsFor, can, canAny, requireFeature, requireAny, isAdminRole };
