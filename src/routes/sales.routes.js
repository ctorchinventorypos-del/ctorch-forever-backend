// ============================================================
//  Sales endpoints.
//    POST /api/sales        record a sale (cash/credit/reseller)
//    GET  /api/sales        list/records (filter by type, date, customer)
//    GET  /api/sales/:id    one sale with items (used to print invoice)
// ============================================================
const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { requireFeature, requireAny } = require('../utils/permissions');
const { resolveCompany } = require('../middleware/company');
const c = require('../controllers/sales.controller');
const { blockRoles, requireAdmin, requireSuperAdmin } = require('../middleware/roles');

router.use(authenticate, resolveCompany);

router.post('/', blockRoles('warehouse'), c.createSale); // warehouse users can't sell
router.patch('/:id/date', requireFeature('records.edit_date'), c.editSaleDate);
router.patch('/:id/customer', requireFeature('records.edit_customer'), c.editSaleCustomer); // admin: change a past sale's date
router.put('/:id/items', requireSuperAdmin, c.editSaleItems); // SUPER ADMIN: correct a sale's items
router.get('/', requireAny(['records.sales','sale.cash','sale.credit','sale.distributor']), c.listSales);
router.get('/by-invoice/:invoice', requireAny(['return.record','records.sales']), c.getSaleByInvoice);
router.get('/:id', requireAny(['records.sales','return.record','sale.cash','sale.credit','sale.distributor']), c.getSale);

module.exports = router;
