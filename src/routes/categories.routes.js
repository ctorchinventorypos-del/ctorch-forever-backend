// ============================================================
//  Category endpoints. Any logged-in user may manage categories.
//    GET    /api/categories
//    POST   /api/categories
//    PUT    /api/categories/:id
//    DELETE /api/categories/:id
// ============================================================
const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { resolveCompany } = require('../middleware/company');
const c = require('../controllers/categories.controller');

// Every route here needs a logged-in user AND a selected company.
router.use(authenticate, resolveCompany);

router.get('/', c.listCategories);
router.post('/', c.createCategory);
router.put('/:id', c.updateCategory);
router.delete('/:id', c.deleteCategory);

module.exports = router;
