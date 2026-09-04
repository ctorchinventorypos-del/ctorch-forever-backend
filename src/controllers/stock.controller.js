// ============================================================
//  Stock operations: restock, transfer, view per branch, history.
//  Restock and transfer always run inside a transaction and always
//  write a row to stock_movements, so there's a full paper trail.
// ============================================================
const { query, withTransaction } = require('../config/db');
const { can } = require('../utils/permissions');
const { logAction } = require('../utils/audit');

// GET /api/stock?branch_id=...
// Every product with how many sit at this one branch/warehouse.
async function branchStock(req, res, next) {
  try {
    const branchId = req.query.branch_id;
    if (!branchId) return res.status(400).json({ error: 'Choose a branch.' });

    // Show the company's own products PLUS any product from the other company
    // that has been transferred here (has stock at this branch) — so it can be
    // sold from here and counts under whoever sells it.
    const { rows } = await query(
      `SELECT p.id AS product_id, p.product_code, p.name, p.unit, p.company_id,
              co.code AS owner_code,
              c.name AS category_name,
              COALESCE(sl.quantity, 0)::int AS quantity
       FROM products p
       JOIN companies co ON co.id = p.company_id
       LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN stock_levels sl ON sl.product_id = p.id AND sl.branch_id = $1
       WHERE p.is_active = TRUE
         AND (p.company_id = $2 OR COALESCE(sl.quantity, 0) > 0)
       ORDER BY c.name NULLS LAST, p.name`,
      [branchId, req.company.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

// POST /api/stock/restock
// { product_code (or product_id), branch_id, quantity }
// Adds to the existing stock at that branch. Because product_code is unique
// per company, restocking the same code always ADDS UP — never duplicates.
async function restock(req, res, next) {
  const { product_code, product_id, branch_id, quantity } = req.body;
  const qty = parseInt(quantity, 10);
  // Optional new cost price for this batch (only applied for admins).
  const isAdmin = req.user && req.user.role === 'admin';
  const newCost = (req.body.cost_price !== undefined && req.body.cost_price !== null && req.body.cost_price !== '')
    ? Number(req.body.cost_price) : null;

  if (!branch_id) return res.status(400).json({ error: 'Choose a branch or warehouse.' });
  if (!qty || qty <= 0) return res.status(400).json({ error: 'Enter a quantity greater than 0.' });
  if (!product_id && !product_code)
    return res.status(400).json({ error: 'Enter a product code.' });
  if (newCost !== null && (isNaN(newCost) || newCost < 0))
    return res.status(400).json({ error: 'Enter a valid cost price.' });

  try {
    const result = await withTransaction(async (client) => {
      // Find the product within THIS company.
      const prod = product_id
        ? await client.query('SELECT id FROM products WHERE id = $1 AND company_id = $2', [product_id, req.company.id])
        : await client.query('SELECT id FROM products WHERE product_code = $1 AND company_id = $2', [product_code, req.company.id]);

      if (!prod.rows.length) {
        const e = new Error('No product found for that code.');
        e.status = 404; throw e;
      }
      const pid = prod.rows[0].id;

      // Confirm the branch belongs to this company.
      const br = await client.query('SELECT id FROM branches WHERE id = $1 AND company_id = $2', [branch_id, req.company.id]);
      if (!br.rows.length) {
        const e = new Error('Branch not found.');
        e.status = 404; throw e;
      }

      // Add to existing quantity, or create the row if it's the first time.
      const upserted = await client.query(
        `INSERT INTO stock_levels (product_id, branch_id, quantity)
         VALUES ($1, $2, $3)
         ON CONFLICT (product_id, branch_id)
         DO UPDATE SET quantity = stock_levels.quantity + EXCLUDED.quantity, updated_at = now()
         RETURNING quantity`,
        [pid, branch_id, qty]
      );

      // If an admin supplied a new cost price for this batch, update it.
      let costNote = '';
      if (newCost !== null && isAdmin) {
        await client.query('UPDATE products SET cost_price = $1, updated_at = now() WHERE id = $2', [newCost, pid]);
        costNote = ` at cost ${newCost}`;
      }
      // Admins may also set/update the carton size here.
      const qpc = req.body.qty_per_carton;
      if (isAdmin && qpc !== undefined && qpc !== null && qpc !== '') {
        await client.query('UPDATE products SET qty_per_carton = $1, updated_at = now() WHERE id = $2', [parseInt(qpc, 10) || null, pid]);
      }

      await client.query(
        `INSERT INTO stock_movements
           (company_id, product_id, to_branch_id, quantity, movement_type, note, user_id)
         VALUES ($1, $2, $3, $4, 'restock', $5, $6)`,
        [req.company.id, pid, branch_id, qty, ('Restocked' + costNote), req.user.id]
      );

      return { product_id: pid, branch_id, new_quantity: upserted.rows[0].quantity };
    });

    res.json({ message: 'Stock added.', ...result });
  } catch (err) {
    next(err);
  }
}

// POST /api/stock/transfer
// { product_id, from_branch_id, to_branch_id, quantity }
// Moves stock between any two branches (warehouse -> store, or store -> store).
// Fully atomic: if the source lacks enough stock, nothing changes.
async function transfer(req, res, next) {
  const { product_id, from_branch_id, to_branch_id, quantity } = req.body;
  const qty = parseInt(quantity, 10);

  if (!product_id || !from_branch_id || !to_branch_id)
    return res.status(400).json({ error: 'Choose a product, a source and a destination.' });
  if (String(from_branch_id) === String(to_branch_id))
    return res.status(400).json({ error: 'Source and destination must be different.' });
  if (!qty || qty <= 0)
    return res.status(400).json({ error: 'Enter a quantity greater than 0.' });

  try {
    const result = await withTransaction(async (client) => {
      // Both branches must exist (they may belong to different companies).
      const branches = await client.query(
        'SELECT id, company_id, is_warehouse FROM branches WHERE id = ANY($1)',
        [[from_branch_id, to_branch_id]]
      );
      if (branches.rows.length !== 2) {
        const e = new Error('Branch not found.');
        e.status = 404; throw e;
      }
      // Stock only flows FROM a warehouse (the central store) TO a branch.
      const srcBr = branches.rows.find((b) => String(b.id) === String(from_branch_id));
      if (!srcBr || !srcBr.is_warehouse) {
        const e = new Error('Transfers can only be made from a warehouse to a branch.'); e.status = 400; throw e;
      }
      // Which company owns the product being moved (for the movement log).
      const prod = await client.query('SELECT company_id FROM products WHERE id = $1', [product_id]);
      if (!prod.rows.length) { const e = new Error('Product not found.'); e.status = 404; throw e; }
      const productCompany = prod.rows[0].company_id;

      // Moving across companies needs the cross-company transfer permission.
      const fromCo = branches.rows.find((b) => String(b.id) === String(from_branch_id))?.company_id;
      const toCo = branches.rows.find((b) => String(b.id) === String(to_branch_id))?.company_id;
      const crosses = fromCo !== toCo || productCompany !== fromCo;
      if (crosses && !(await can(req.user, 'stock.transfer_crosscompany'))) {
        const e = new Error('You are not allowed to transfer stock across companies.'); e.status = 403; throw e;
      }

      // Lock the source row and check there's enough.
      const src = await client.query(
        'SELECT quantity FROM stock_levels WHERE product_id = $1 AND branch_id = $2 FOR UPDATE',
        [product_id, from_branch_id]
      );
      const have = src.rows.length ? src.rows[0].quantity : 0;
      if (have < qty) {
        const e = new Error(`Not enough stock to transfer. Available: ${have}.`);
        e.status = 400; throw e;
      }

      // Subtract from source, add to destination.
      await client.query(
        'UPDATE stock_levels SET quantity = quantity - $1, updated_at = now() WHERE product_id = $2 AND branch_id = $3',
        [qty, product_id, from_branch_id]
      );
      await client.query(
        `INSERT INTO stock_levels (product_id, branch_id, quantity)
         VALUES ($1, $2, $3)
         ON CONFLICT (product_id, branch_id)
         DO UPDATE SET quantity = stock_levels.quantity + EXCLUDED.quantity, updated_at = now()`,
        [product_id, to_branch_id, qty]
      );

      await client.query(
        `INSERT INTO stock_movements
           (company_id, product_id, from_branch_id, to_branch_id, quantity, movement_type, user_id)
         VALUES ($1, $2, $3, $4, $5, 'transfer', $6)`,
        [productCompany, product_id, from_branch_id, to_branch_id, qty, req.user.id]
      );

      return { transferred: qty };
    });

    res.json({ message: 'Stock transferred.', ...result });
  } catch (err) {
    next(err);
  }
}

// GET /api/stock/movements?product_id=...
// The history of stock changes (restocks, transfers, sales, returns).
async function movements(req, res, next) {
  try {
    const params = [req.company.id];
    let where = 'WHERE m.company_id = $1';
    if (req.query.product_id) {
      params.push(req.query.product_id);
      where += ` AND m.product_id = $${params.length}`;
    }
    if (req.query.type) {
      params.push(req.query.type);
      where += ` AND m.movement_type = $${params.length}`;
    }
    if (req.query.from) {
      params.push(req.query.from);
      where += ` AND m.created_at::date >= $${params.length}::date`;
    }
    if (req.query.to) {
      params.push(req.query.to);
      where += ` AND m.created_at::date <= $${params.length}::date`;
    }
    const limit = req.query.from || req.query.to ? 2000 : 200;

    const { rows } = await query(
      `SELECT m.id, m.movement_type, m.quantity, m.created_at, m.note,
              p.name AS product_name, p.product_code,
              fb.name AS from_branch, tb.name AS to_branch,
              u.full_name AS done_by
       FROM stock_movements m
       JOIN products p ON p.id = m.product_id
       LEFT JOIN branches fb ON fb.id = m.from_branch_id
       LEFT JOIN branches tb ON tb.id = m.to_branch_id
       LEFT JOIN users u ON u.id = m.user_id
       ${where}
       ORDER BY m.created_at DESC
       LIMIT ${limit}`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

// POST /api/stock/transfer-batch
// { from_branch_id, to_branch_id, items: [ { product_id, quantity } ] }
// Moves several products between two branches in ONE atomic transaction:
// if any single line lacks enough stock, the whole transfer is rolled back.
async function transferBatch(req, res, next) {
  const { from_branch_id, to_branch_id } = req.body;
  const items = Array.isArray(req.body.items) ? req.body.items : [];

  if (!from_branch_id || !to_branch_id)
    return res.status(400).json({ error: 'Choose a source and a destination.' });
  if (String(from_branch_id) === String(to_branch_id))
    return res.status(400).json({ error: 'Source and destination must be different.' });
  if (items.length === 0)
    return res.status(400).json({ error: 'Add at least one product to transfer.' });
  if (items.length > 300)
    return res.status(400).json({ error: 'Too many lines in one transfer (max 300).' });

  try {
    const result = await withTransaction(async (client) => {
      const branches = await client.query(
        'SELECT id, company_id, is_warehouse FROM branches WHERE id = ANY($1)',
        [[from_branch_id, to_branch_id]]
      );
      if (branches.rows.length !== 2) { const e = new Error('Branch not found.'); e.status = 404; throw e; }
      const srcB = branches.rows.find((b) => String(b.id) === String(from_branch_id));
      if (!srcB || !srcB.is_warehouse) { const e = new Error('Transfers can only be made from a warehouse to a branch.'); e.status = 400; throw e; }
      const fromCo = branches.rows.find((b) => String(b.id) === String(from_branch_id))?.company_id;
      const toCo = branches.rows.find((b) => String(b.id) === String(to_branch_id))?.company_id;
      if (fromCo !== toCo && !(await can(req.user, 'stock.transfer_crosscompany'))) {
        const e = new Error('You are not allowed to transfer stock across companies.'); e.status = 403; throw e;
      }

      let moved = 0;
      for (const it of items) {
        const pid = it.product_id;
        const qty = parseInt(it.quantity, 10);
        if (!pid || !qty || qty <= 0) { const e = new Error('Each line needs a product and a quantity.'); e.status = 400; throw e; }

        // Confirm product belongs to company (avoids moving another company's item).
        const prod = await client.query('SELECT name FROM products WHERE id = $1 AND company_id = $2', [pid, req.company.id]);
        if (!prod.rows.length) { const e = new Error('Product not found.'); e.status = 404; throw e; }

        const src = await client.query(
          'SELECT quantity FROM stock_levels WHERE product_id = $1 AND branch_id = $2 FOR UPDATE',
          [pid, from_branch_id]
        );
        const have = src.rows.length ? src.rows[0].quantity : 0;
        if (have < qty) {
          const e = new Error(`Not enough "${prod.rows[0].name}" to transfer. Available: ${have}.`);
          e.status = 400; throw e;
        }

        await client.query(
          'UPDATE stock_levels SET quantity = quantity - $1, updated_at = now() WHERE product_id = $2 AND branch_id = $3',
          [qty, pid, from_branch_id]
        );
        await client.query(
          `INSERT INTO stock_levels (product_id, branch_id, quantity)
           VALUES ($1, $2, $3)
           ON CONFLICT (product_id, branch_id)
           DO UPDATE SET quantity = stock_levels.quantity + EXCLUDED.quantity, updated_at = now()`,
          [pid, to_branch_id, qty]
        );
        await client.query(
          `INSERT INTO stock_movements
             (company_id, product_id, from_branch_id, to_branch_id, quantity, movement_type, user_id)
           VALUES ($1, $2, $3, $4, $5, 'transfer', $6)`,
          [req.company.id, pid, from_branch_id, to_branch_id, qty, req.user.id]
        );
        moved += 1;
      }
      return { lines: moved };
    });

    res.json({ message: `Transferred ${result.lines} product${result.lines === 1 ? '' : 's'}.`, ...result });
  } catch (err) {
    next(err);
  }
}

// POST /api/stock/adjust   (ADMIN ONLY)
// { product_id, branch_id, new_quantity, note? }
// Directly SET a product's stock at a branch to the correct number. Records
// the change (with who did it and the difference) as an 'adjustment' movement.
async function adjust(req, res, next) {
  const { product_id, branch_id, note } = req.body;
  const newQty = parseInt(req.body.new_quantity, 10);

  if (!product_id || !branch_id) return res.status(400).json({ error: 'Choose a product and a location.' });
  if (isNaN(newQty) || newQty < 0) return res.status(400).json({ error: 'Enter a valid quantity (0 or more).' });

  try {
    const result = await withTransaction(async (client) => {
      const prod = await client.query('SELECT name FROM products WHERE id = $1 AND company_id = $2', [product_id, req.company.id]);
      if (!prod.rows.length) { const e = new Error('Product not found.'); e.status = 404; throw e; }
      const br = await client.query('SELECT id FROM branches WHERE id = $1 AND company_id = $2', [branch_id, req.company.id]);
      if (!br.rows.length) { const e = new Error('Branch not found.'); e.status = 404; throw e; }

      const cur = await client.query(
        'SELECT quantity FROM stock_levels WHERE product_id = $1 AND branch_id = $2 FOR UPDATE',
        [product_id, branch_id]
      );
      const before = cur.rows.length ? cur.rows[0].quantity : 0;
      const delta = newQty - before;

      await client.query(
        `INSERT INTO stock_levels (product_id, branch_id, quantity)
         VALUES ($1, $2, $3)
         ON CONFLICT (product_id, branch_id)
         DO UPDATE SET quantity = EXCLUDED.quantity, updated_at = now()`,
        [product_id, branch_id, newQty]
      );
      // Record the change (delta may be positive or negative).
      await client.query(
        `INSERT INTO stock_movements
           (company_id, product_id, to_branch_id, quantity, movement_type, note, user_id)
         VALUES ($1, $2, $3, $4, 'adjustment', $5, $6)`,
        [req.company.id, product_id, branch_id, delta,
         (note ? note + ' — ' : '') + `set to ${newQty} (was ${before})`, req.user.id]
      );
      return { product: prod.rows[0].name, before, after: newQty };
    });

    await logAction({
      userId: req.user.id, action: 'adjust_stock',
      entity: 'product', entityId: product_id,
      details: result, ip: req.ip,
    });
    res.json({ message: `Stock updated: ${result.before} → ${result.after}.`, ...result });
  } catch (err) {
    next(err);
  }
}

// GET /api/stock/branch-movements?branch_id=&from=&to=
// Every product movement in/out of ONE location (any company's product),
// with direction relative to that branch. Printable per branch.
async function branchMovements(req, res, next) {
  try {
    const branchId = req.query.branch_id;
    if (!branchId) return res.status(400).json({ error: 'Choose a branch.' });
    const params = [branchId];
    let range = '';
    if (req.query.from) { params.push(req.query.from); range += ` AND m.created_at::date >= $${params.length}::date`; }
    if (req.query.to) { params.push(req.query.to); range += ` AND m.created_at::date <= $${params.length}::date`; }

    const { rows } = await query(
      `SELECT m.id, m.movement_type, m.quantity, m.created_at,
              p.name AS product_name, p.product_code, co.code AS product_company,
              fb.name AS from_branch, tb.name AS to_branch,
              CASE WHEN m.to_branch_id = $1 THEN 'in' ELSE 'out' END AS direction,
              u.full_name AS done_by
       FROM stock_movements m
       JOIN products p ON p.id = m.product_id
       JOIN companies co ON co.id = p.company_id
       LEFT JOIN branches fb ON fb.id = m.from_branch_id
       LEFT JOIN branches tb ON tb.id = m.to_branch_id
       LEFT JOIN users u ON u.id = m.user_id
       WHERE (m.from_branch_id = $1 OR m.to_branch_id = $1) ${range}
       ORDER BY m.created_at DESC
       LIMIT 3000`,
      params
    );
    const totalIn = rows.filter((r) => r.direction === 'in').reduce((s, r) => s + Number(r.quantity), 0);
    const totalOut = rows.filter((r) => r.direction === 'out').reduce((s, r) => s + Number(r.quantity), 0);
    res.json({ movements: rows, total_in: totalIn, total_out: totalOut });
  } catch (err) { next(err); }
}

module.exports = {
  branchMovements, branchStock, restock, transfer, transferBatch, adjust, movements };
