// ============================================================
//  resolveCompany: handles "switching between the two companies".
//  The frontend sends the chosen company id in the X-Company-Id header.
//  We confirm it's a real company, then attach it to req.company so every
//  feature route can filter its data by that company.
//  Use AFTER authenticate on any route that touches company data.
// ============================================================
const { query } = require('../config/db');

async function resolveCompany(req, res, next) {
  const companyId = req.headers['x-company-id'];

  if (!companyId) {
    return res.status(400).json({ error: 'No company selected.' });
  }

  try {
    const { rows } = await query(
      'SELECT id, code, name FROM companies WHERE id = $1',
      [companyId]
    );
    if (rows.length === 0) {
      return res.status(400).json({ error: 'Unknown company.' });
    }
    req.company = rows[0]; // { id, code, name }
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { resolveCompany };
