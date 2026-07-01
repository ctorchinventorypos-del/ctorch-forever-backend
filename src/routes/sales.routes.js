// ============================================================
//  Sales endpoints.
//    POST /api/sales        record a sale (cash/credit/reseller)
//    GET  /api/sales        list/records (filter by type, date, customer)
//    GET  /api/sales/:id    one sale with items (used to print invoice)
// ============================================================
const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { resolveCompany } = require('../middleware/company');
const c = require('../controllers/sales.controller');

router.use(authenticate, resolveCompany);

router.post('/', c.createSale);
router.get('/', c.listSales);
router.get('/by-invoice/:invoice', c.getSaleByInvoice); // return-by-receipt lookup
router.get('/:id', c.getSale);

module.exports = router;
