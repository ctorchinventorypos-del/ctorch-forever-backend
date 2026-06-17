// ============================================================
//  Company listing endpoint.
//    GET /api/companies   -> [{ id, code, name }, ...]
//  Authenticated, but does NOT require a selected company.
// ============================================================
const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { listCompanies } = require('../controllers/companies.controller');

router.use(authenticate);
router.get('/', listCompanies);

module.exports = router;
