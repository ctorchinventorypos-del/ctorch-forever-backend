// ============================================================
//  Categories: users group products under categories.
//  All actions are scoped to the active company (req.company.id).
// ============================================================
const { query } = require('../config/db');
const { logAction } = require('../utils/audit');

// GET /api/categories  -> all categories for the active company
async function listCategories(req, res, next) {
  try {
    const { rows } = await query(
      'SELECT id, name, created_at FROM categories WHERE company_id = $1 ORDER BY name',
      [req.company.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

// POST /api/categories  { name }
async function createCategory(req, res, next) {
  try {
    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Enter a category name.' });

    const { rows } = await query(
      'INSERT INTO categories (company_id, name) VALUES ($1, $2) RETURNING id, name, created_at',
      [req.company.id, name]
    );
    await logAction({
      userId: req.user.id, action: 'create_category',
      entity: 'category', entityId: rows[0].id, ip: req.ip,
    });
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'That category already exists.' });
    }
    next(err);
  }
}

// PUT /api/categories/:id  { name }
async function updateCategory(req, res, next) {
  try {
    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Enter a category name.' });

    const { rows } = await query(
      'UPDATE categories SET name = $1 WHERE id = $2 AND company_id = $3 RETURNING id, name',
      [name, req.params.id, req.company.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Category not found.' });
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'That category already exists.' });
    }
    next(err);
  }
}

// DELETE /api/categories/:id
// Products in the category are NOT deleted; they just become uncategorised
// (the database sets their category_id to NULL automatically).
async function deleteCategory(req, res, next) {
  try {
    const { rowCount } = await query(
      'DELETE FROM categories WHERE id = $1 AND company_id = $2',
      [req.params.id, req.company.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Category not found.' });
    res.json({ message: 'Category deleted.' });
  } catch (err) {
    next(err);
  }
}

module.exports = { listCategories, createCategory, updateCategory, deleteCategory };
