// ============================================================
//  Warehouse Sale: a single sale that can include products from
//  BOTH companies, sold from each company's warehouse.
//  Behind the scenes it becomes one normal sale per company, so
//  each company's books and warehouse stock stay correct. The two
//  sales share a warehouse_ref so one combined invoice can show all.
// ============================================================
const { query, withTransaction } = require('../config/db');
const { logAction } = require('../utils/audit');
const idempotency = require('../utils/idempotency');

const VALID_METHODS = ['cash', 'pos', 'transfer_moniepoint', 'transfer_zenith', 'cheque'];

// GET /api/warehouse-sale/inventory
// All active products from BOTH companies with their warehouse stock.
async function inventory(req, res, next) {
  try {
    const { rows } = await query(
      `SELECT p.id, p.company_id, co.code AS company_code, co.name AS company_name,
              p.name, p.product_code, p.unit, p.recommended_price, p.qty_per_carton,
              COALESCE(sl.quantity, 0) AS warehouse_stock
       FROM products p
       JOIN companies co ON co.id = p.company_id
       JOIN branches b ON b.company_id = p.company_id AND b.is_warehouse = TRUE
       LEFT JOIN stock_levels sl ON sl.product_id = p.id AND sl.branch_id = b.id
       WHERE p.is_active = TRUE
       ORDER BY co.code, p.name`,
      []
    );
    res.json(rows.map((r) => ({
      ...r,
      recommended_price: Number(r.recommended_price),
      warehouse_stock: Number(r.warehouse_stock),
      qty_per_carton: r.qty_per_carton == null ? null : Number(r.qty_per_carton),
    })));
  } catch (err) { next(err); }
}

// POST /api/warehouse-sale
// { customer_id, sale_type, payment_method, items:[{product_id, quantity, unit_price, sold_as, pack_size}] }
async function createWarehouseSale(req, res, next) {
  const { customer_id, sale_type } = req.body;
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  const paymentMethod = VALID_METHODS.includes(req.body.payment_method) ? req.body.payment_method : 'cash';

  if (!['cash', 'credit', 'reseller'].includes(sale_type)) return res.status(400).json({ error: 'Choose a sale type.' });
  if (items.length === 0) return res.status(400).json({ error: 'Add at least one item.' });
  if (items.length > 300) return res.status(400).json({ error: 'Too many items (max 300).' });
  if (!customer_id) return res.status(400).json({ error: 'Choose or create a customer for this sale.' });

  const idemKey = req.get('Idempotency-Key');
  try {
    const gate = await idempotency.begin(idemKey, 'warehouse_sale');
    if (!gate.proceed) {
      if (gate.replay) return res.status(201).json(gate.replay);
      return res.status(409).json({ error: 'This sale is already being processed. Please wait a moment.' });
    }
  } catch (_) { /* continue */ }

  try {
    const result = await withTransaction(async (client) => {
      // Customer (shared across companies).
      const cust = await client.query('SELECT id, customer_type FROM customers WHERE id = $1', [customer_id]);
      if (!cust.rows.length) { const e = new Error('Customer not found.'); e.status = 404; throw e; }
      const isCredit = sale_type !== 'cash';
      if (isCredit) {
        const expected = sale_type === 'credit' ? 'credit' : 'reseller';
        if (cust.rows[0].customer_type !== expected) {
          const e = new Error(`That customer is not a ${expected === 'reseller' ? 'distributor' : 'credit'} customer.`);
          e.status = 400; throw e;
        }
      }

      // Resolve each product's company + validate, grouping by company.
      const byCompany = new Map(); // company_id -> [prepared items]
      for (const item of items) {
        const qtyUnits = parseInt(item.quantity, 10);
        const unitPrice = Number(item.unit_price);
        if (!item.product_id || !qtyUnits || qtyUnits <= 0 || isNaN(unitPrice) || unitPrice < 0) {
          const e = new Error('Each item needs a product, a quantity, and a price.'); e.status = 400; throw e;
        }
        const prod = await client.query(
          'SELECT id, company_id, cost_price, name, qty_per_carton FROM products WHERE id = $1',
          [item.product_id]
        );
        if (!prod.rows.length) { const e = new Error('Product not found.'); e.status = 404; throw e; }
        const p = prod.rows[0];

        const soldAs = item.sold_as === 'carton' ? 'carton' : 'piece';
        let packSize = 1;
        if (soldAs === 'carton') {
          packSize = parseInt(item.pack_size, 10) || parseInt(p.qty_per_carton, 10) || 0;
          if (!packSize || packSize < 1) { const e = new Error(`${p.name} has no carton size set.`); e.status = 400; throw e; }
        }
        const pieces = qtyUnits * packSize;
        const subtotal = qtyUnits * unitPrice;
        const piecePrice = unitPrice / packSize;

        if (!byCompany.has(p.company_id)) byCompany.set(p.company_id, []);
        byCompany.get(p.company_id).push({ product_id: p.id, pieces, piecePrice, costPrice: p.cost_price, subtotal, soldAs, packSize, name: p.name });
      }

      // One shared reference for all the per-company sales.
      const ref = 'WH-' + Date.now().toString(36).toUpperCase() + '-' + Math.floor(Math.random() * 1000);
      const sales = [];
      let combinedTotal = 0;

      for (const [companyId, groupItems] of byCompany) {
        // Company + its warehouse branch.
        const co = await client.query('SELECT id, code FROM companies WHERE id = $1', [companyId]);
        const wh = await client.query(
          'SELECT id FROM branches WHERE company_id = $1 AND is_warehouse = TRUE ORDER BY id LIMIT 1',
          [companyId]
        );
        if (!wh.rows.length) { const e = new Error('No warehouse branch found for a company in this sale.'); e.status = 400; throw e; }
        const branchId = wh.rows[0].id;

        // Lock stock + check availability at the warehouse.
        let total = 0;
        for (const it of groupItems) {
          const sl = await client.query(
            'SELECT quantity FROM stock_levels WHERE product_id = $1 AND branch_id = $2 FOR UPDATE',
            [it.product_id, branchId]
          );
          const have = sl.rows.length ? sl.rows[0].quantity : 0;
          if (have < it.pieces) { const e = new Error(`Not enough warehouse stock for ${it.name}. Available: ${have} pcs.`); e.status = 400; throw e; }
          total += it.subtotal;
        }

        // Cash → this company's slice is paid in full (the split follows the prices).
        // Credit/distributor → nothing paid now; the whole slice goes on the balance.
        const amountPaid = isCredit ? 0 : total;

        const inserted = await client.query(
          `INSERT INTO sales (company_id, branch_id, user_id, customer_id, sale_type, payment_method, invoice_number, total_amount, amount_paid, warehouse_ref)
           VALUES ($1,$2,$3,$4,$5,$6, md5(random()::text || clock_timestamp()::text), $7,$8,$9) RETURNING id`,
          [companyId, branchId, req.user.id, customer_id, sale_type, paymentMethod, total, amountPaid, ref]
        );
        const saleId = inserted.rows[0].id;
        const invNo = `${co.rows[0].code}-${String(saleId).padStart(6, '0')}`;
        await client.query('UPDATE sales SET invoice_number = $1 WHERE id = $2', [invNo, saleId]);

        for (const it of groupItems) {
          await client.query(
            `INSERT INTO sale_items (sale_id, product_id, quantity, unit_price, cost_price, subtotal, sold_as, pack_size)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [saleId, it.product_id, it.pieces, it.piecePrice, it.costPrice, it.subtotal, it.soldAs, it.packSize]
          );
          await client.query(
            'UPDATE stock_levels SET quantity = quantity - $1, updated_at = now() WHERE product_id = $2 AND branch_id = $3',
            [it.pieces, it.product_id, branchId]
          );
          await client.query(
            `INSERT INTO stock_movements (company_id, product_id, from_branch_id, quantity, movement_type, reference_id, user_id)
             VALUES ($1,$2,$3,$4,'sale',$5,$6)`,
            [companyId, it.product_id, branchId, it.pieces, saleId, req.user.id]
          );
        }

        // Credit/distributor: add the whole slice to the shared customer balance.
        if (isCredit) {
          await client.query('UPDATE customers SET balance_owed = balance_owed + $1 WHERE id = $2', [total, customer_id]);
        }

        combinedTotal += total;
        sales.push({ id: saleId, invoice_number: invNo, company_code: co.rows[0].code, total_amount: total, amount_paid: amountPaid });
      }

      return { warehouse_ref: ref, sales, combined_total: combinedTotal };
    });

    await logAction({ userId: req.user.id, action: 'warehouse_sale', entity: 'sale', entityId: null, details: { ref: result.warehouse_ref, total: result.combined_total }, ip: req.ip });
    const payload = { message: 'Warehouse sale recorded.', ...result };
    await idempotency.finish(idemKey, payload);
    res.status(201).json(payload);
  } catch (err) {
    await idempotency.fail(idemKey);
    next(err);
  }
}

// GET /api/warehouse-sale/:ref  — combined data for the Nature's Breeze invoice.
async function getWarehouseSale(req, res, next) {
  try {
    const head = await query(
      `SELECT s.warehouse_ref, s.sale_type, s.payment_method, s.created_at,
              cu.name AS customer_name, cu.phone AS customer_phone, u.full_name AS sold_by
       FROM sales s
       LEFT JOIN customers cu ON cu.id = s.customer_id
       LEFT JOIN users u ON u.id = s.user_id
       WHERE s.warehouse_ref = $1
       ORDER BY s.id LIMIT 1`,
      [req.params.ref]
    );
    if (!head.rows.length) return res.status(404).json({ error: 'Warehouse sale not found.' });

    const items = await query(
      `SELECT si.quantity, si.unit_price, si.subtotal, si.sold_as, si.pack_size,
              p.name, p.product_code, co.code AS company_code
       FROM sales s
       JOIN sale_items si ON si.sale_id = s.id
       JOIN products p ON p.id = si.product_id
       JOIN companies co ON co.id = s.company_id
       WHERE s.warehouse_ref = $1
       ORDER BY co.code, p.name`,
      [req.params.ref]
    );
    const total = items.rows.reduce((s, r) => s + Number(r.subtotal), 0);
    res.json({ ...head.rows[0], items: items.rows, total });
  } catch (err) { next(err); }
}

module.exports = { inventory, createWarehouseSale, getWarehouseSale };
