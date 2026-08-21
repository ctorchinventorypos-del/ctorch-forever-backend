// ============================================================
//  Return endpoints.
//    POST /api/returns      record a return (restock + lower balance)
//    GET  /api/returns      records (filter by sale / date)
// ============================================================
const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { requireFeature } = require('../utils/permissions');
const { resolveCompany } = require('../middleware/company');
const c = require('../controllers/returns.controller');
const { blockRoles, requireAdmin } = require('../middleware/roles');

router.use(authenticate, resolveCompany);

router.post('/', blockRoles('warehouse'), c.createReturn);
router.get('/', c.listReturns);

// Reworked customer-based returns.
router.post('/customer', requireFeature('return.record'), c.createCustomerReturn);
router.patch('/customer/:id/date', requireFeature('records.edit_date'), c.editReturnDate);
router.get('/customer', c.listCustomerReturns);
router.get('/customer/:id', c.getCustomerReturn);

module.exports = router;
