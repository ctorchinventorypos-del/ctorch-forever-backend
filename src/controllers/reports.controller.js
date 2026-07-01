// ============================================================
//  Reports: read-only summaries built from the sales/payments/stock data.
//
//  Profit = sum(unit_price - cost_price) * quantity, using the cost_price
//  SNAPSHOT stored on each sale_item (so old reports stay correct even after
//  a product's cost changes). Profit figures are sensitive, so they are only
//  returned to admins; sales users see revenue but profit comes back null.
// ============================================================
const { query } = require('../config/db');

const isAdmin = (req) => req.user && req.user.role === 'admin';

// Build a "created_at within [from, to]" clause; "to" includes the whole day.
function dateClause(params, from, to, col = 's.created_at') {
  let sql = '';
  if (from) { params.push(from); sql += ` AND ${col} >= $${params.length}`; }
  if (to)   { params.push(to);   sql += ` AND ${col} < ($${params.length}::date + 1)`; }
  return sql;
}

// GET /api/reports/dashboard
// Headline numbers for the home screen: today + this month revenue/profit,
// sales counts, outstanding debt, and how many products are low on stock.
async function dashboard(req, res, next) {
  try {
    const cid = req.company.id;
    const admin = isAdmin(req);

    const money = await query(
      `SELECT
         COALESCE(SUM(CASE WHEN s.created_at::date = CURRENT_DATE THEN s.total_amount END),0)        AS revenue_today,
         COUNT(*) FILTER (WHERE s.created_at::date = CURRENT_DATE)                                    AS sales_today,
         COALESCE(SUM(CASE WHEN date_trunc('month',s.created_at)=date_trunc('month',CURRENT_DATE)
                           THEN s.total_amount END),0)                                                AS revenue_month,
         COUNT(*) FILTER (WHERE date_trunc('month',s.created_at)=date_trunc('month',CURRENT_DATE))    AS sales_month
       FROM sales s WHERE s.company_id = $1`,
      [cid]
    );

    let profitToday = null, profitMonth = null;
    if (admin) {
      const prof = await query(
        `SELECT
           COALESCE(SUM(CASE WHEN s.created_at::date = CURRENT_DATE
                             THEN (si.unit_price - si.cost_price) * si.quantity END),0) AS profit_today,
           COALESCE(SUM(CASE WHEN date_trunc('month',s.created_at)=date_trunc('month',CURRENT_DATE)
                             THEN (si.unit_price - si.cost_price) * si.quantity END),0) AS profit_month
         FROM sale_items si JOIN sales s ON s.id = si.sale_id
         WHERE s.company_id = $1`,
        [cid]
      );
      profitToday = Number(prof.rows[0].profit_today);
      profitMonth = Number(prof.rows[0].profit_month);
    }

    const owed = await query(
      `SELECT COALESCE(SUM(balance_owed),0) AS owed,
              COUNT(*) FILTER (WHERE balance_owed > 0) AS debtors
       FROM customers WHERE company_id = $1`,
      [cid]
    );

    const low = await query(
      `SELECT COUNT(*) AS low_stock FROM (
         SELECT p.id, COALESCE(SUM(sl.quantity),0) AS qty, p.reorder_level
         FROM products p
         LEFT JOIN stock_levels sl ON sl.product_id = p.id
         WHERE p.company_id = $1 AND p.is_active = TRUE
         GROUP BY p.id
         HAVING COALESCE(SUM(sl.quantity),0) <= p.reorder_level
       ) t`,
      [cid]
    );

    const m = money.rows[0];
    res.json({
      revenue_today: Number(m.revenue_today),
      revenue_month: Number(m.revenue_month),
      sales_today: Number(m.sales_today),
      sales_month: Number(m.sales_month),
      profit_today: profitToday,
      profit_month: profitMonth,
      owed: Number(owed.rows[0].owed),
      debtors: Number(owed.rows[0].debtors),
      low_stock: Number(low.rows[0].low_stock),
    });
  } catch (err) { next(err); }
}

// GET /api/reports/profit?group=day|month|year|product&from=&to=   (ADMIN)
async function profit(req, res, next) {
  try {
    const group = ['day', 'month', 'year', 'product'].includes(req.query.group)
      ? req.query.group : 'month';
    const params = [req.company.id];
    const dc = dateClause(params, req.query.from, req.query.to);

    let select, groupBy, orderBy, label;
    if (group === 'product') {
      label = 'p.name';
      select = `p.name AS label`;
      groupBy = `GROUP BY p.name`;
      orderBy = `ORDER BY SUM((si.unit_price - si.cost_price) * si.quantity) DESC`;
    } else {
      const trunc = group === 'day' ? 'day' : group === 'year' ? 'year' : 'month';
      select = `to_char(date_trunc('${trunc}', s.created_at), '${
        group === 'day' ? 'YYYY-MM-DD' : group === 'year' ? 'YYYY' : 'YYYY-MM'
      }') AS label`;
      groupBy = `GROUP BY date_trunc('${trunc}', s.created_at)`;
      orderBy = `ORDER BY date_trunc('${trunc}', s.created_at) DESC`;
    }

    const { rows } = await query(
      `SELECT ${select},
              COALESCE(SUM(si.subtotal),0)                              AS revenue,
              COALESCE(SUM(si.cost_price * si.quantity),0)              AS cost,
              COALESCE(SUM((si.unit_price - si.cost_price)*si.quantity),0) AS profit,
              COALESCE(SUM(si.quantity),0)                              AS units
       FROM sale_items si
       JOIN sales s ON s.id = si.sale_id
       ${group === 'product' ? 'JOIN products p ON p.id = si.product_id' : ''}
       WHERE s.company_id = $1 ${dc}
       ${groupBy} ${orderBy}
       LIMIT 500`,
      params
    );
    res.json(rows.map((r) => ({
      label: r.label,
      revenue: Number(r.revenue),
      cost: Number(r.cost),
      profit: Number(r.profit),
      units: Number(r.units),
    })));
  } catch (err) { next(err); }
}

// GET /api/reports/sales-summary?group=day|month&from=&to=
async function salesSummary(req, res, next) {
  try {
    const group = req.query.group === 'month' ? 'month' : 'day';
    const fmt = group === 'month' ? 'YYYY-MM' : 'YYYY-MM-DD';
    const params = [req.company.id];
    const dc = dateClause(params, req.query.from, req.query.to);

    const { rows } = await query(
      `SELECT to_char(date_trunc('${group}', s.created_at), '${fmt}') AS label,
              COUNT(*)                                   AS sales_count,
              COALESCE(SUM(s.total_amount),0)            AS revenue,
              COALESCE(SUM(s.amount_paid),0)             AS collected,
              COALESCE(SUM(CASE WHEN s.sale_type='cash'     THEN s.total_amount END),0) AS cash,
              COALESCE(SUM(CASE WHEN s.sale_type='credit'   THEN s.total_amount END),0) AS credit,
              COALESCE(SUM(CASE WHEN s.sale_type='reseller' THEN s.total_amount END),0) AS reseller
       FROM sales s
       WHERE s.company_id = $1 ${dc}
       GROUP BY date_trunc('${group}', s.created_at)
       ORDER BY date_trunc('${group}', s.created_at) DESC
       LIMIT 400`,
      params
    );
    res.json(rows.map((r) => ({
      label: r.label,
      sales_count: Number(r.sales_count),
      revenue: Number(r.revenue),
      collected: Number(r.collected),
      cash: Number(r.cash),
      credit: Number(r.credit),
      reseller: Number(r.reseller),
    })));
  } catch (err) { next(err); }
}

// GET /api/reports/branch-performance?from=&to=
async function branchPerformance(req, res, next) {
  try {
    const admin = isAdmin(req);

    // Revenue + sale count per branch (from sales only — no item join, so
    // totals aren't multiplied by the number of line items).
    const pRev = [req.company.id];
    const dcRev = dateClause(pRev, req.query.from, req.query.to);
    const revRows = await query(
      `SELECT b.id, b.name, b.is_warehouse,
              COUNT(s.id)                     AS sales_count,
              COALESCE(SUM(s.total_amount),0) AS revenue
       FROM branches b
       LEFT JOIN sales s ON s.branch_id = b.id AND s.company_id = $1 ${dcRev}
       WHERE b.company_id = $1
       GROUP BY b.id
       ORDER BY revenue DESC`,
      pRev
    );

    // Profit per branch (needs the item-level cost snapshot).
    let profitByBranch = {};
    if (admin) {
      const pProf = [req.company.id];
      const dcProf = dateClause(pProf, req.query.from, req.query.to);
      const profRows = await query(
        `SELECT s.branch_id,
                COALESCE(SUM((si.unit_price - si.cost_price) * si.quantity),0) AS profit
         FROM sale_items si
         JOIN sales s ON s.id = si.sale_id
         WHERE s.company_id = $1 ${dcProf}
         GROUP BY s.branch_id`,
        pProf
      );
      profRows.rows.forEach((r) => { profitByBranch[r.branch_id] = Number(r.profit); });
    }

    res.json(revRows.rows.map((r) => ({
      id: r.id, name: r.name, is_warehouse: r.is_warehouse,
      sales_count: Number(r.sales_count),
      revenue: Number(r.revenue),
      profit: admin ? (profitByBranch[r.id] || 0) : null,
    })));
  } catch (err) { next(err); }
}

// GET /api/reports/inventory   -> stock valuation + low-stock list
async function inventory(req, res, next) {
  try {
    const admin = isAdmin(req);
    const { rows } = await query(
      `SELECT p.id, p.product_code, p.name, p.unit, p.cost_price, p.recommended_price,
              p.reorder_level, c.name AS category_name,
              COALESCE(SUM(sl.quantity),0)::int AS total_stock
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN stock_levels sl ON sl.product_id = p.id
       WHERE p.company_id = $1 AND p.is_active = TRUE
       GROUP BY p.id, c.name
       ORDER BY total_stock ASC, p.name`,
      [req.company.id]
    );

    const items = rows.map((r) => {
      const stock = Number(r.total_stock);
      const costValue = stock * Number(r.cost_price);
      const retailValue = stock * Number(r.recommended_price);
      return {
        id: r.id, product_code: r.product_code, name: r.name, unit: r.unit,
        category_name: r.category_name, total_stock: stock,
        reorder_level: Number(r.reorder_level),
        low: stock <= Number(r.reorder_level),
        cost_value: admin ? costValue : null,
        retail_value: retailValue,
      };
    });
    const totals = {
      cost_value: admin ? items.reduce((s, i) => s + (i.cost_value || 0), 0) : null,
      retail_value: items.reduce((s, i) => s + i.retail_value, 0),
      low_count: items.filter((i) => i.low).length,
      product_count: items.length,
    };
    res.json({ items, totals });
  } catch (err) { next(err); }
}

// GET /api/reports/debtors  -> who owes, with the age of their oldest debt
async function debtors(req, res, next) {
  try {
    const { rows } = await query(
      `SELECT cu.id, cu.name, cu.phone, cu.customer_type, cu.balance_owed,
              (SELECT MIN(s.created_at) FROM sales s
                 WHERE s.customer_id = cu.id AND s.amount_paid < s.total_amount) AS oldest_unpaid,
              (SELECT MAX(p.created_at) FROM payments p WHERE p.customer_id = cu.id) AS last_payment
       FROM customers cu
       WHERE cu.company_id = $1 AND cu.balance_owed > 0
       ORDER BY oldest_unpaid ASC NULLS LAST, cu.balance_owed DESC`,
      [req.company.id]
    );
    res.json(rows.map((r) => ({
      id: r.id, name: r.name, phone: r.phone, customer_type: r.customer_type,
      balance_owed: Number(r.balance_owed),
      oldest_unpaid: r.oldest_unpaid, last_payment: r.last_payment,
    })));
  } catch (err) { next(err); }
}

// GET /api/reports/daily-cash?date=YYYY-MM-DD
// A day's money-in: every payment received that day (both money collected on
// sales and separate credit/reseller payments), totalled by method.
async function dailyCash(req, res, next) {
  try {
    const cid = req.company.id;
    const date = req.query.date || new Date().toISOString().slice(0, 10);

    // Money collected at the point of sale (the amount_paid portion).
    const salesRows = await query(
      `SELECT s.id, s.invoice_number, s.payment_method, s.amount_paid AS amount, s.created_at,
              cu.name AS customer_name, u.full_name AS received_by
       FROM sales s
       LEFT JOIN customers cu ON cu.id = s.customer_id
       JOIN users u ON u.id = s.user_id
       WHERE s.company_id = $1 AND s.created_at::date = $2::date AND s.amount_paid > 0
       ORDER BY s.created_at`,
      [cid, date]
    );

    // Separate payments made against outstanding balances that day.
    const payRows = await query(
      `SELECT p.id, p.payment_method, p.amount, p.created_at,
              cu.name AS customer_name, u.full_name AS received_by
       FROM payments p
       LEFT JOIN customers cu ON cu.id = p.customer_id
       JOIN users u ON u.id = p.user_id
       WHERE p.company_id = $1 AND p.created_at::date = $2::date
       ORDER BY p.created_at`,
      [cid, date]
    );

    const methods = { cash: 0, transfer: 0, pos: 0, cheque: 0 };
    const list = [];
    salesRows.rows.forEach((r) => {
      const m = methods[r.payment_method] !== undefined ? r.payment_method : 'cash';
      methods[m] += Number(r.amount);
      list.push({ kind: 'Sale', ref: r.invoice_number, method: m, amount: Number(r.amount),
        customer_name: r.customer_name, received_by: r.received_by, created_at: r.created_at });
    });
    payRows.rows.forEach((r) => {
      const m = methods[r.payment_method] !== undefined ? r.payment_method : 'cash';
      methods[m] += Number(r.amount);
      list.push({ kind: 'Payment', ref: '—', method: m, amount: Number(r.amount),
        customer_name: r.customer_name, received_by: r.received_by, created_at: r.created_at });
    });
    list.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

    const total = methods.cash + methods.transfer + methods.pos + methods.cheque;
    res.json({ date, methods, total, count: list.length, list });
  } catch (err) { next(err); }
}

module.exports = {
  dashboard, profit, salesSummary, branchPerformance, inventory, debtors, dailyCash,
};
