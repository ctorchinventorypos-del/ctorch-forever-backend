// ============================================================
//  Branches: stores and warehouses. A warehouse is just a branch
//  with is_warehouse = true. Stock lives at branches.
//  Listing is open to all; creating/editing is admin-only.
// ============================================================
const { query } = require('../config/db');
const { logAction } = require('../utils/audit');

// GET /api/branches -> all branches/warehouses for the active company
// Warehouses are listed first so the UI can show them in their own section.
async function listBranches(req, res, next) {
  try {
    const { rows } = await query(
      `SELECT id, name, is_warehouse, address, phone, created_at
       FROM branches
       WHERE company_id = $1
       ORDER BY is_warehouse DESC, name`,
      [req.company.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

// POST /api/branches  { name, is_warehouse, address, phone }  (admin only)
async function createBranch(req, res, next) {
  try {
    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Enter a branch name.' });

    const { rows } = await query(
      `INSERT INTO branches (company_id, name, is_warehouse, address, phone)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, is_warehouse, address, phone`,
      [
        req.company.id,
        name,
        req.body.is_warehouse === true,
        req.body.address || null,
        req.body.phone || null,
      ]
    );
    await logAction({
      userId: req.user.id, action: 'create_branch',
      entity: 'branch', entityId: rows[0].id, ip: req.ip,
    });
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A branch with that name already exists.' });
    }
    next(err);
  }
}

// PUT /api/branches/:id  (admin only)  — edits name/address/phone
async function updateBranch(req, res, next) {
  try {
    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Enter a branch name.' });

    const { rows } = await query(
      `UPDATE branches
         SET name = $1, address = $2, phone = $3
       WHERE id = $4 AND company_id = $5
       RETURNING id, name, is_warehouse, address, phone`,
      [name, req.body.address || null, req.body.phone || null, req.params.id, req.company.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Branch not found.' });
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A branch with that name already exists.' });
    }
    next(err);
  }
}


// GET /api/branches/all — every branch across BOTH companies (for cross-company transfer).
async function listAllBranches(req, res, next) {
  try {
    const { rows } = await query(
      `SELECT b.id, b.name, b.is_warehouse, b.company_id, co.code AS company_code, co.name AS company_name
       FROM branches b JOIN companies co ON co.id = b.company_id
       ORDER BY co.code, b.is_warehouse DESC, b.name`, []
    );
    res.json(rows);
  } catch (err) { next(err); }
}

module.exports = { listBranches, createBranch, updateBranch, listAllBranches };
