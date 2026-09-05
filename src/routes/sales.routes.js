// ============================================================
//  Sales endpoints.
//    POST /api/sales        record a sale (cash/credit/reseller)
//    GET  /api/sales        list/records (filter by type, date, customer)
//    GET  /api/sales/:id    one sale with items (used to print invoice)
// ============================================================
const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { requireFeature } = require('../utils/permissions');
const { resolveCompany } = require('../middleware/company');
const c = require('../controllers/sales.controller');
const { blockRoles, requireAdmin, requireSuperAdmin } = require('../middleware/roles');

router.use(authenticate, resolveCompany);

router.post('/', blockRoles('warehouse'), c.createSale); // warehouse users can't sell
router.patch('/:id/date', requireFeature('records.edit_date'), c.editSaleDate);
router.patch('/:id/customer', requireFeature('records.edit_customer'), c.editSaleCustomer); // admin: change a past sale's date
router.put('/:id/items', requireSuperAdmin, c.editSaleItems); // SUPER ADMIN: correct a sale's items
router.get('/', c.listSales);
router.get('/by-invoice/:invoice', c.getSaleByInvoice); // return-by-receipt lookup
router.get('/:id', c.getSale);

module.exports = router;
