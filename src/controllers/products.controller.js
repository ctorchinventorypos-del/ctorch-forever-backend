// ============================================================
//  Products: the items you sell. Each product has a product_code
//  (used during restock so quantities ADD UP instead of duplicating),
//  a cost price, and a recommended (selling) price.
//
//  Pricing rule: ONLY admins can edit the recommended price.
//  That happens through PATCH /:id/price (guarded by requireAdmin in the
//  routes file). The general update below cannot touch recommended_price.
// ============================================================
const { query, withTransaction } = require('../config/db');
const { logAction } = require('../utils/audit');

// GET /api/products?category_id=&search=
// Returns each product with its category name and TOTAL stock across all branches.
async function listProducts(req, res, next) {
  try {
    const params = [req.company.id];
    let where = 'WHERE p.company_id = $1';

    // By default only show active products; pass ?include_inactive=1 to see all.
    if (req.query.include_inactive !== '1' && req.query.include_inactive !== 'true') {
      where += ' AND p.is_active = TRUE';
    }
    if (req.query.category_id) {
      params.push(req.query.category_id);
      where += ` AND p.category_id = $${params.length}`;
    }
    if (req.query.search) {
      params.push('%' + req.query.search + '%');
      where += ` AND (p.name ILIKE $${params.length} OR p.product_code ILIKE $${params.length})`;
    }

    const { rows } = await query(
      `SELECT p.id, p.product_code, p.name, p.description, p.unit,
              p.cost_price, p.recommended_price, p.is_active, p.reorder_level, p.qty_per_carton,
              p.category_id, c.name AS category_name,
              p.created_at, u.full_name AS created_by_name,
              COALESCE(SUM(sl.quantity), 0)::int AS total_stock
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN users u ON u.id = p.created_by
       LEFT JOIN stock_levels sl ON sl.product_id = p.id
       ${where}
       GROUP BY p.id, c.name, u.full_name
       ORDER BY c.name NULLS LAST, p.name`,
      params
    );
    // Cost price is admin-only: strip it for everyone else.
    const isAdmin = req.user && req.user.role === 'admin';
    res.json(isAdmin ? rows : rows.map((r) => ({ ...r, cost_price: null })));
  } catch (err) {
    next(err);
  }
}

// GET /api/products/:id
// Returns the product PLUS its stock at every branch/warehouse (zeros included),
// so the UI can show warehouse stock separately from store stock.
async function getProduct(req, res, next) {
  try {
    const prod = await query(
      `SELECT p.*, c.name AS category_name
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       WHERE p.id = $1 AND p.company_id = $2`,
      [req.params.id, req.company.id]
    );
    if (!prod.rows.length) return res.status(404).json({ error: 'Product not found.' });

    const breakdown = await query(
      `SELECT b.id AS branch_id, b.name AS branch_name, b.is_warehouse,
              COALESCE(sl.quantity, 0)::int AS quantity
       FROM branches b
       LEFT JOIN stock_levels sl ON sl.branch_id = b.id AND sl.product_id = $1
       WHERE b.company_id = $2
       ORDER BY b.is_warehouse DESC, b.name`,
      [req.params.id, req.company.id]
    );

    const isAdmin = req.user && req.user.role === 'admin';
    const prodOut = isAdmin ? prod.rows[0] : { ...prod.rows[0], cost_price: null };
    res.json({ ...prodOut, stock_by_branch: breakdown.rows });
  } catch (err) {
    next(err);
  }
}

// POST /api/products
// { product_code, name, category_id, unit, cost_price, recommended_price,
//   description, initial_branch_id, initial_quantity }
// Optionally drops some starting stock at a branch in the same step.
// Insert ONE product (+ its starting stock) using an existing transaction
// client. The starting location is required. Returns the created product row.
async function insertOneProduct(client, companyId, userId, d) {
  const inserted = await client.query(
    `INSERT INTO products
       (company_id, category_id, product_code, name, description, unit, cost_price, recommended_price, reorder_level, qty_per_carton, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [
      companyId, d.category_id || null, d.product_code.trim(), d.name.trim(),
      d.description || null, d.unit || 'pcs', d.cost_price || 0, d.recommended_price || 0,
      (d.reorder_level === undefined || d.reorder_level === null || d.reorder_level === '')
        ? 5 : parseInt(d.reorder_level, 10) || 0,
      (d.qty_per_carton === undefined || d.qty_per_carton === null || d.qty_per_carton === '')
        ? null : parseInt(d.qty_per_carton, 10) || null,
      userId,
    ]
  );
  const p = inserted.rows[0];

  // Starting stock. The primary location (initial_branch_id) is always created
  // (at 0 if no quantity given). Optionally, initial_stock can seed several
  // branches at once: [{ branch_id, quantity }, ...].
  const stockByBranch = new Map();
  // primary location first (may be 0)
  stockByBranch.set(String(d.initial_branch_id), parseInt(d.initial_quantity, 10) || 0);
  if (Array.isArray(d.initial_stock)) {
    for (const s of d.initial_stock) {
      if (!s || !s.branch_id) continue;
      const q = parseInt(s.quantity, 10) || 0;
      // if a branch appears twice, the later (explicit) entry wins
      stockByBranch.set(String(s.branch_id), q);
    }
  }

  for (const [branchId, qty] of stockByBranch.entries()) {
    // Confirm the branch belongs to this company before seeding stock.
    const br = await client.query('SELECT id FROM branches WHERE id = $1 AND company_id = $2', [branchId, companyId]);
    if (!br.rows.length) { const e = new Error('One of the chosen locations was not found.'); e.status = 404; throw e; }

    await client.query(
      `INSERT INTO stock_levels (product_id, branch_id, quantity) VALUES ($1, $2, $3)
       ON CONFLICT (product_id, branch_id) DO UPDATE SET quantity = EXCLUDED.quantity, updated_at = now()`,
      [p.id, branchId, qty]
    );
    if (qty > 0) {
      await client.query(
        `INSERT INTO stock_movements
           (company_id, product_id, to_branch_id, quantity, movement_type, note, user_id)
         VALUES ($1, $2, $3, $4, 'restock', 'Initial stock on product creation', $5)`,
        [companyId, p.id, branchId, qty, userId]
      );
    }
  }
  return p;
}

// Basic per-product field checks shared by single + batch create.
function checkProductInput(d) {
  if (!d || !d.product_code || !String(d.product_code).trim()) return 'Enter a product code.';
  if (!d.name || !String(d.name).trim()) return 'Enter a product name.';
  if (!d.initial_branch_id) return 'Choose the starting stock location.';
  return null;
}

// POST /api/products   (single product)
async function createProduct(req, res, next) {
  const problem = checkProductInput(req.body);
  if (problem) return res.status(400).json({ error: problem });

  try {
    const product = await withTransaction((client) =>
      insertOneProduct(client, req.company.id, req.user.id, req.body)
    );
    await logAction({
      userId: req.user.id, action: 'create_product',
      entity: 'product', entityId: product.id, ip: req.ip,
    });
    res.status(201).json(product);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({
        error: 'A product with that code already exists. Use Restock to add to it instead.',
      });
    }
    next(err);
  }
}

// POST /api/products/batch   { products: [ {...}, {...} ] }
// Create several products at once — used for variations of one item, where
// each variation has its OWN product code. All-or-nothing: if any line is
// invalid or its code already exists, nothing is created.
async function createProductsBatch(req, res, next) {
  const list = Array.isArray(req.body.products) ? req.body.products : [];
  if (list.length === 0) return res.status(400).json({ error: 'Add at least one variation.' });
  if (list.length > 100) return res.status(400).json({ error: 'Too many variations at once (max 100).' });

  for (const d of list) {
    const problem = checkProductInput(d);
    if (problem) return res.status(400).json({ error: problem });
  }
  // Guard against duplicate codes within the same submission.
  const codes = list.map((d) => String(d.product_code).trim().toLowerCase());
  if (new Set(codes).size !== codes.length) {
    return res.status(400).json({ error: 'Two variations have the same product code.' });
  }

  try {
    const created = await withTransaction(async (client) => {
      const out = [];
      for (const d of list) out.push(await insertOneProduct(client, req.company.id, req.user.id, d));
      return out;
    });
    await logAction({
      userId: req.user.id, action: 'create_products_batch',
      entity: 'product', entityId: created[0].id,
      details: { count: created.length }, ip: req.ip,
    });
    res.status(201).json({ message: `${created.length} product${created.length === 1 ? '' : 's'} created.`, products: created });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'One of the product codes already exists. Nothing was created.' });
    }
    next(err);
  }
}

// PUT /api/products/:id
// Edits name, category, unit, cost price, description.
// NOTE: it deliberately does NOT change recommended_price (admin-only, separate route).
async function updateProduct(req, res, next) {
  try {
    const { name, category_id, unit, cost_price, description, reorder_level } = req.body;

    // Only admins may change the cost price and carton size. For non-admins ignored.
    const isAdmin = req.user && req.user.role === 'admin';
    const effectiveCost = (isAdmin && cost_price !== undefined && cost_price !== null && cost_price !== '')
      ? cost_price : null;
    const qpc = req.body.qty_per_carton;
    const effectiveCarton = (isAdmin && qpc !== undefined)
      ? (qpc === null || qpc === '' ? null : parseInt(qpc, 10) || null) : undefined;

    const { rows } = await query(
      `UPDATE products
         SET name          = COALESCE($1, name),
             category_id   = $2,
             unit          = COALESCE($3, unit),
             cost_price    = COALESCE($4, cost_price),
             description   = $5,
             reorder_level = COALESCE($6, reorder_level),
             qty_per_carton = CASE WHEN $7::int IS NOT NULL OR $8::boolean THEN $9 ELSE qty_per_carton END,
             updated_at    = now()
       WHERE id = $10 AND company_id = $11
       RETURNING *`,
      [
        name ? name.trim() : null,
        category_id || null,
        unit || null,
        effectiveCost,
        description || null,
        (reorder_level === undefined || reorder_level === null || reorder_level === '')
          ? null : parseInt(reorder_level, 10),
        effectiveCarton === undefined ? null : effectiveCarton,
        effectiveCarton === undefined ? false : true,
        effectiveCarton === undefined ? null : effectiveCarton,
        req.params.id,
        req.company.id,
      ]
    );
    if (!rows.length) return res.status(404).json({ error: 'Product not found.' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
}

// PATCH /api/products/:id/price   { recommended_price }   (ADMIN ONLY)
async function updatePrice(req, res, next) {
  try {
    const price = req.body.recommended_price;
    if (price === undefined || price === null || isNaN(price) || Number(price) < 0) {
      return res.status(400).json({ error: 'Enter a valid price.' });
    }

    const { rows } = await query(
      `UPDATE products SET recommended_price = $1, updated_at = now()
       WHERE id = $2 AND company_id = $3
       RETURNING id, name, recommended_price`,
      [price, req.params.id, req.company.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Product not found.' });

    await logAction({
      userId: req.user.id, action: 'edit_recommended_price',
      entity: 'product', entityId: rows[0].id,
      details: { recommended_price: price }, ip: req.ip,
    });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
}

// PATCH /api/products/:id/active   { is_active }   (ADMIN ONLY)
// Safe "remove": deactivating hides a product from sales and lists but keeps
// all its past sales/returns history intact. Reactivate any time.
async function setProductActive(req, res, next) {
  try {
    const active = req.body.is_active;
    if (typeof active !== 'boolean') {
      return res.status(400).json({ error: 'is_active must be true or false.' });
    }
    const { rows } = await query(
      `UPDATE products SET is_active = $1, updated_at = now()
       WHERE id = $2 AND company_id = $3
       RETURNING id, name, is_active`,
      [active, req.params.id, req.company.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Product not found.' });

    await logAction({
      userId: req.user.id, action: active ? 'reactivate_product' : 'deactivate_product',
      entity: 'product', entityId: rows[0].id, ip: req.ip,
    });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
}


// GET /api/products/next-code
// Suggests the next product code by sensing the last one created and
// incrementing its numeric tail (keeping the prefix and zero-padding).
// The person can still type a different code when adding a product.
async function nextCode(req, res, next) {
  try {
    const { rows } = await query(
      'SELECT product_code FROM products WHERE company_id = $1 ORDER BY id DESC LIMIT 1',
      [req.company.id]
    );
    let next = null;
    if (rows.length) {
      const m = String(rows[0].product_code).match(/^(.*?)(\d+)\s*$/);
      if (m) {
        const width = m[2].length;
        next = m[1] + String(parseInt(m[2], 10) + 1).padStart(width, '0');
      }
    }
    if (!next) next = (req.company.code || 'P') + '000001';
    // Make sure it isn't already taken; step forward until free.
    for (let i = 0; i < 200; i++) {
      const exists = await query('SELECT 1 FROM products WHERE company_id = $1 AND product_code = $2', [req.company.id, next]);
      if (!exists.rows.length) break;
      const m = next.match(/^(.*?)(\d+)\s*$/);
      if (!m) break;
      next = m[1] + String(parseInt(m[2], 10) + 1).padStart(m[2].length, '0');
    }
    res.json({ next_code: next });
  } catch (err) { next(err); }
}

module.exports = { listProducts, getProduct, createProduct, createProductsBatch, updateProduct, updatePrice, setProductActive, nextCode };
