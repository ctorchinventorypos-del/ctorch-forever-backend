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

router.use(authenticate, resolveCompany);

router.post('/', c.createReturn);
router.get('/', c.listReturns);

module.exports = router;
