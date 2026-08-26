// ============================================================
//  Daily expenses (money out) for the active company.
// ============================================================
const { query } = require('../config/db');
const { actionDate, editDate } = require('../utils/dates');
const { can } = require('../utils/permissions');

const VALID_METHODS = ['cash', 'pos', 'transfer_moniepoint', 'transfer_zenith', 'cheque'];

// POST /api/expenses  { amount, category, payment_method, note, created_at }
async function createExpense(req, res, next) {
  try {
    const amount = Number(req.body.amount);
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Enter an amount greater than 0.' });
    const method = VALID_METHODS.includes(req.body.payment_method) ? req.body.payment_method : 'cash';
    const category = (req.body.category || '').trim() || null;
    const note = (req.body.note || '').trim() || null;
    // Back-dating an expense uses the same permission as back-dating a sale.
    let when = req.body.created_at;
    if (when && !(await can(req.user, 'sale.backdate'))) when = null;

    const { rows } = await query(
      `INSERT INTO expenses (company_id, amount, category, payment_method, note, user_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6, COALESCE($7::timestamptz, now())) RETURNING *`,
      [req.company.id, amount, category, method, note, req.user.id, actionDate(when)]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
}

// GET /api/expenses?from=&to=
async function listExpenses(req, res, next) {
  try {
    const params = [req.company.id];
    let where = 'WHERE e.company_id = $1';
    if (req.query.from) { params.push(req.query.from); where += ` AND e.created_at >= $${params.length}::date`; }
    if (req.query.to) { params.push(req.query.to); where += ` AND e.created_at < ($${params.length}::date + 1)`; }
    const { rows } = await query(
      `SELECT e.*, u.full_name AS recorded_by
       FROM expenses e LEFT JOIN users u ON u.id = e.user_id
       ${where} ORDER BY e.created_at DESC LIMIT 1000`,
      params
    );
    const total = rows.reduce((s, r) => s + Number(r.amount), 0);
    res.json({ expenses: rows, total });
  } catch (err) { next(err); }
}

// DELETE /api/expenses/:id  (admin — remove a mistaken entry)
async function deleteExpense(req, res, next) {
  try {
    const r = await query('DELETE FROM expenses WHERE id = $1 AND company_id = $2 RETURNING id', [req.params.id, req.company.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Expense not found.' });
    res.json({ message: 'Deleted.' });
  } catch (err) { next(err); }
}

// PATCH /api/expenses/:id/date  (admin)
async function editExpenseDate(req, res, next) {
  try {
    const when = editDate(req.body.date);
    const r = await query('UPDATE expenses SET created_at = $1 WHERE id = $2 AND company_id = $3 RETURNING id, created_at',
      [when, req.params.id, req.company.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Expense not found.' });
    res.json({ message: 'Date updated.', ...r.rows[0] });
  } catch (err) { next(err); }
}

module.exports = { createExpense, listExpenses, deleteExpense, editExpenseDate };
