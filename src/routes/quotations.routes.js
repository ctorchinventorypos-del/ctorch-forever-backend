// ============================================================
//  Quotation endpoints (company-scoped).
//    POST   /api/quotations             create a quote          (any user)
//    POST   /api/quotations/:id/revise  save a new revision     (ADMIN)
//    GET    /api/quotations             list (latest per quote)
//    GET    /api/quotations/:id         one revision + items
//    GET    /api/quotations/:id/history all revisions of a quote
//    PATCH  /api/quotations/:id/status  mark open/converted/superseded
//    DELETE /api/quotations/:id         remove a quote (all revisions)
// ============================================================
const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { resolveCompany } = require('../middleware/company');
const { requireAdmin } = require('../middleware/roles');
const c = require('../controllers/quotations.controller');

router.use(authenticate, resolveCompany);

router.post('/', c.createQuotation);
router.post('/:id/revise', requireAdmin, c.reviseQuotation);  // editing = admin only
router.get('/', c.listQuotations);
router.get('/:id/history', c.getHistory);
router.get('/:id', c.getQuotation);
router.patch('/:id/status', c.setStatus);
router.delete('/:id', c.deleteQuotation);

module.exports = router;
