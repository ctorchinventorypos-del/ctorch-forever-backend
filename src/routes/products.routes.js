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
const { requireFeature, requireAny } = require('../utils/permissions');
const { resolveCompany } = require('../middleware/company');
const { requireAdmin } = require('../middleware/roles');
const c = require('../controllers/products.controller');

router.use(authenticate, resolveCompany);

router.get('/', requireAny(['inventory.view','sale.cash','sale.credit','sale.distributor','sale.warehouse']), c.listProducts);
router.get('/next-code', c.nextCode);
router.get('/:id', requireAny(['inventory.view','sale.cash','sale.credit','sale.distributor','sale.warehouse']), c.getProduct);
router.post('/', requireFeature('product.add'), c.createProduct);
router.post('/batch', requireFeature('product.add'), c.createProductsBatch);
router.put('/:id', requireFeature('product.edit'), c.updateProduct);
router.patch('/:id/price', requireFeature('product.price'), c.updatePrice);  // only admins set the price
router.patch('/:id/active', requireFeature('product.active'), c.setProductActive); // deactivate/reactivate (admin)

module.exports = router;
