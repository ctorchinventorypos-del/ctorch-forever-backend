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
const { query, withTransaction } = require('../config/db');
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
  const VALID_METHODS = ['cash', 'transfer', 'pos'];
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
  if (sale_type !== 'cash' && !customer_id) {
    return res.status(400).json({ error: 'Choose a customer for a credit or reseller sale.' });
  }

  try {
    const sale = await withTransaction(async (client) => {
      // 1. Branch must belong to this company.
      const br = await client.query(
        'SELECT id FROM branches WHERE id = $1 AND company_id = $2',
        [branch_id, req.company.id]
      );
      if (!br.rows.length) { const e = new Error('Branch not found.'); e.status = 404; throw e; }

      // 2. Customer must exist and match the sale type.
      let customer = null;
      if (sale_type !== 'cash') {
        const cust = await client.query(
          'SELECT id, customer_type FROM customers WHERE id = $1 AND company_id = $2',
          [customer_id, req.company.id]
        );
        if (!cust.rows.length) { const e = new Error('Customer not found.'); e.status = 404; throw e; }
        const expected = sale_type === 'credit' ? 'credit' : 'reseller';
        if (cust.rows[0].customer_type !== expected) {
          const e = new Error(`That customer is not a ${expected} customer.`);
          e.status = 400; throw e;
        }
        customer = cust.rows[0];
      }

      // 3. Validate every item and check stock (locking each row).
      let total = 0;
      const prepared = [];
      for (const item of items) {
        const qty = parseInt(item.quantity, 10);
        const unitPrice = Number(item.unit_price);
        if (!item.product_id || !qty || qty <= 0 || isNaN(unitPrice) || unitPrice < 0) {
          const e = new Error('Each item needs a product, a quantity, and a price.');
          e.status = 400; throw e;
        }
        const prod = await client.query(
          'SELECT id, cost_price, name FROM products WHERE id = $1 AND company_id = $2',
          [item.product_id, req.company.id]
        );
        if (!prod.rows.length) { const e = new Error('Product not found.'); e.status = 404; throw e; }

        const sl = await client.query(
          'SELECT quantity FROM stock_levels WHERE product_id = $1 AND branch_id = $2 FOR UPDATE',
          [item.product_id, branch_id]
        );
        const have = sl.rows.length ? sl.rows[0].quantity : 0;
        if (have < qty) {
          const e = new Error(`Not enough stock for ${prod.rows[0].name}. Available: ${have}.`);
          e.status = 400; throw e;
        }

        const subtotal = qty * unitPrice;
        total += subtotal;
        prepared.push({
          product_id: item.product_id, qty, unitPrice,
          costPrice: prod.rows[0].cost_price, subtotal,
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

      // 5. Insert the sale. A throwaway unique value is used first, then we
      //    set a friendly invoice number built from the new row's id.
      const inserted = await client.query(
        `INSERT INTO sales
           (company_id, branch_id, user_id, customer_id, sale_type, payment_method, invoice_number, total_amount, amount_paid)
         VALUES ($1, $2, $3, $4, $5, $6, md5(random()::text || clock_timestamp()::text), $7, $8)
         RETURNING id`,
        [req.company.id, branch_id, req.user.id, customer ? customer.id : null, sale_type, paymentMethod, total, amountPaid]
      );
      const saleId = inserted.rows[0].id;

      const invNo = `${req.company.code}-${String(saleId).padStart(6, '0')}`;
      await client.query('UPDATE sales SET invoice_number = $1 WHERE id = $2', [invNo, saleId]);

      // 6. Save items, deduct stock, log the movement.
      for (const p of prepared) {
        await client.query(
          `INSERT INTO sale_items (sale_id, product_id, quantity, unit_price, cost_price, subtotal)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [saleId, p.product_id, p.qty, p.unitPrice, p.costPrice, p.subtotal]
        );
        await client.query(
          'UPDATE stock_levels SET quantity = quantity - $1, updated_at = now() WHERE product_id = $2 AND branch_id = $3',
          [p.qty, p.product_id, branch_id]
        );
        await client.query(
          `INSERT INTO stock_movements
             (company_id, product_id, from_branch_id, quantity, movement_type, reference_id, user_id)
           VALUES ($1, $2, $3, $4, 'sale', $5, $6)`,
          [req.company.id, p.product_id, branch_id, p.qty, saleId, req.user.id]
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

      return { id: saleId, invoice_number: invNo, total_amount: total, amount_paid: amountPaid };
    });

    await logAction({
      userId: req.user.id, action: 'create_sale',
      entity: 'sale', entityId: sale.id,
      details: { sale_type, total: sale.total_amount }, ip: req.ip,
    });
    res.status(201).json({ message: 'Sale recorded.', ...sale });
  } catch (err) {
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

module.exports = { createSale, getSale, listSales };
