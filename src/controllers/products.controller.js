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
              p.cost_price, p.recommended_price, p.is_active, p.reorder_level,
              p.category_id, c.name AS category_name,
              COALESCE(SUM(sl.quantity), 0)::int AS total_stock
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN stock_levels sl ON sl.product_id = p.id
       ${where}
       GROUP BY p.id, c.name
       ORDER BY c.name NULLS LAST, p.name`,
      params
    );
    res.json(rows);
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

    res.json({ ...prod.rows[0], stock_by_branch: breakdown.rows });
  } catch (err) {
    next(err);
  }
}

// POST /api/products
// { product_code, name, category_id, unit, cost_price, recommended_price,
//   description, initial_branch_id, initial_quantity }
// Optionally drops some starting stock at a branch in the same step.
async function createProduct(req, res, next) {
  const {
    product_code, name, category_id, unit, cost_price, recommended_price,
    description, initial_branch_id, initial_quantity, reorder_level,
  } = req.body;

  if (!product_code || !product_code.trim())
    return res.status(400).json({ error: 'Enter a product code.' });
  if (!name || !name.trim())
    return res.status(400).json({ error: 'Enter a product name.' });

  try {
    const product = await withTransaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO products
           (company_id, category_id, product_code, name, description, unit, cost_price, recommended_price, reorder_level)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [
          req.company.id, category_id || null, product_code.trim(), name.trim(),
          description || null, unit || 'pcs', cost_price || 0, recommended_price || 0,
          (reorder_level === undefined || reorder_level === null || reorder_level === '')
            ? 5 : parseInt(reorder_level, 10) || 0,
        ]
      );
      const p = inserted.rows[0];

      const qty = parseInt(initial_quantity, 10) || 0;
      if (qty > 0 && initial_branch_id) {
        await client.query(
          `INSERT INTO stock_levels (product_id, branch_id, quantity) VALUES ($1, $2, $3)`,
          [p.id, initial_branch_id, qty]
        );
        await client.query(
          `INSERT INTO stock_movements
             (company_id, product_id, to_branch_id, quantity, movement_type, note, user_id)
           VALUES ($1, $2, $3, $4, 'restock', 'Initial stock on product creation', $5)`,
          [req.company.id, p.id, initial_branch_id, qty, req.user.id]
        );
      }
      return p;
    });

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

// PUT /api/products/:id
// Edits name, category, unit, cost price, description.
// NOTE: it deliberately does NOT change recommended_price (admin-only, separate route).
async function updateProduct(req, res, next) {
  try {
    const { name, category_id, unit, cost_price, description, reorder_level } = req.body;

    const { rows } = await query(
      `UPDATE products
         SET name          = COALESCE($1, name),
             category_id   = $2,
             unit          = COALESCE($3, unit),
             cost_price    = COALESCE($4, cost_price),
             description   = $5,
             reorder_level = COALESCE($6, reorder_level),
             updated_at    = now()
       WHERE id = $7 AND company_id = $8
       RETURNING *`,
      [
        name ? name.trim() : null,
        category_id || null,
        unit || null,
        cost_price !== undefined && cost_price !== null ? cost_price : null,
        description || null,
        (reorder_level === undefined || reorder_level === null || reorder_level === '')
          ? null : parseInt(reorder_level, 10),
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

module.exports = { listProducts, getProduct, createProduct, updateProduct, updatePrice, setProductActive };
