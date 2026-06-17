// ============================================================
//  User management endpoints (admin only).
//    GET   /api/users
//    POST  /api/users
//    PATCH /api/users/:id            (name / role / active)
//    POST  /api/users/:id/password   (reset password)
// ============================================================
const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/roles');
const c = require('../controllers/users.controller');

router.use(authenticate, requireAdmin);

router.get('/', c.listUsers);
router.post('/', c.createUser);
router.patch('/:id', c.updateUser);
router.post('/:id/password', c.resetPassword);

module.exports = router;
