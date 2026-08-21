// ============================================================
//  Warehouse Sale routes (cross-company). Available to sales,
//  warehouse and admin users. NOT company-scoped.
// ============================================================
const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { requireFeature } = require('../utils/permissions');
const c = require('../controllers/warehouse.controller');

router.use(authenticate);

router.get('/inventory', c.inventory);
router.post('/', c.createWarehouseSale);
router.get('/:ref', c.getWarehouseSale);

module.exports = router;
