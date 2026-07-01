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
    const params = [req.company.id];
    let where = 'WHERE company_id = $1';

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
    const cust = await query(
      `SELECT cu.*, co.code AS company_code, co.name AS company_name,
              co.address AS company_address, co.phone AS company_phone
       FROM customers cu JOIN companies co ON co.id = cu.company_id
       WHERE cu.id = $1 AND cu.company_id = $2`,
      [req.params.id, req.company.id]
    );
    if (!cust.rows.length) return res.status(404).json({ error: 'Customer not found.' });

    const sales = await query(
      `SELECT id, invoice_number, sale_type, payment_method, total_amount, amount_paid, created_at
       FROM sales WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 200`,
      [req.params.id]
    );
    const payments = await query(
      `SELECT id, amount, payment_method, note, created_at
       FROM payments WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 200`,
      [req.params.id]
    );

    res.json({ ...cust.rows[0], sales: sales.rows, payments: payments.rows });
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
    if (!['credit', 'reseller'].includes(type)) {
      return res.status(400).json({ error: 'Choose credit customer or bulk reseller.' });
    }
    // Optional amount already owed at the time of registering (e.g. a reseller
    // who already has an outstanding balance). Never negative.
    let opening = Number(req.body.opening_balance);
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

    const before = await query('SELECT balance_owed FROM customers WHERE id = $1 AND company_id = $2', [req.params.id, req.company.id]);
    if (!before.rows.length) return res.status(404).json({ error: 'Customer not found.' });

    const { rows } = await query(
      `UPDATE customers SET balance_owed = $1 WHERE id = $2 AND company_id = $3 RETURNING *`,
      [bal, req.params.id, req.company.id]
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
       WHERE id = $4 AND company_id = $5 RETURNING *`,
      [name, req.body.phone || null, req.body.address || null, req.params.id, req.company.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Customer not found.' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
}

module.exports = { listCustomers, getCustomer, createCustomer, updateCustomer, updateBalance };
