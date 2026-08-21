// ============================================================
//  Branch endpoints.
//    GET  /api/branches            (any user)
//    POST /api/branches            (admin only)
//    PUT  /api/branches/:id        (admin only)
// ============================================================
const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { requireFeature } = require('../utils/permissions');
const { resolveCompany } = require('../middleware/company');
const { requireAdmin } = require('../middleware/roles');
const c = require('../controllers/branches.controller');

router.use(authenticate, resolveCompany);

router.get('/', c.listBranches);
router.post('/', requireFeature('branches.manage'), c.createBranch);
router.put('/:id', requireFeature('branches.manage'), c.updateBranch);

module.exports = router;
