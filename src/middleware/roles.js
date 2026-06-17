// ============================================================
//  requireAdmin: blocks sales users from admin-only actions
//  (creating users, disabling access, editing recommended price).
//  Use AFTER authenticate, e.g. router.post('/', authenticate, requireAdmin, ...)
// ============================================================
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admins only.' });
  }
  next();
}

module.exports = { requireAdmin };
