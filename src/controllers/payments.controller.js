// ============================================================
//  Payments: money a credit customer or bulk reseller pays back.
//  Recording a payment lowers their balance_owed, but never below
//  zero (GREATEST(..., 0) handles overpayment safely).
// ============================================================
const { query, withTransaction } = require('../config/db');
const { logAction } = require('../utils/audit');

// POST /api/payments  { customer_id, amount, sale_id?, note? }
async function createPayment(req, res, next) {
  const { customer_id, sale_id, note } = req.body;
  const amount = Number(req.body.amount);
  const VALID_METHODS = ['cash', 'transfer', 'pos'];
  const paymentMethod = VALID_METHODS.includes(req.body.payment_method)
    ? req.body.payment_method : 'cash';

  if (!customer_id) return res.status(400).json({ error: 'Choose a customer.' });
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Enter an amount greater than 0.' });

  try {
    const result = await withTransaction(async (client) => {
      // Lock the customer row so two payments can't race each other.
      const cust = await client.query(
        'SELECT id, balance_owed FROM customers WHERE id = $1 AND company_id = $2 FOR UPDATE',
        [customer_id, req.company.id]
      );
      if (!cust.rows.length) { const e = new Error('Customer not found.'); e.status = 404; throw e; }

      const pay = await client.query(
        `INSERT INTO payments (company_id, customer_id, sale_id, amount, payment_method, user_id, note)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, amount, created_at`,
        [req.company.id, customer_id, sale_id || null, amount, paymentMethod, req.user.id, note || null]
      );

      // Reduce the balance, clamped at zero.
      const upd = await client.query(
        `UPDATE customers SET balance_owed = GREATEST(balance_owed - $1, 0)
         WHERE id = $2 RETURNING balance_owed`,
        [amount, customer_id]
      );

      return { payment_id: pay.rows[0].id, amount, new_balance: upd.rows[0].balance_owed };
    });

    await logAction({
      userId: req.user.id, action: 'record_payment',
      entity: 'payment', entityId: result.payment_id,
      details: { amount, customer_id }, ip: req.ip,
    });
    res.status(201).json({ message: 'Payment recorded.', ...result });
  } catch (err) {
    next(err);
  }
}

// GET /api/payments?customer_id=&customer_type=&from=&to=
// customer_type=credit   -> credit customers' payment records
// customer_type=reseller -> bulk resellers' payment records
async function listPayments(req, res, next) {
  try {
    const params = [req.company.id];
    let where = 'WHERE p.company_id = $1';

    if (req.query.customer_id) {
      params.push(req.query.customer_id);
      where += ` AND p.customer_id = $${params.length}`;
    }
    if (req.query.customer_type) {
      params.push(req.query.customer_type);
      where += ` AND cu.customer_type = $${params.length}`;
    }
    if (req.query.from) {
      params.push(req.query.from);
      where += ` AND p.created_at >= $${params.length}`;
    }
    if (req.query.to) {
      params.push(req.query.to);
      where += ` AND p.created_at < ($${params.length}::date + 1)`;
    }

    const { rows } = await query(
      `SELECT p.id, p.amount, p.note, p.payment_method, p.created_at,
              cu.name AS customer_name, cu.customer_type,
              u.full_name AS received_by
       FROM payments p
       JOIN customers cu ON cu.id = p.customer_id
       LEFT JOIN users u ON u.id = p.user_id
       ${where}
       ORDER BY p.created_at DESC
       LIMIT 500`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

// GET /api/payments/:id  -> data for a payment receipt (incl. amount remaining)
async function getPayment(req, res, next) {
  try {
    const { rows } = await query(
      `SELECT p.id, p.amount, p.note, p.payment_method, p.created_at,
              cu.name AS customer_name, cu.phone AS customer_phone,
              cu.balance_owed AS remaining, cu.customer_type,
              u.full_name AS received_by,
              co.code AS company_code, co.name AS company_name,
              co.address AS company_address, co.phone AS company_phone
       FROM payments p
       JOIN customers cu ON cu.id = p.customer_id
       JOIN companies co ON co.id = p.company_id
       LEFT JOIN users u ON u.id = p.user_id
       WHERE p.id = $1 AND p.company_id = $2`,
      [req.params.id, req.company.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Payment not found.' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
}

module.exports = { createPayment, listPayments, getPayment };
