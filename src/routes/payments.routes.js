// ============================================================
//  Payment endpoints.
//    POST /api/payments     record a payment (lowers balance)
//    GET  /api/payments     records (filter by customer / type / date)
// ============================================================
const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { requireFeature, requireAny } = require('../utils/permissions');
const { resolveCompany } = require('../middleware/company');
const c = require('../controllers/payments.controller');
const { blockRoles, requireAdmin } = require('../middleware/roles');

router.use(authenticate, resolveCompany);

router.post('/', requireFeature('payment.record'), c.createPayment);
router.patch('/:id/date', requireFeature('records.edit_date'), c.editPaymentDate);
router.get('/', requireAny(['records.payments','payment.record']), c.listPayments);
router.get('/:id', requireAny(['records.payments','payment.record']), c.getPayment);

module.exports = router;
