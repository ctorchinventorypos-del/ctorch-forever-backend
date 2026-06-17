// ============================================================
//  Product endpoints.
//    GET   /api/products            list (with total stock)
//    GET   /api/products/:id        one product + stock per branch
//    POST  /api/products            add a new product (any user)
//    PUT   /api/products/:id        edit details (any user)
//    PATCH /api/products/:id/price  change selling price (ADMIN ONLY)
// ============================================================
const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { resolveCompany } = require('../middleware/company');
const { requireAdmin } = require('../middleware/roles');
const c = require('../controllers/products.controller');

router.use(authenticate, resolveCompany);

router.get('/', c.listProducts);
router.get('/:id', c.getProduct);
router.post('/', c.createProduct);
router.put('/:id', c.updateProduct);
router.patch('/:id/price', requireAdmin, c.updatePrice); // only admins set the price

module.exports = router;
