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
      'SELECT * FROM customers WHERE id = $1 AND company_id = $2',
      [req.params.id, req.company.id]
    );
    if (!cust.rows.length) return res.status(404).json({ error: 'Customer not found.' });

    const sales = await query(
      `SELECT id, invoice_number, sale_type, total_amount, amount_paid, created_at
       FROM sales WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 200`,
      [req.params.id]
    );
    const payments = await query(
      `SELECT id, amount, note, created_at
       FROM payments WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 200`,
      [req.params.id]
    );

    res.json({ ...cust.rows[0], sales: sales.rows, payments: payments.rows });
  } catch (err) {
    next(err);
  }
}

// POST /api/customers  { customer_type, name, phone, address }
async function createCustomer(req, res, next) {
  try {
    const name = (req.body.name || '').trim();
    const type = req.body.customer_type;
    if (!name) return res.status(400).json({ error: 'Enter a name.' });
    if (!['credit', 'reseller'].includes(type)) {
      return res.status(400).json({ error: 'Choose credit customer or bulk reseller.' });
    }

    const { rows } = await query(
      `INSERT INTO customers (company_id, customer_type, name, phone, address)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.company.id, type, name, req.body.phone || null, req.body.address || null]
    );
    await logAction({
      userId: req.user.id, action: 'create_customer',
      entity: 'customer', entityId: rows[0].id, ip: req.ip,
    });
    res.status(201).json(rows[0]);
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

module.exports = { listCustomers, getCustomer, createCustomer, updateCustomer };
