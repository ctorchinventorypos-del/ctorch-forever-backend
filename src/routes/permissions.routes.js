// ============================================================
//  Permissions routes. /me is for every logged-in user (drives UI);
//  the rest are admin-only (the toggle grid).
// ============================================================
const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/roles');
const c = require('../controllers/permissions.controller');

router.use(authenticate);

router.get('/me', c.me);
router.get('/catalog', requireAdmin, c.catalog);
router.put('/', requireAdmin, c.setOverride);
router.delete('/', requireAdmin, c.clearOverride);

module.exports = router;
