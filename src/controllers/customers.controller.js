// ============================================================
//  Customers: ONE table holds two kinds of debtor, told apart by
//  customer_type:
//    'credit'   = normal credit customer
//    'reseller' = bulk reseller (takes goods on credit to resell)
//  balance_owed is their running debt; the database keeps it >= 0.
// ============================================================
const { query } = require('../config/db');
const { logAction } = require('../utils/audit');

// GET /api/customers?type=credit|reseller&search=...
async function listCustomers(req, res, next) {
  try {
    // Customers are shared across both companies, so the list is NOT filtered
    // by the active company. Balance is the combined debt across companies.
    const params = [];
    let where = 'WHERE 1=1';

    if (req.query.type) {
      params.push(req.query.type);
      where += ` AND customer_type = $${params.length}`;
    }
    if (req.query.search) {
      params.push('%' + req.query.search + '%');
      where += ` AND (name ILIKE $${params.length} OR phone ILIKE $${params.length})`;
    }

    const { rows } = await query(
      `SELECT id, name, phone, address, customer_type, balance_owed, created_at
       FROM customers ${where} ORDER BY name`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

// GET /api/customers/:id
// The customer plus their sales and payment history (their "page").
async function getCustomer(req, res, next) {
  try {
    // Customer is shared, so open it regardless of the active company.
    const cust = await query(
      `SELECT cu.*, co.code AS company_code, co.name AS company_name,
              co.address AS company_address, co.phone AS company_phone
       FROM customers cu JOIN companies co ON co.id = cu.company_id
       WHERE cu.id = $1`,
      [req.params.id]
    );
    if (!cust.rows.length) return res.status(404).json({ error: 'Customer not found.' });

    // History spans BOTH companies; each row is tagged with the company it
    // happened under, so the statement shows where each debt came from.
    const sales = await query(
      `SELECT s.id, s.invoice_number, s.sale_type, s.payment_method, s.total_amount,
              s.amount_paid, s.created_at, co.code AS company_code, co.name AS company_name
       FROM sales s JOIN companies co ON co.id = s.company_id
       WHERE s.customer_id = $1 ORDER BY s.created_at DESC LIMIT 300`,
      [req.params.id]
    );
    const payments = await query(
      `SELECT p.id, p.amount, p.payment_method, p.note, p.created_at,
              co.code AS company_code, co.name AS company_name
       FROM payments p JOIN companies co ON co.id = p.company_id
       WHERE p.customer_id = $1 ORDER BY p.created_at DESC LIMIT 300`,
      [req.params.id]
    );
    const returns = await query(
      `SELECT cr.id, cr.return_number, cr.total_amount, cr.created_at,
              co.code AS company_code, co.name AS company_name
       FROM customer_returns cr JOIN companies co ON co.id = cr.company_id
       WHERE cr.customer_id = $1 ORDER BY cr.created_at DESC LIMIT 300`,
      [req.params.id]
    );

    res.json({ ...cust.rows[0], sales: sales.rows, payments: payments.rows, returns: returns.rows });
  } catch (err) {
    next(err);
  }
}

// POST /api/customers  { customer_type, name, phone, address, opening_balance? }
async function createCustomer(req, res, next) {
  try {
    const name = (req.body.name || '').trim();
    const type = req.body.customer_type;
    if (!name) return res.status(400).json({ error: 'Enter a name.' });
    if (!['general', 'credit', 'reseller'].includes(type)) {
      return res.status(400).json({ error: 'Choose a customer type.' });
    }
    // Only credit/distributor customers carry a balance.
    let opening = type === 'general' ? 0 : Number(req.body.opening_balance);
    if (!opening || isNaN(opening) || opening < 0) opening = 0;

    const { rows } = await query(
      `INSERT INTO customers (company_id, customer_type, name, phone, address, balance_owed)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.company.id, type, name, req.body.phone || null, req.body.address || null, opening]
    );
    await logAction({
      userId: req.user.id, action: 'create_customer',
      entity: 'customer', entityId: rows[0].id,
      details: { opening_balance: opening }, ip: req.ip,
    });
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
}

// PATCH /api/customers/:id/balance  { balance_owed }   (ADMIN ONLY)
// Directly set the amount a customer owes. Used to correct balances or set a
// reseller's opening balance after registration. The change is audit-logged.
async function updateBalance(req, res, next) {
  try {
    let bal = Number(req.body.balance_owed);
    if (isNaN(bal) || bal < 0) return res.status(400).json({ error: 'Enter a valid amount (0 or more).' });

    const before = await query('SELECT balance_owed FROM customers WHERE id = $1', [req.params.id]);
    if (!before.rows.length) return res.status(404).json({ error: 'Customer not found.' });

    const { rows } = await query(
      `UPDATE customers SET balance_owed = $1 WHERE id = $2 RETURNING *`,
      [bal, req.params.id]
    );
    await logAction({
      userId: req.user.id, action: 'adjust_balance',
      entity: 'customer', entityId: req.params.id,
      details: { from: Number(before.rows[0].balance_owed), to: bal }, ip: req.ip,
    });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
}

// PUT /api/customers/:id  { name, phone, address }
async function updateCustomer(req, res, next) {
  try {
    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Enter a name.' });

    const { rows } = await query(
      `UPDATE customers SET name = $1, phone = $2, address = $3
       WHERE id = $4 RETURNING *`,
      [name, req.body.phone || null, req.body.address || null, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Customer not found.' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
}

module.exports = { listCustomers, getCustomer, createCustomer, updateCustomer, updateBalance };
