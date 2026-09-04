// ============================================================
//  Sales: cash, credit, and reseller.
//   - The price SOLD is recorded per item (unit_price) and may differ
//     from the product's recommended price.
//   - Stock is deducted from the selling branch, safely (it can't go
//     below zero, and the whole sale rolls back if any item is short).
//   - Each sale gets a permanent unique invoice_number so the receipt
//     can be reprinted later by date.
//   - For credit/reseller sales, the unpaid part is added to the
//     customer's balance_owed.
// ============================================================
const { actionDate, editDate } = require('../utils/dates');
const { buildSplits } = require('../utils/payments');
const { can } = require('../utils/permissions');
const { query, withTransaction } = require('../config/db');
const idempotency = require('../utils/idempotency');
const { logAction } = require('../utils/audit');

// POST /api/sales
// {
//   branch_id, sale_type: 'cash'|'credit'|'reseller',
//   customer_id (required for credit/reseller),
//   amount_paid (optional for credit/reseller; cash is always paid in full),
//   items: [ { product_id, quantity, unit_price }, ... ]
// }
async function createSale(req, res, next) {
  const { branch_id, sale_type, customer_id, items } = req.body;
  let amountPaid = req.body.amount_paid;
  const VALID_METHODS = ['cash', 'pos', 'transfer_moniepoint', 'transfer_zenith', 'cheque'];
  const paymentMethod = VALID_METHODS.includes(req.body.payment_method)
    ? req.body.payment_method : 'cash';

  if (!branch_id) return res.status(400).json({ error: 'Choose a branch.' });
  if (!['cash', 'credit', 'reseller'].includes(sale_type)) {
    return res.status(400).json({ error: 'Choose a sale type.' });
  }
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Add at least one item.' });
  }
  if (items.length > 300) {
    return res.status(400).json({ error: 'Too many items on one sale (max 300).' });
  }
  if (!customer_id) {
    return res.status(400).json({ error: 'Choose or create a customer for this sale.' });
  }

  // Feature gates: which sale types this user may record, and whether they may
  // back-date or split the payment. Admins pass everything.
  const typeFeature = sale_type === 'cash' ? 'sale.cash' : sale_type === 'credit' ? 'sale.credit' : 'sale.distributor';
  if (!(await can(req.user, typeFeature))) {
    return res.status(403).json({ error: 'You are not allowed to record this type of sale.' });
  }
  if (req.body.created_at && !(await can(req.user, 'sale.backdate'))) {
    delete req.body.created_at; // silently ignore a back-date they can't set
  }
  if (Array.isArray(req.body.payment_splits) && req.body.payment_splits.length > 1 && !(await can(req.user, 'payment.split'))) {
    return res.status(403).json({ error: 'You are not allowed to split payments.' });
  }

  const idemKey = req.get('Idempotency-Key');
  try {
    const gate = await idempotency.begin(idemKey, 'sale');
    if (!gate.proceed) {
      if (gate.replay) return res.status(201).json(gate.replay);
      return res.status(409).json({ error: 'This sale is already being processed. Please wait a moment.' });
    }
  } catch (e) { /* if the idempotency check itself fails, continue normally */ }

  try {
    const sale = await withTransaction(async (client) => {
      // 1. Branch must belong to this company.
      const br = await client.query(
        'SELECT id FROM branches WHERE id = $1 AND company_id = $2',
        [branch_id, req.company.id]
      );
      if (!br.rows.length) { const e = new Error('Branch not found.'); e.status = 404; throw e; }

      // 2. Customer must exist. For credit/distributor sales the type must match;
      //    cash sales can be to any customer (usually a General/walk-in one).
      const cust = await client.query(
        'SELECT id, customer_type FROM customers WHERE id = $1',
        [customer_id]
      );
      if (!cust.rows.length) { const e = new Error('Customer not found.'); e.status = 404; throw e; }
      let customer = null;
      if (sale_type !== 'cash') {
        const expected = sale_type === 'credit' ? 'credit' : 'reseller';
        if (cust.rows[0].customer_type !== expected) {
          const e = new Error(`That customer is not a ${expected === 'reseller' ? 'distributor' : 'credit'} customer.`);
          e.status = 400; throw e;
        }
        customer = cust.rows[0]; // only credit/distributor affect balance
      }

      // 3. Validate every item and check stock (locking each row).
      let total = 0;
      const prepared = [];
      for (const item of items) {
        const qtyUnits = parseInt(item.quantity, 10);   // in the chosen unit (piece or carton)
        const unitPrice = Number(item.unit_price);       // price per chosen unit
        if (!item.product_id || !qtyUnits || qtyUnits <= 0 || isNaN(unitPrice) || unitPrice < 0) {
          const e = new Error('Each item needs a product, a quantity, and a price.');
          e.status = 400; throw e;
        }
        // Product can belong to either company (cross-company stock sold from
        // this branch counts under the selling company).
        const prod = await client.query(
          'SELECT id, cost_price, name, qty_per_carton FROM products WHERE id = $1',
          [item.product_id]
        );
        if (!prod.rows.length) { const e = new Error('Product not found.'); e.status = 404; throw e; }

        // Work out the pack size (pieces per sold unit).
        const soldAs = item.sold_as === 'carton' ? 'carton' : 'piece';
        let packSize = 1;
        if (soldAs === 'carton') {
          packSize = parseInt(item.pack_size, 10) || parseInt(prod.rows[0].qty_per_carton, 10) || 0;
          if (!packSize || packSize < 1) {
            const e = new Error(`${prod.rows[0].name} has no carton size set. Sell by piece or set a carton size first.`);
            e.status = 400; throw e;
          }
        }
        const pieces = qtyUnits * packSize;             // stock is always counted in pieces

        const sl = await client.query(
          'SELECT quantity FROM stock_levels WHERE product_id = $1 AND branch_id = $2 FOR UPDATE',
          [item.product_id, branch_id]
        );
        const have = sl.rows.length ? sl.rows[0].quantity : 0;
        if (have < pieces) {
          const e = new Error(`Not enough stock for ${prod.rows[0].name}. Available: ${have} pcs.`);
          e.status = 400; throw e;
        }

        const piecePrice = unitPrice / packSize;         // per-piece price for reports/profit
        const subtotal = qtyUnits * unitPrice;           // exact line total
        total += subtotal;
        prepared.push({
          product_id: item.product_id, pieces, piecePrice,
          costPrice: prod.rows[0].cost_price, subtotal, soldAs, packSize,
        });
      }

      // 4. Work out how much was paid now.
      if (sale_type === 'cash') {
        amountPaid = total; // cash is paid in full
      } else {
        amountPaid = amountPaid ? Number(amountPaid) : 0;
        if (amountPaid < 0) amountPaid = 0;
        if (amountPaid > total) {
          const e = new Error('Amount paid cannot be more than the total.');
          e.status = 400; throw e;
        }
      }

      // Optional split across multiple payment methods (must add up to amountPaid).
      const { splits: paySplits, primary: primaryMethod } = buildSplits(req.body.payment_splits, amountPaid, paymentMethod);

      // 5. Insert the sale. A throwaway unique value is used first, then we
      //    set a friendly invoice number built from the new row's id.
      const inserted = await client.query(
        `INSERT INTO sales
           (company_id, branch_id, user_id, customer_id, sale_type, payment_method, invoice_number, total_amount, amount_paid, created_at, payment_splits)
         VALUES ($1, $2, $3, $4, $5, $6, md5(random()::text || clock_timestamp()::text), $7, $8, COALESCE($9::timestamptz, now()), $10::jsonb)
         RETURNING id`,
        [req.company.id, branch_id, req.user.id, customer ? customer.id : null, sale_type, primaryMethod, total, amountPaid, actionDate(req.body.created_at), paySplits]
      );
      const saleId = inserted.rows[0].id;

      const invNo = `${req.company.code}-${String(saleId).padStart(6, '0')}`;
      await client.query('UPDATE sales SET invoice_number = $1 WHERE id = $2', [invNo, saleId]);

      // 6. Save items, deduct stock, log the movement.
      for (const p of prepared) {
        await client.query(
          `INSERT INTO sale_items (sale_id, product_id, quantity, unit_price, cost_price, subtotal, sold_as, pack_size)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [saleId, p.product_id, p.pieces, p.piecePrice, p.costPrice, p.subtotal, p.soldAs, p.packSize]
        );
        await client.query(
          'UPDATE stock_levels SET quantity = quantity - $1, updated_at = now() WHERE product_id = $2 AND branch_id = $3',
          [p.pieces, p.product_id, branch_id]
        );
        await client.query(
          `INSERT INTO stock_movements
             (company_id, product_id, from_branch_id, quantity, movement_type, reference_id, user_id)
           VALUES ($1, $2, $3, $4, 'sale', $5, $6)`,
          [req.company.id, p.product_id, branch_id, p.pieces, saleId, req.user.id]
        );
      }

      // 7. For credit/reseller, add the unpaid part to their balance.
      if (customer) {
        const owedAdded = total - amountPaid;
        if (owedAdded > 0) {
          await client.query(
            'UPDATE customers SET balance_owed = balance_owed + $1 WHERE id = $2',
            [owedAdded, customer.id]
          );
        }
      }

      // 8. If this sale came from a quotation, mark that quote converted now
      //    (only once the sale is actually saved — not at click time).
      if (req.body.quote_id) {
        await client.query(
          `UPDATE quotations SET status = 'converted'
           WHERE id = $1 AND company_id = $2 AND status <> 'converted'`,
          [req.body.quote_id, req.company.id]
        );
      }

      return { id: saleId, invoice_number: invNo, total_amount: total, amount_paid: amountPaid };
    });

    await logAction({
      userId: req.user.id, action: 'create_sale',
      entity: 'sale', entityId: sale.id,
      details: { sale_type, total: sale.total_amount }, ip: req.ip,
    });
    const payload = { message: 'Sale recorded.', ...sale };
    await idempotency.finish(idemKey, payload);
    res.status(201).json(payload);
  } catch (err) {
    await idempotency.fail(idemKey);
    next(err);
  }
}

// GET /api/sales/:id  -> everything needed to print the receipt/invoice.
async function getSale(req, res, next) {
  try {
    const sale = await query(
      `SELECT s.*, b.name AS branch_name, u.full_name AS sold_by,
              cu.name AS customer_name, cu.phone AS customer_phone, cu.customer_type,
              co.code AS company_code, co.name AS company_name,
              co.address AS company_address, co.phone AS company_phone
       FROM sales s
       JOIN branches b ON b.id = s.branch_id
       JOIN users u ON u.id = s.user_id
       JOIN companies co ON co.id = s.company_id
       LEFT JOIN customers cu ON cu.id = s.customer_id
       WHERE s.id = $1 AND s.company_id = $2`,
      [req.params.id, req.company.id]
    );
    if (!sale.rows.length) return res.status(404).json({ error: 'Sale not found.' });

    const itemRows = await query(
      `SELECT si.product_id, si.quantity, si.unit_price, si.subtotal,
              si.sold_as, si.pack_size,
              p.name, p.product_code, p.unit
       FROM sale_items si
       JOIN products p ON p.id = si.product_id
       WHERE si.sale_id = $1`,
      [req.params.id]
    );

    res.json({ ...sale.rows[0], items: itemRows.rows });
  } catch (err) {
    next(err);
  }
}

// GET /api/sales?sale_type=&customer_id=&branch_id=&from=&to=
// Powers the Records pages and "find a past receipt by date".
async function listSales(req, res, next) {
  try {
    const params = [req.company.id];
    let where = 'WHERE s.company_id = $1';

    if (req.query.sale_type) {
      params.push(req.query.sale_type);
      where += ` AND s.sale_type = $${params.length}`;
    }
    if (req.query.customer_id) {
      params.push(req.query.customer_id);
      where += ` AND s.customer_id = $${params.length}`;
    }
    if (req.query.branch_id) {
      params.push(req.query.branch_id);
      where += ` AND s.branch_id = $${params.length}`;
    }
    if (req.query.from) {
      params.push(req.query.from);
      where += ` AND s.created_at >= $${params.length}`;
    }
    if (req.query.to) {
      params.push(req.query.to);
      where += ` AND s.created_at < ($${params.length}::date + 1)`; // include the whole "to" day
    }

    const { rows } = await query(
      `SELECT s.id, s.invoice_number, s.sale_type, s.total_amount, s.amount_paid, s.created_at,
              b.name AS branch_name, u.full_name AS sold_by, cu.name AS customer_name
       FROM sales s
       JOIN branches b ON b.id = s.branch_id
       JOIN users u ON u.id = s.user_id
       LEFT JOIN customers cu ON cu.id = s.customer_id
       ${where}
       ORDER BY s.created_at DESC
       LIMIT 500`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

// GET /api/sales/by-invoice/:invoice
// Look a sale up by its invoice number so it can be returned. Each item shows
// how many were sold and how many are still returnable.
async function getSaleByInvoice(req, res, next) {
  try {
    const inv = (req.params.invoice || '').trim();
    const sale = await query(
      `SELECT s.id, s.invoice_number, s.sale_type, s.total_amount, s.created_at,
              s.branch_id, b.name AS branch_name, u.full_name AS sold_by,
              cu.name AS customer_name, cu.customer_type
       FROM sales s
       JOIN branches b ON b.id = s.branch_id
       JOIN users u ON u.id = s.user_id
       LEFT JOIN customers cu ON cu.id = s.customer_id
       WHERE UPPER(s.invoice_number) = UPPER($1) AND s.company_id = $2`,
      [inv, req.company.id]
    );
    if (!sale.rows.length) return res.status(404).json({ error: 'No sale found with that invoice number.' });
    const s = sale.rows[0];

    const items = await query(
      `SELECT si.product_id, si.quantity, si.unit_price, si.subtotal,
              p.name, p.product_code,
              COALESCE((SELECT SUM(r.quantity) FROM returns r
                        WHERE r.sale_id = si.sale_id AND r.product_id = si.product_id), 0)::int AS returned
       FROM sale_items si
       JOIN products p ON p.id = si.product_id
       WHERE si.sale_id = $1`,
      [s.id]
    );
    res.json({
      ...s,
      items: items.rows.map((it) => ({ ...it, remaining: it.quantity - it.returned })),
    });
  } catch (err) {
    next(err);
  }
}


// PATCH /api/sales/:id/date  (admin) — change the date of a past sale.
async function editSaleDate(req, res, next) {
  try {
    const when = editDate(req.body.date);
    const r = await query('UPDATE sales SET created_at = $1 WHERE id = $2 AND company_id = $3 RETURNING id, created_at',
      [when, req.params.id, req.company.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Sale not found.' });
    res.json({ message: 'Date updated.', ...r.rows[0] });
  } catch (err) { next(err); }
}


// PATCH /api/sales/:id/customer  { customer_id }  (admin) — attribute a past
// sale to a customer (fixes legacy sales that show no name). Adjusts balances
// when the sale was on credit so the debt follows the customer.
async function editSaleCustomer(req, res, next) {
  try {
    const newCustomerId = req.body.customer_id;
    if (!newCustomerId) return res.status(400).json({ error: 'Choose a customer.' });
    await withTransaction(async (client) => {
      const sale = await client.query('SELECT id, customer_id, sale_type, total_amount, amount_paid FROM sales WHERE id = $1 AND company_id = $2 FOR UPDATE', [req.params.id, req.company.id]);
      if (!sale.rows.length) { const e = new Error('Sale not found.'); e.status = 404; throw e; }
      const s = sale.rows[0];
      const owed = Number(s.total_amount) - Number(s.amount_paid);
      const cust = await client.query('SELECT id FROM customers WHERE id = $1', [newCustomerId]);
      if (!cust.rows.length) { const e = new Error('Customer not found.'); e.status = 404; throw e; }
      // Move any outstanding balance from the old customer (if any) to the new one.
      if (s.sale_type !== 'cash' && owed > 0) {
        if (s.customer_id) await client.query('UPDATE customers SET balance_owed = GREATEST(balance_owed - $1, 0) WHERE id = $2', [owed, s.customer_id]);
        await client.query('UPDATE customers SET balance_owed = balance_owed + $1 WHERE id = $2', [owed, newCustomerId]);
      }
      await client.query('UPDATE sales SET customer_id = $1 WHERE id = $2', [newCustomerId, req.params.id]);
    });
    res.json({ message: 'Customer updated for this sale.' });
  } catch (err) { next(err); }
}

module.exports = { createSale, getSale, listSales, getSaleByInvoice, editSaleDate, editSaleCustomer };
