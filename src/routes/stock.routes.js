// ============================================================
//  Stock endpoints.
//    GET  /api/stock?branch_id=...        stock at one branch
//    GET  /api/stock/movements?product_id history of changes
//    POST /api/stock/restock              add stock (accumulates)
//    POST /api/stock/transfer             move stock between branches
// ============================================================
const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { requireFeature } = require('../utils/permissions');
const { resolveCompany } = require('../middleware/company');
const { requireAdmin } = require('../middleware/roles');
const { requireStockManager } = require('../middleware/roles');
const c = require('../controllers/stock.controller');

router.use(authenticate, resolveCompany);

router.get('/', c.branchStock);
router.get('/movements', c.movements);
router.get('/branch-movements', requireFeature('transfers.records'), c.branchMovements);
router.post('/restock', requireFeature('stock.restock'), c.restock);
router.post('/transfer', requireFeature('stock.transfer'), c.transfer);
router.post('/transfer-batch', requireFeature('stock.transfer'), c.transferBatch);
router.post('/adjust', requireFeature('stock.adjust'), c.adjust);  // set exact stock (admin only)

module.exports = router;
