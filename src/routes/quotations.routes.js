// ============================================================
//  Quotation endpoints (company-scoped, any logged-in user).
//    POST   /api/quotations            create a quote
//    GET    /api/quotations            list quotes (?status=open|converted)
//    GET    /api/quotations/:id        one quote + items (for proforma print)
//    PATCH  /api/quotations/:id/status mark open/converted
//    DELETE /api/quotations/:id        remove a quote
// ============================================================
const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { resolveCompany } = require('../middleware/company');
const c = require('../controllers/quotations.controller');

router.use(authenticate, resolveCompany);

router.post('/', c.createQuotation);
router.get('/', c.listQuotations);
router.get('/:id', c.getQuotation);
router.patch('/:id/status', c.setStatus);
router.delete('/:id', c.deleteQuotation);

module.exports = router;
