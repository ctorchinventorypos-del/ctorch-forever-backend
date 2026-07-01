// ============================================================
//  Quotations / proforma invoices, with revision history.
//
//  A quote is a price offer for a list of items. It does NOT touch stock or
//  customer balances. When a customer changes their order, an admin "revises"
//  it: a NEW version is saved under the same root quote (revision 2, 3, …),
//  the previous version is marked 'superseded', and only the LATEST open
//  version can be printed-as-current or converted to a sale.
//
//  Once a version is 'converted' it is locked — it can't be revised, because
//  it is now the record of what was actually sold.
// ============================================================
const { query, withTransaction } = require('../config/db');
const { logAction } = require('../utils/audit');
const { str, capArray } = require('../utils/validate');

// Validate + normalise the item list from a request body.
function prepareItems(rawItems) {
  const arr = capArray(rawItems, { field: 'items', max: 300 });
  if (!arr.ok) { const e = new Error(arr.error); e.status = 400; throw e; }
  if (arr.value.length === 0) { const e = new Error('Add at least one item.'); e.status = 400; throw e; }

  let total = 0;
  const prepared = [];
  for (const it of arr.value) {
    const qty = parseInt(it.quantity, 10);
    const price = Number(it.unit_price);
    const nm = (it.name || '').toString().trim().slice(0, 150);
    if (!nm || !qty || qty <= 0 || isNaN(price) || price < 0) {
      const e = new Error('Each item needs a name, quantity, and price.');
      e.status = 400; throw e;
    }
    const subtotal = qty * price;
    total += subtotal;
    prepared.push({ product_id: it.product_id || null, name: nm, qty, price, subtotal });
  }
  return { prepared, total };
}

async function insertItems(client, quotationId, prepared) {
  for (const p of prepared) {
    await client.query(
      `INSERT INTO quotation_items (quotation_id, product_id, name_snapshot, quantity, unit_price, subtotal)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [quotationId, p.product_id, p.name, p.qty, p.price, p.subtotal]
    );
  }
}

// POST /api/quotations   { customer_id?, customer_name?, note?, items:[...] }
async function createQuotation(req, res, next) {
  try {
    const nameField = str(req.body.customer_name, { field: 'Customer name', max: 150 });
    if (!nameField.ok) return res.status(400).json({ error: nameField.error });
    const note = str(req.body.note, { field: 'Note', max: 1000 });
    if (!note.ok) return res.status(400).json({ error: note.error });
    const { prepared, total } = prepareItems(req.body.items);

    const quote = await withTransaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO quotations
           (company_id, user_id, customer_id, customer_name, quote_number, total_amount, note, revision)
         VALUES ($1,$2,$3,$4, md5(random()::text || clock_timestamp()::text), $5, $6, 1)
         RETURNING id`,
        [req.company.id, req.user.id, req.body.customer_id || null, nameField.value, total, note.value]
      );
      const qId = inserted.rows[0].id;
      const qNo = `QUO-${String(qId).padStart(6, '0')}`;
      // A brand-new quote is its own root (revision 1).
      await client.query('UPDATE quotations SET quote_number = $1, root_id = $2 WHERE id = $2', [qNo, qId]);
      await insertItems(client, qId, prepared);
      return { id: qId, quote_number: qNo, total_amount: total };
    });

    await logAction({ userId: req.user.id, action: 'create_quotation', entity: 'quotation', entityId: quote.id, ip: req.ip });
    res.status(201).json({ message: 'Quotation saved.', ...quote });
  } catch (err) { next(err); }
}

// POST /api/quotations/:id/revise   (ADMIN)  { customer_id?, customer_name?, note?, items:[...] }
// Creates a new revision under the same root and supersedes the current one.
async function reviseQuotation(req, res, next) {
  try {
    const nameField = str(req.body.customer_name, { field: 'Customer name', max: 150 });
    if (!nameField.ok) return res.status(400).json({ error: nameField.error });
    const note = str(req.body.note, { field: 'Note', max: 1000 });
    if (!note.ok) return res.status(400).json({ error: note.error });
    const { prepared, total } = prepareItems(req.body.items);

    const result = await withTransaction(async (client) => {
      // Lock the quote being revised.
      const cur = await client.query(
        `SELECT id, root_id, status, quote_number FROM quotations
         WHERE id = $1 AND company_id = $2 FOR UPDATE`,
        [req.params.id, req.company.id]
      );
      if (!cur.rows.length) { const e = new Error('Quotation not found.'); e.status = 404; throw e; }
      const q = cur.rows[0];
      if (q.status === 'converted') {
        const e = new Error('This quotation was already converted to a sale and cannot be edited.');
        e.status = 409; throw e;
      }
      const rootId = q.root_id || q.id;

      // The base number is revision 1's quote_number (no -R suffix).
      const rootRow = await client.query('SELECT quote_number FROM quotations WHERE id = $1', [rootId]);
      const base = (rootRow.rows[0] && rootRow.rows[0].quote_number) || `QUO-${String(rootId).padStart(6, '0')}`;

      // Next revision number for this root.
      const maxRev = await client.query('SELECT COALESCE(MAX(revision),1) AS m FROM quotations WHERE root_id = $1', [rootId]);
      const newRev = Number(maxRev.rows[0].m) + 1;

      // Any still-open versions of this root become superseded.
      await client.query(
        `UPDATE quotations SET status = 'superseded' WHERE root_id = $1 AND status = 'open'`,
        [rootId]
      );

      const inserted = await client.query(
        `INSERT INTO quotations
           (company_id, user_id, customer_id, customer_name, quote_number, total_amount, note, root_id, revision, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'open')
         RETURNING id`,
        [req.company.id, req.user.id, req.body.customer_id || null, nameField.value,
         `${base}-R${newRev}`, total, note.value, rootId, newRev]
      );
      const newId = inserted.rows[0].id;
      await insertItems(client, newId, prepared);
      return { id: newId, quote_number: `${base}-R${newRev}`, revision: newRev, total_amount: total };
    });

    await logAction({ userId: req.user.id, action: 'revise_quotation', entity: 'quotation', entityId: result.id, ip: req.ip });
    res.status(201).json({ message: `Revision ${result.revision} saved.`, ...result });
  } catch (err) { next(err); }
}

// GET /api/quotations?status=open|converted
// Shows only the CURRENT (latest revision) of each root quote.
async function listQuotations(req, res, next) {
  try {
    const params = [req.company.id];
    let statusFilter = '';
    if (req.query.status) {
      params.push(req.query.status);
      statusFilter = ` AND latest.status = $${params.length}`;
    }
    const { rows } = await query(
      `SELECT latest.id, latest.quote_number, latest.total_amount, latest.status,
              latest.revision, latest.root_id, latest.created_at,
              COALESCE(cu.name, latest.customer_name) AS customer_name,
              u.full_name AS created_by,
              (SELECT COUNT(*) FROM quotations r WHERE r.root_id = latest.root_id) AS revision_count
       FROM (
         SELECT DISTINCT ON (root_id) *
         FROM quotations
         WHERE company_id = $1
         ORDER BY root_id, revision DESC
       ) latest
       LEFT JOIN customers cu ON cu.id = latest.customer_id
       LEFT JOIN users u ON u.id = latest.user_id
       WHERE 1=1 ${statusFilter}
       ORDER BY latest.created_at DESC
       LIMIT 400`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
}

// GET /api/quotations/:id/history  -> every revision of this quote's root
async function getHistory(req, res, next) {
  try {
    const cur = await query(
      'SELECT root_id FROM quotations WHERE id = $1 AND company_id = $2',
      [req.params.id, req.company.id]
    );
    if (!cur.rows.length) return res.status(404).json({ error: 'Quotation not found.' });
    const rootId = cur.rows[0].root_id;

    const { rows } = await query(
      `SELECT q.id, q.quote_number, q.revision, q.status, q.total_amount, q.created_at,
              u.full_name AS created_by
       FROM quotations q
       LEFT JOIN users u ON u.id = q.user_id
       WHERE q.root_id = $1 AND q.company_id = $2
       ORDER BY q.revision ASC`,
      [rootId, req.company.id]
    );
    res.json(rows);
  } catch (err) { next(err); }
}

// GET /api/quotations/:id  -> full quote (one revision) + items
async function getQuotation(req, res, next) {
  try {
    const q = await query(
      `SELECT q.*, COALESCE(cu.name, q.customer_name) AS customer_name,
              cu.phone AS customer_phone, u.full_name AS created_by,
              co.code AS company_code, co.name AS company_name,
              co.address AS company_address, co.phone AS company_phone
       FROM quotations q
       LEFT JOIN customers cu ON cu.id = q.customer_id
       LEFT JOIN users u ON u.id = q.user_id
       JOIN companies co ON co.id = q.company_id
       WHERE q.id = $1 AND q.company_id = $2`,
      [req.params.id, req.company.id]
    );
    if (!q.rows.length) return res.status(404).json({ error: 'Quotation not found.' });

    const items = await query(
      `SELECT product_id, name_snapshot AS name, quantity, unit_price, subtotal
       FROM quotation_items WHERE quotation_id = $1 ORDER BY id`,
      [req.params.id]
    );
    res.json({ ...q.rows[0], items: items.rows });
  } catch (err) { next(err); }
}

// PATCH /api/quotations/:id/status   { status }   (e.g. mark 'converted')
async function setStatus(req, res, next) {
  try {
    const status = req.body.status;
    if (!['open', 'converted', 'superseded'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status.' });
    }
    const { rows } = await query(
      `UPDATE quotations SET status = $1 WHERE id = $2 AND company_id = $3 RETURNING id, status`,
      [status, req.params.id, req.company.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Quotation not found.' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

// DELETE /api/quotations/:id  -> removes the whole quote (all its revisions)
async function deleteQuotation(req, res, next) {
  try {
    const cur = await query(
      'SELECT root_id FROM quotations WHERE id = $1 AND company_id = $2',
      [req.params.id, req.company.id]
    );
    if (!cur.rows.length) return res.status(404).json({ error: 'Quotation not found.' });
    await query('DELETE FROM quotations WHERE root_id = $1 AND company_id = $2', [cur.rows[0].root_id, req.company.id]);
    res.json({ message: 'Quotation deleted.' });
  } catch (err) { next(err); }
}

module.exports = {
  createQuotation, reviseQuotation, listQuotations, getHistory,
  getQuotation, setStatus, deleteQuotation,
};
