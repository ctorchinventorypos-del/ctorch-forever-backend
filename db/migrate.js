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
  // Who created the product (for the product-creation record).
  `ALTER TABLE products  ADD COLUMN IF NOT EXISTS created_by INT REFERENCES users(id)`,
  // How many pieces are in a carton (nullable; admin-editable).
  `ALTER TABLE products  ADD COLUMN IF NOT EXISTS qty_per_carton INT`,
  // How a sale line was sold: by piece or by carton, and the pack size used.
  `ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS sold_as VARCHAR(10) NOT NULL DEFAULT 'piece'`,
  `ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS pack_size INT NOT NULL DEFAULT 1`,

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

  // Quotation revisions: each edit is a new version under the same root quote.
  `ALTER TABLE quotations ADD COLUMN IF NOT EXISTS root_id INT`,
  `ALTER TABLE quotations ADD COLUMN IF NOT EXISTS revision INT NOT NULL DEFAULT 1`,
  // Existing rows are their own root.
  `UPDATE quotations SET root_id = id WHERE root_id IS NULL`,
  // Allow a third status: 'superseded' (an older revision that was edited).
  `ALTER TABLE quotations DROP CONSTRAINT IF EXISTS quotations_status_check`,
  `ALTER TABLE quotations ADD CONSTRAINT quotations_status_check
     CHECK (status IN ('open','converted','superseded'))`,
  `CREATE INDEX IF NOT EXISTS idx_quotations_root ON quotations(root_id, revision)`,

  // Idempotency keys: lets a sale/return be retried safely on a flaky
  // connection without creating a duplicate. The original response is stored
  // and replayed if the same key is seen again.
  `CREATE TABLE IF NOT EXISTS idempotency_keys (
     key        VARCHAR(100) PRIMARY KEY,
     endpoint   VARCHAR(40),
     response   JSONB,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,

  // Per-user login history: date/time, IP and device (user-agent) of each
  // successful sign-in, so an admin can review account activity.
  `CREATE TABLE IF NOT EXISTS login_events (
     id         SERIAL PRIMARY KEY,
     user_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     ip         VARCHAR(60),
     user_agent TEXT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS idx_login_events_user ON login_events(user_id, created_at DESC)`,

  // Expand user roles: super_admin, admin, warehouse, sales.
  `ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check`,
  `ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('super_admin','admin','warehouse','sales'))`,
  // Super admin can exempt an account from the inactivity auto-logout.
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS no_idle_timeout BOOLEAN NOT NULL DEFAULT FALSE`,
  // The very first user (id=1) is the super admin.
  `UPDATE users SET role = 'super_admin' WHERE id = 1`,

  // Add "general" walk-in customers (for cash sales) to the customer types.
  `ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_customer_type_check`,
  `ALTER TABLE customers ADD CONSTRAINT customers_customer_type_check CHECK (customer_type IN ('general','credit','reseller'))`,

  // Customer-based returns (reworked): a return is made against a customer,
  // can include several products in partial quantities, adds stock back, and
  // prints its own return invoice (customer / plaza / warehouse copies).
  `CREATE TABLE IF NOT EXISTS customer_returns (
     id            SERIAL PRIMARY KEY,
     company_id    INT NOT NULL REFERENCES companies(id),
     customer_id   INT NOT NULL REFERENCES customers(id),
     branch_id     INT NOT NULL REFERENCES branches(id),
     return_number VARCHAR(40),
     total_amount  NUMERIC(14,2) NOT NULL DEFAULT 0,
     note          TEXT,
     user_id       INT NOT NULL REFERENCES users(id),
     created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS customer_return_items (
     id           SERIAL PRIMARY KEY,
     return_id    INT NOT NULL REFERENCES customer_returns(id) ON DELETE CASCADE,
     product_id   INT NOT NULL REFERENCES products(id),
     quantity     INT NOT NULL CHECK (quantity > 0),
     unit_price   NUMERIC(14,2) NOT NULL DEFAULT 0,
     subtotal     NUMERIC(14,2) NOT NULL DEFAULT 0
   )`,
  `CREATE INDEX IF NOT EXISTS idx_customer_returns_company ON customer_returns(company_id, created_at DESC)`,

  // Link the two per-company sales that make up one cross-company "warehouse sale".
  `ALTER TABLE sales ADD COLUMN IF NOT EXISTS warehouse_ref VARCHAR(40)`,
  `CREATE INDEX IF NOT EXISTS idx_sales_warehouse_ref ON sales(warehouse_ref)`,

  // Multiple payment methods on one sale / payment: [{method, amount}, ...].
  `ALTER TABLE sales ADD COLUMN IF NOT EXISTS payment_splits JSONB`,
  `ALTER TABLE payments ADD COLUMN IF NOT EXISTS payment_splits JSONB`,
];

async function runMigrations() {
  for (const sql of STATEMENTS) {
    await query(sql);
  }
  console.log('Migrations OK (reorder_level, payment_method, quotations + revisions).');
}

module.exports = { runMigrations };
