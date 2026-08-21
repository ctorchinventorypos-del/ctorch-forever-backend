// ============================================================
//  Category endpoints. Viewing is open; creating/editing/deleting is admin-only.
//    GET    /api/categories
//    POST   /api/categories
//    PUT    /api/categories/:id
//    DELETE /api/categories/:id
// ============================================================
const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { requireFeature } = require('../utils/permissions');
const { requireAdmin } = require('../middleware/roles');
const { resolveCompany } = require('../middleware/company');
const c = require('../controllers/categories.controller');

// Every route here needs a logged-in user AND a selected company.
router.use(authenticate, resolveCompany);

router.get('/', c.listCategories);
router.post('/', requireFeature('category.manage'), c.createCategory);
router.put('/:id', requireFeature('category.manage'), c.updateCategory);
router.delete('/:id', requireFeature('category.manage'), c.deleteCategory);

module.exports = router;
