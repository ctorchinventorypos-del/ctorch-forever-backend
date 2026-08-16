// ============================================================
//  Payment endpoints.
//    POST /api/payments     record a payment (lowers balance)
//    GET  /api/payments     records (filter by customer / type / date)
// ============================================================
const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { resolveCompany } = require('../middleware/company');
const c = require('../controllers/payments.controller');
const { blockRoles, requireAdmin } = require('../middleware/roles');

router.use(authenticate, resolveCompany);

router.post('/', blockRoles('warehouse'), c.createPayment);
router.patch('/:id/date', requireAdmin, c.editPaymentDate);
router.get('/', c.listPayments);
router.get('/:id', c.getPayment);

module.exports = router;
