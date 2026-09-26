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
      `SELECT c.id, c.name, c.phone, c.address, c.customer_type, c.balance_owed, c.store_credit, c.created_at,
              COALESCE(pc.n, 0)::int AS purchase_count,
              pc.last_purchase
       FROM customers c
       LEFT JOIN (
         SELECT customer_id, COUNT(*) AS n, MAX(created_at) AS last_purchase
         FROM sales WHERE customer_id IS NOT NULL GROUP BY customer_id
       ) pc ON pc.customer_id = c.id
       ${where.replace(/customer_type/g, 'c.customer_type').replace(/\bname ILIKE/g, 'c.name ILIKE').replace(/\bphone ILIKE/g, 'c.phone ILIKE')}
       ORDER BY c.name`,
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
    // A real name must contain at least four letters (guards against blank or
    // symbol-only entries that were leaving records without a customer name).
    if ((name.match(/[A-Za-z]/g) || []).length < 4) {
      return res.status(400).json({ error: 'Enter a proper name with at least 4 letters.' });
    }
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


// PATCH /api/customers/:id/upgrade — turn a general/credit customer into a distributor.
async function upgradeToDistributor(req, res, next) {
  try {
    const cur = await query('SELECT id, customer_type FROM customers WHERE id = $1', [req.params.id]);
    if (!cur.rows.length) return res.status(404).json({ error: 'Customer not found.' });
    if (cur.rows[0].customer_type === 'reseller') return res.status(400).json({ error: 'This customer is already a distributor.' });
    const { rows } = await query(
      "UPDATE customers SET customer_type = 'reseller' WHERE id = $1 RETURNING *",
      [req.params.id]
    );
    res.json({ message: 'Customer upgraded to distributor.', customer: rows[0] });
  } catch (err) { next(err); }
}


// GET /api/customers/:id/purchases
// Products this customer has bought, each with the dates/quantities/prices,
// so a return can be tied to the exact purchase. Spans both companies.
async function getPurchases(req, res, next) {
  try {
    const { rows } = await query(
      `SELECT si.product_id, p.name AS product_name, p.product_code,
              s.id AS sale_id, s.invoice_number, s.created_at, s.branch_id, co.code AS company_code,
              si.quantity, si.unit_price,
              COALESCE((SELECT SUM(cri.quantity) FROM customer_return_items cri
                        JOIN customer_returns cr ON cr.id = cri.return_id
                        WHERE cr.customer_id = s.customer_id AND cri.product_id = si.product_id
                          AND cr.created_at >= s.created_at), 0) AS already_returned
       FROM sale_items si
       JOIN sales s ON s.id = si.sale_id
       JOIN products p ON p.id = si.product_id
       JOIN companies co ON co.id = s.company_id
       WHERE s.customer_id = $1
       ORDER BY p.name, s.created_at DESC`,
      [req.params.id]
    );
    // Group by product, list each purchase (date) under it.
    const byProduct = new Map();
    for (const r of rows) {
      if (!byProduct.has(r.product_id)) {
        byProduct.set(r.product_id, { product_id: r.product_id, name: r.product_name, product_code: r.product_code, purchases: [] });
      }
      byProduct.get(r.product_id).purchases.push({
        sale_id: r.sale_id, invoice_number: r.invoice_number, created_at: r.created_at,
        branch_id: r.branch_id, company_code: r.company_code,
        quantity: Number(r.quantity), unit_price: Number(r.unit_price),
      });
    }
    res.json([...byProduct.values()]);
  } catch (err) { next(err); }
}

module.exports = { listCustomers, getCustomer, createCustomer, updateCustomer, updateBalance, upgradeToDistributor, getPurchases };
