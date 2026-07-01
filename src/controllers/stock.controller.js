// ============================================================
//  Stock operations: restock, transfer, view per branch, history.
//  Restock and transfer always run inside a transaction and always
//  write a row to stock_movements, so there's a full paper trail.
// ============================================================
const { query, withTransaction } = require('../config/db');

// GET /api/stock?branch_id=...
// Every product with how many sit at this one branch/warehouse.
async function branchStock(req, res, next) {
  try {
    const branchId = req.query.branch_id;
    if (!branchId) return res.status(400).json({ error: 'Choose a branch.' });

    const { rows } = await query(
      `SELECT p.id AS product_id, p.product_code, p.name, p.unit,
              c.name AS category_name,
              COALESCE(sl.quantity, 0)::int AS quantity
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN stock_levels sl ON sl.product_id = p.id AND sl.branch_id = $1
       WHERE p.company_id = $2
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

  if (!branch_id) return res.status(400).json({ error: 'Choose a branch or warehouse.' });
  if (!qty || qty <= 0) return res.status(400).json({ error: 'Enter a quantity greater than 0.' });
  if (!product_id && !product_code)
    return res.status(400).json({ error: 'Enter a product code.' });

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

      await client.query(
        `INSERT INTO stock_movements
           (company_id, product_id, to_branch_id, quantity, movement_type, user_id)
         VALUES ($1, $2, $3, $4, 'restock', $5)`,
        [req.company.id, pid, branch_id, qty, req.user.id]
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
      // Both branches must belong to this company.
      const branches = await client.query(
        'SELECT id FROM branches WHERE id = ANY($1) AND company_id = $2',
        [[from_branch_id, to_branch_id], req.company.id]
      );
      if (branches.rows.length !== 2) {
        const e = new Error('Branch not found.');
        e.status = 404; throw e;
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
        [req.company.id, product_id, from_branch_id, to_branch_id, qty, req.user.id]
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

    const { rows } = await query(
      `SELECT m.id, m.movement_type, m.quantity, m.created_at,
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
       LIMIT 200`,
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
        'SELECT id FROM branches WHERE id = ANY($1) AND company_id = $2',
        [[from_branch_id, to_branch_id], req.company.id]
      );
      if (branches.rows.length !== 2) { const e = new Error('Branch not found.'); e.status = 404; throw e; }

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

module.exports = { branchStock, restock, transfer, transferBatch, movements };
