// ============================================================
//  Idempotent migrations that run automatically on server start.
//  Every statement uses IF NOT EXISTS, so it is safe to run on every
//  boot and on a database that already has these changes. This lets new
//  columns/tables (reorder level, payment method, quotations) go live
//  with a normal deploy — no manual psql step.
// ============================================================
const { query } = require('../src/config/db');

const STATEMENTS = [
  // Low-stock threshold per product (used by the inventory report / reminders).
  `ALTER TABLE products  ADD COLUMN IF NOT EXISTS reorder_level INT NOT NULL DEFAULT 5`,

  // How the money came in (cash / transfer / POS card).
  `ALTER TABLE sales     ADD COLUMN IF NOT EXISTS payment_method VARCHAR(20) NOT NULL DEFAULT 'cash'`,
  `ALTER TABLE payments  ADD COLUMN IF NOT EXISTS payment_method VARCHAR(20) NOT NULL DEFAULT 'cash'`,

  // Quotations / proforma invoices.
  `CREATE TABLE IF NOT EXISTS quotations (
     id             SERIAL PRIMARY KEY,
     company_id     INT          NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
     user_id        INT          NOT NULL REFERENCES users(id),
     customer_id    INT          REFERENCES customers(id),
     customer_name  VARCHAR(150),
     quote_number   VARCHAR(40)  UNIQUE NOT NULL,
     total_amount   NUMERIC(14,2) NOT NULL DEFAULT 0,
     note           TEXT,
     status         VARCHAR(20)  NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open','converted')),
     created_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS quotation_items (
     id             SERIAL PRIMARY KEY,
     quotation_id   INT NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
     product_id     INT REFERENCES products(id),
     name_snapshot  VARCHAR(150) NOT NULL,
     quantity       INT NOT NULL CHECK (quantity > 0),
     unit_price     NUMERIC(14,2) NOT NULL,
     subtotal       NUMERIC(14,2) NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_quotations_company_date ON quotations(company_id, created_at)`,
];

async function runMigrations() {
  for (const sql of STATEMENTS) {
    await query(sql);
  }
  console.log('Migrations OK (reorder_level, payment_method, quotations).');
}

module.exports = { runMigrations };
