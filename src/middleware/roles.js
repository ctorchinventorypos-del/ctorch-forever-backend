// ============================================================
//  Role helpers for the four tiers:
//    super_admin  – everything an admin can do, plus removing an
//                   account's sign-in (inactivity) timeout.
//    admin        – full day-to-day control.
//    warehouse    – view sales orders, add stock, view inventory.
//    sales        – make sales & sales orders, view customer/sales/returns
//                   reports (no profit / nothing company-sensitive),
//                   view inventory only.
//  Use AFTER `authenticate`.
// ============================================================

function isAdminRole(role) {
  return role === 'admin' || role === 'super_admin';
}

function requireAdmin(req, res, next) {
  if (!req.user || !isAdminRole(req.user.role)) {
    return res.status(403).json({ error: 'Admins only.' });
  }
  next();
}

function requireSuperAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'super_admin') {
    return res.status(403).json({ error: 'Super admin only.' });
  }
  next();
}

// Adding/receiving stock: warehouse users, admins, super admins.
function requireStockManager(req, res, next) {
  const r = req.user && req.user.role;
  if (r === 'warehouse' || isAdminRole(r)) return next();
  return res.status(403).json({ error: 'Not allowed for your role.' });
}

// Block specific roles from an action (e.g. warehouse can't record sales).
function blockRoles(...roles) {
  return (req, res, next) => {
    if (req.user && roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Not allowed for your role.' });
    }
    next();
  };
}

module.exports = { requireAdmin, requireSuperAdmin, requireStockManager, blockRoles, isAdminRole };
