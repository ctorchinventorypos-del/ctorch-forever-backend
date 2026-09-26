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
const { requireFeature, requireAny } = require('../utils/permissions');
const { resolveCompany } = require('../middleware/company');
const { requireAdmin } = require('../middleware/roles');
const c = require('../controllers/customers.controller');

router.use(authenticate, resolveCompany);

router.get('/', requireAny(['customer.view','payment.record','return.record','sale.cash','sale.credit','sale.distributor','sale.warehouse']), c.listCustomers);
router.get('/:id', requireAny(['customer.view','customer.statement','payment.record','return.record','sale.cash','sale.credit','sale.distributor','sale.warehouse']), c.getCustomer);
router.get('/:id/purchases', requireAny(['return.record','customer.view']), c.getPurchases);
router.post('/', c.createCustomer);
router.put('/:id', requireFeature('customer.edit'), c.updateCustomer); // editing existing customer = admin
router.patch('/:id/upgrade', requireFeature('customer.upgrade'), c.upgradeToDistributor);
router.patch('/:id/balance', requireFeature('customer.balance'), c.updateBalance); // set amount owed (admin)

module.exports = router;
