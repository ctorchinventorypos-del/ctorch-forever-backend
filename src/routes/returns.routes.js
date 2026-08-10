// ============================================================
//  Return endpoints.
//    POST /api/returns      record a return (restock + lower balance)
//    GET  /api/returns      records (filter by sale / date)
// ============================================================
const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { resolveCompany } = require('../middleware/company');
const c = require('../controllers/returns.controller');
const { blockRoles } = require('../middleware/roles');

router.use(authenticate, resolveCompany);

router.post('/', blockRoles('warehouse'), c.createReturn);
router.get('/', c.listReturns);

// Reworked customer-based returns.
router.post('/customer', blockRoles('warehouse'), c.createCustomerReturn);
router.get('/customer', c.listCustomerReturns);
router.get('/customer/:id', c.getCustomerReturn);

module.exports = router;
