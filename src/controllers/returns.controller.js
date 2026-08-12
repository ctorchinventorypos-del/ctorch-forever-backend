// ============================================================
//  Returns: a customer brings goods back.
//   - The quantity is added BACK to stock at a branch.
//   - For a credit/reseller sale, the value of the returned goods is
//     taken off the customer's balance_owed, clamped at zero.
//   - You can't return more than was sold (minus anything already
//     returned on that sale).
// ============================================================
const { query, withTransaction } = require('../config/db');
const { logAction } = require('../utils/audit');
const idempotency = require('../utils/idempotency');

// POST /api/returns  { sale_id, product_id, quantity, branch_id?, unit_price? }
// branch_id defaults to the branch the sale was made from.
// unit_price defaults to the price the item was sold at.
async function createReturn(req, res, next) {
  const { sale_id, product_id } = req.body;
  const qty = parseInt(req.body.quantity, 10);

  if (!sale_id || !product_id) return res.status(400).json({ error: 'Choose a sale and a product.' });
  if (!qty || qty <= 0) return res.status(400).json({ error: 'Enter a quantity greater than 0.' });

  const idemKey = req.get('Idempotency-Key');
  try {
    const gate = await idempotency.begin(idemKey, 'return');
    if (!gate.proceed) {
      if (gate.replay) return res.status(201).json(gate.replay);
      return res.status(409).json({ error: 'This return is already being processed. Please wait a moment.' });
    }
  } catch (e) { /* continue if the check itself errors */ }

  try {
    const result = await withTransaction(async (client) => {
      // 1. Sale must belong to this company.
      const sale = await client.query(
        'SELECT id, branch_id, customer_id FROM sales WHERE id = $1 AND company_id = $2',
        [sale_id, req.company.id]
      );
      if (!sale.rows.length) { const e = new Error('Sale not found.'); e.status = 404; throw e; }
      const s = sale.rows[0];

      // 2. The product must be on that sale (gives us the sold price + qty).
      const item = await client.query(
        'SELECT quantity, unit_price FROM sale_items WHERE sale_id = $1 AND product_id = $2',
        [sale_id, product_id]
      );
      if (!item.rows.length) { const e = new Error('That product is not on this sale.'); e.status = 400; throw e; }
      const soldQty = item.rows[0].quantity;
      const unitPrice = req.body.unit_price != null ? Number(req.body.unit_price) : Number(item.rows[0].unit_price);

      // 3. Don't allow returning more than is left to return.
      const already = await client.query(
        'SELECT COALESCE(SUM(quantity), 0)::int AS q FROM returns WHERE sale_id = $1 AND product_id = $2',
        [sale_id, product_id]
      );
      const remaining = soldQty - already.rows[0].q;
      if (qty > remaining) {
        const e = new Error(`Cannot return ${qty}. Only ${remaining} left to return on this sale.`);
        e.status = 400; throw e;
      }

      // 4. Work out which branch the stock returns to.
      const branchId = req.body.branch_id || s.branch_id;
      const br = await client.query('SELECT id FROM branches WHERE id = $1 AND company_id = $2', [branchId, req.company.id]);
      if (!br.rows.length) { const e = new Error('Branch not found.'); e.status = 404; throw e; }

      const refund = qty * unitPrice;

      // 5. Add the stock back.
      await client.query(
        `INSERT INTO stock_levels (product_id, branch_id, quantity)
         VALUES ($1, $2, $3)
         ON CONFLICT (product_id, branch_id)
         DO UPDATE SET quantity = stock_levels.quantity + EXCLUDED.quantity, updated_at = now()`,
        [product_id, branchId, qty]
      );
      await client.query(
        `INSERT INTO stock_movements
           (company_id, product_id, to_branch_id, quantity, movement_type, reference_id, user_id)
         VALUES ($1, $2, $3, $4, 'return', $5, $6)`,
        [req.company.id, product_id, branchId, qty, sale_id, req.user.id]
      );

      // 6. Record the return.
      const ret = await client.query(
        `INSERT INTO returns
           (company_id, sale_id, product_id, branch_id, quantity, unit_price, refund_amount, user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [req.company.id, sale_id, product_id, branchId, qty, unitPrice, refund, req.user.id]
      );

      // 7. If this sale was on credit, lower the customer's balance (clamped at 0).
      let newBalance = null;
      if (s.customer_id) {
        const upd = await client.query(
          'UPDATE customers SET balance_owed = GREATEST(balance_owed - $1, 0) WHERE id = $2 RETURNING balance_owed',
          [refund, s.customer_id]
        );
        newBalance = upd.rows[0].balance_owed;
      }

      return {
        return_id: ret.rows[0].id, quantity: qty, refund_amount: refund,
        returned_to_branch: branchId, customer_new_balance: newBalance,
      };
    });

    await logAction({
      userId: req.user.id, action: 'record_return',
      entity: 'return', entityId: result.return_id,
      details: { sale_id, product_id, quantity: qty }, ip: req.ip,
    });
    const payload = { message: 'Return recorded. Stock added back.', ...result };
    await idempotency.finish(idemKey, payload);
    res.status(201).json(payload);
  } catch (err) {
    await idempotency.fail(idemKey);
    next(err);
  }
}

// GET /api/returns?sale_id=&from=&to=
async function listReturns(req, res, next) {
  try {
    const params = [req.company.id];
    let where = 'WHERE r.company_id = $1';

    if (req.query.sale_id) {
      params.push(req.query.sale_id);
      where += ` AND r.sale_id = $${params.length}`;
    }
    if (req.query.from) {
      params.push(req.query.from);
      where += ` AND r.created_at >= $${params.length}`;
    }
    if (req.query.to) {
      params.push(req.query.to);
      where += ` AND r.created_at < ($${params.length}::date + 1)`;
    }

    const { rows } = await query(
      `SELECT r.id, r.quantity, r.unit_price, r.refund_amount, r.created_at,
              p.name AS product_name, p.product_code,
              s.invoice_number, b.name AS returned_to,
              u.full_name AS processed_by
       FROM returns r
       JOIN products p ON p.id = r.product_id
       JOIN sales s ON s.id = r.sale_id
       JOIN branches b ON b.id = r.branch_id
       LEFT JOIN users u ON u.id = r.user_id
       ${where}
       ORDER BY r.created_at DESC
       LIMIT 500`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

module.exports = { createReturn, listReturns };

// ============================================================
//  Customer-based returns (reworked flow).
// ============================================================

// POST /api/returns/customer
// { customer_id, branch_id, items: [{ product_id, quantity, unit_price }], note }
async function createCustomerReturn(req, res, next) {
  const { customer_id, branch_id, note } = req.body;
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  if (!customer_id) return res.status(400).json({ error: 'Choose the customer returning the goods.' });
  if (!branch_id) return res.status(400).json({ error: 'Choose where the goods are returned to.' });
  if (items.length === 0) return res.status(400).json({ error: 'Add at least one product to return.' });

  const idemKey = req.get('Idempotency-Key');
  try {
    const gate = await idempotency.begin(idemKey, 'customer_return');
    if (!gate.proceed) {
      if (gate.replay) return res.status(201).json(gate.replay);
      return res.status(409).json({ error: 'This return is already being processed. Please wait a moment.' });
    }
  } catch (_) { /* continue */ }

  try {
    const result = await withTransaction(async (client) => {
      const cust = await client.query('SELECT id, customer_type FROM customers WHERE id = $1', [customer_id]);
      if (!cust.rows.length) { const e = new Error('Customer not found.'); e.status = 404; throw e; }
      const br = await client.query('SELECT id FROM branches WHERE id = $1 AND company_id = $2', [branch_id, req.company.id]);
      if (!br.rows.length) { const e = new Error('Branch not found.'); e.status = 404; throw e; }

      let total = 0;
      const prepared = [];
      for (const it of items) {
        const qty = parseInt(it.quantity, 10);
        const price = Number(it.unit_price) || 0;
        if (!it.product_id || !qty || qty <= 0) { const e = new Error('Each line needs a product and a quantity.'); e.status = 400; throw e; }
        const prod = await client.query('SELECT id, name FROM products WHERE id = $1 AND company_id = $2', [it.product_id, req.company.id]);
        if (!prod.rows.length) { const e = new Error('Product not found.'); e.status = 404; throw e; }
        const subtotal = qty * price;
        total += subtotal;
        prepared.push({ product_id: it.product_id, qty, price, subtotal });
      }

      // Header (temporary number first, then a friendly one built from the id).
      const header = await client.query(
        `INSERT INTO customer_returns (company_id, customer_id, branch_id, return_number, total_amount, note, user_id)
         VALUES ($1, $2, $3, md5(random()::text), $4, $5, $6) RETURNING id`,
        [req.company.id, customer_id, branch_id, total, note || null, req.user.id]
      );
      const returnId = header.rows[0].id;
      const returnNumber = `${req.company.code}-R${String(returnId).padStart(5, '0')}`;
      await client.query('UPDATE customer_returns SET return_number = $1 WHERE id = $2', [returnNumber, returnId]);

      for (const p of prepared) {
        await client.query(
          `INSERT INTO customer_return_items (return_id, product_id, quantity, unit_price, subtotal)
           VALUES ($1, $2, $3, $4, $5)`,
          [returnId, p.product_id, p.qty, p.price, p.subtotal]
        );
        // Add the returned stock back to the chosen branch.
        await client.query(
          `INSERT INTO stock_levels (product_id, branch_id, quantity) VALUES ($1, $2, $3)
           ON CONFLICT (product_id, branch_id)
           DO UPDATE SET quantity = stock_levels.quantity + EXCLUDED.quantity, updated_at = now()`,
          [p.product_id, branch_id, p.qty]
        );
        await client.query(
          `INSERT INTO stock_movements (company_id, product_id, to_branch_id, quantity, movement_type, note, user_id)
           VALUES ($1, $2, $3, $4, 'return', $5, $6)`,
          [req.company.id, p.product_id, branch_id, p.qty, `Return ${returnNumber}`, req.user.id]
        );
      }

      // Credit / distributor: a return reduces what they owe.
      if (cust.rows[0].customer_type !== 'general' && total > 0) {
        await client.query(
          'UPDATE customers SET balance_owed = GREATEST(0, balance_owed - $1) WHERE id = $2',
          [total, customer_id]
        );
      }

      return { id: returnId, return_number: returnNumber, total_amount: total };
    });

    await logAction({ userId: req.user.id, action: 'customer_return', entity: 'return', entityId: result.id, details: { total: result.total_amount }, ip: req.ip });
    const payload = { message: 'Return recorded and stock added back.', ...result };
    await idempotency.finish(idemKey, payload);
    res.status(201).json(payload);
  } catch (err) {
    await idempotency.fail(idemKey);
    next(err);
  }
}

// GET /api/returns/customer  — list for Records
async function listCustomerReturns(req, res, next) {
  try {
    const params = [req.company.id];
    let filter = '';
    if (req.query.from) { params.push(req.query.from); filter += ` AND cr.created_at::date >= $${params.length}::date`; }
    if (req.query.to) { params.push(req.query.to); filter += ` AND cr.created_at::date <= $${params.length}::date`; }
    const { rows } = await query(
      `SELECT cr.id, cr.return_number, cr.total_amount, cr.created_at,
              cu.name AS customer_name, b.name AS branch_name, u.full_name AS processed_by
       FROM customer_returns cr
       JOIN customers cu ON cu.id = cr.customer_id
       JOIN branches b ON b.id = cr.branch_id
       JOIN users u ON u.id = cr.user_id
       WHERE cr.company_id = $1 ${filter}
       ORDER BY cr.created_at DESC`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
}

// GET /api/returns/customer/:id  — detail for the printable return invoice
async function getCustomerReturn(req, res, next) {
  try {
    const head = await query(
      `SELECT cr.id, cr.return_number, cr.total_amount, cr.note, cr.created_at,
              cu.name AS customer_name, cu.phone AS customer_phone,
              b.name AS branch_name, u.full_name AS processed_by,
              co.name AS company_name, co.code AS company_code
       FROM customer_returns cr
       JOIN customers cu ON cu.id = cr.customer_id
       JOIN branches b ON b.id = cr.branch_id
       JOIN users u ON u.id = cr.user_id
       JOIN companies co ON co.id = cr.company_id
       WHERE cr.id = $1 AND cr.company_id = $2`,
      [req.params.id, req.company.id]
    );
    if (!head.rows.length) return res.status(404).json({ error: 'Return not found.' });
    const items = await query(
      `SELECT cri.product_id, cri.quantity, cri.unit_price, cri.subtotal, p.name, p.product_code
       FROM customer_return_items cri JOIN products p ON p.id = cri.product_id
       WHERE cri.return_id = $1`,
      [req.params.id]
    );
    res.json({ ...head.rows[0], items: items.rows });
  } catch (err) { next(err); }
}

module.exports.createCustomerReturn = createCustomerReturn;
module.exports.listCustomerReturns = listCustomerReturns;
module.exports.getCustomerReturn = getCustomerReturn;
