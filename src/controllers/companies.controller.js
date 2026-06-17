// ============================================================
//  Companies: used by the frontend's company switcher.
//  Only needs a logged-in user (NOT a selected company), because
//  this is how the app discovers which companies exist.
// ============================================================
const { query } = require('../config/db');

async function listCompanies(req, res, next) {
  try {
    const { rows } = await query('SELECT id, code, name FROM companies ORDER BY id');
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

module.exports = { listCompanies };
