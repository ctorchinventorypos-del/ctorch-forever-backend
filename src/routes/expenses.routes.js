// ============================================================
//  Expenses routes. Gated by the expense.* feature toggles.
// ============================================================
const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { resolveCompany } = require('../middleware/company');
const { requireAdmin } = require('../middleware/roles');
const { requireFeature } = require('../utils/permissions');
const c = require('../controllers/expenses.controller');

router.use(authenticate, resolveCompany);

router.get('/', requireFeature('expense.view'), c.listExpenses);
router.post('/', requireFeature('expense.record'), c.createExpense);
router.delete('/:id', requireAdmin, c.deleteExpense);
router.patch('/:id/date', requireFeature('records.edit_date'), c.editExpenseDate);

module.exports = router;
