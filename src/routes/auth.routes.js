// ============================================================
//  Auth routes:
//    POST /api/auth/login   -> log in, returns a token
//    GET  /api/auth/me      -> who is logged in (protected)
// ============================================================
const express = require('express');
const rateLimit = require('express-rate-limit');
const { login, me } = require('../controllers/auth.controller');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// Slow down password-guessing by limiting login tries per IP address.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,                  // 20 attempts per IP per window
  message: { error: 'Too many attempts. Please wait a few minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

router.post('/login', loginLimiter, login);
router.get('/me', authenticate, me);

module.exports = router;
