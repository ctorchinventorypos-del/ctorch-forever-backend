// ============================================================
//  Branch endpoints.
//    GET  /api/branches            (any user)
//    POST /api/branches            (admin only)
//    PUT  /api/branches/:id        (admin only)
// ============================================================
const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { resolveCompany } = require('../middleware/company');
const { requireAdmin } = require('../middleware/roles');
const c = require('../controllers/branches.controller');

router.use(authenticate, resolveCompany);

router.get('/', c.listBranches);
router.post('/', requireAdmin, c.createBranch);
router.put('/:id', requireAdmin, c.updateBranch);

module.exports = router;
