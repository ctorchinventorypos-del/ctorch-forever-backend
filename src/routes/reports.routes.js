// ============================================================
//  Report endpoints (all read-only, company-scoped).
//    GET /api/reports/dashboard           home-screen headline numbers
//    GET /api/reports/profit              profit by day/month/year/product (ADMIN)
//    GET /api/reports/sales-summary       sales totals by day/month
//    GET /api/reports/branch-performance  revenue (and profit for admins) per branch
//    GET /api/reports/inventory           stock valuation + low-stock list
//    GET /api/reports/debtors             who owes, with debt age
//  Profit figures are returned only to admins (handled in the controller).
// ============================================================
const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { resolveCompany } = require('../middleware/company');
const { requireAdmin } = require('../middleware/roles');
const c = require('../controllers/reports.controller');

router.use(authenticate, resolveCompany);

router.get('/dashboard', c.dashboard);
router.get('/profit', requireAdmin, c.profit);
router.get('/sales-summary', c.salesSummary);
router.get('/branch-performance', c.branchPerformance);
router.get('/inventory', c.inventory);
router.get('/debtors', c.debtors);
router.get('/daily-cash', c.dailyCash);

module.exports = router;
