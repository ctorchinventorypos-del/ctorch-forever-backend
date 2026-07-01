// ============================================================
//  Customer endpoints (credit customers and bulk resellers).
//    GET  /api/customers?type=credit|reseller
//    GET  /api/customers/:id        customer + history
//    POST /api/customers            create
//    PUT  /api/customers/:id        edit
// ============================================================
const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { resolveCompany } = require('../middleware/company');
const { requireAdmin } = require('../middleware/roles');
const c = require('../controllers/customers.controller');

router.use(authenticate, resolveCompany);

router.get('/', c.listCustomers);
router.get('/:id', c.getCustomer);
router.post('/', c.createCustomer);
router.put('/:id', c.updateCustomer);
router.patch('/:id/balance', requireAdmin, c.updateBalance); // set amount owed (admin)

module.exports = router;
