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
const { resolveCompany } = require('../middleware/company');
const c = require('../controllers/stock.controller');

router.use(authenticate, resolveCompany);

router.get('/', c.branchStock);
router.get('/movements', c.movements);
router.post('/restock', c.restock);
router.post('/transfer', c.transfer);
router.post('/transfer-batch', c.transferBatch); // move several products at once

module.exports = router;
