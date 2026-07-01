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
