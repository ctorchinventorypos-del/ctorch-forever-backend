// ============================================================
//  Quotations / proforma invoices.
//  A quote is a price offer for a list of items. It does NOT touch stock or
//  customer balances. When the customer agrees, the Sales screen loads the
//  quote's items so it can be completed as a real sale in one step.
// ============================================================
const { query, withTransaction } = require('../config/db');
const { logAction } = require('../utils/audit');
const { str, num, capArray } = require('../utils/validate');

// POST /api/quotations
// { customer_id?, customer_name?, note?, items: [ { product_id?, name, quantity, unit_price } ] }
async function createQuotation(req, res, next) {
  const arr = capArray(req.body.items, { field: 'items', max: 300 });
  if (!arr.ok) return res.status(400).json({ error: arr.error });
  if (arr.value.length === 0) return res.status(400).json({ error: 'Add at least one item.' });

  const nameField = str(req.body.customer_name, { field: 'Customer name', max: 150 });
  if (!nameField.ok) return res.status(400).json({ error: nameField.error });
  const note = str(req.body.note, { field: 'Note', max: 1000 });
  if (!note.ok) return res.status(400).json({ error: note.error });

  try {
    const quote = await withTransaction(async (client) => {
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

      const inserted = await client.query(
        `INSERT INTO quotations (company_id, user_id, customer_id, customer_name, quote_number, total_amount, note)
         VALUES ($1,$2,$3,$4, md5(random()::text || clock_timestamp()::text), $5, $6)
         RETURNING id`,
        [req.company.id, req.user.id, req.body.customer_id || null, nameField.value, total, note.value]
      );
      const qId = inserted.rows[0].id;
      const qNo = `QUO-${String(qId).padStart(6, '0')}`;
      await client.query('UPDATE quotations SET quote_number = $1 WHERE id = $2', [qNo, qId]);

      for (const p of prepared) {
        await client.query(
          `INSERT INTO quotation_items (quotation_id, product_id, name_snapshot, quantity, unit_price, subtotal)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [qId, p.product_id, p.name, p.qty, p.price, p.subtotal]
        );
      }
      return { id: qId, quote_number: qNo, total_amount: total };
    });

    await logAction({
      userId: req.user.id, action: 'create_quotation',
      entity: 'quotation', entityId: quote.id, ip: req.ip,
    });
    res.status(201).json({ message: 'Quotation saved.', ...quote });
  } catch (err) { next(err); }
}

// GET /api/quotations?status=open|converted
async function listQuotations(req, res, next) {
  try {
    const params = [req.company.id];
    let where = 'WHERE q.company_id = $1';
    if (req.query.status) {
      params.push(req.query.status);
      where += ` AND q.status = $${params.length}`;
    }
    const { rows } = await query(
      `SELECT q.id, q.quote_number, q.total_amount, q.status, q.created_at,
              COALESCE(cu.name, q.customer_name) AS customer_name,
              u.full_name AS created_by
       FROM quotations q
       LEFT JOIN customers cu ON cu.id = q.customer_id
       LEFT JOIN users u ON u.id = q.user_id
       ${where}
       ORDER BY q.created_at DESC
       LIMIT 400`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
}

// GET /api/quotations/:id  -> full quote for the proforma print / convert
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
    if (!['open', 'converted'].includes(status)) {
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

// DELETE /api/quotations/:id
async function deleteQuotation(req, res, next) {
  try {
    const { rowCount } = await query(
      'DELETE FROM quotations WHERE id = $1 AND company_id = $2',
      [req.params.id, req.company.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Quotation not found.' });
    res.json({ message: 'Quotation deleted.' });
  } catch (err) { next(err); }
}

module.exports = {
  createQuotation, listQuotations, getQuotation, setStatus, deleteQuotation,
};
