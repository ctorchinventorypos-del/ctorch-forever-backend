// ============================================================
//  User management endpoints (admin only).
//    GET   /api/users
//    POST  /api/users                (create user)        — rate-limited
//    PATCH /api/users/:id            (name / role / active)
//    POST  /api/users/:id/password   (reset password)     — rate-limited
// ============================================================
const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/roles');
const c = require('../controllers/users.controller');

router.use(authenticate, requireAdmin);

// Sensitive account actions get a stricter ceiling than the global limiter.
const sensitiveLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30,                  // 30 create/reset actions per admin IP per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many account actions. Please wait a few minutes.' },
});

router.get('/', c.listUsers);
router.post('/', sensitiveLimiter, c.createUser);
router.patch('/:id', c.updateUser);
router.post('/:id/password', sensitiveLimiter, c.resetPassword);

module.exports = router;
