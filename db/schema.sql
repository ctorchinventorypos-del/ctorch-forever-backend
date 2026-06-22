-- ============================================================================
--  CTORCH (Lighting) / FOREVER NIGERIA WIRE & CABLE (Wires)
--  Inventory Management System — PostgreSQL schema
--  One app, two companies. Almost every table carries a company_id so the
--  app can "switch" companies and keep their data completely separate.
-- ============================================================================

-- Run this whole file once against an empty database. It is safe to re-run
-- after a full reset (see the DROP section at the very bottom — commented out).


-- ----------------------------------------------------------------------------
-- 1. COMPANIES
--    The two businesses. Everything else hangs off these.
-- ----------------------------------------------------------------------------
CREATE TABLE companies (
    id          SERIAL PRIMARY KEY,
    code        VARCHAR(20)  UNIQUE NOT NULL,        -- 'CTORCH' or 'FOREVER'
    name        VARCHAR(150) NOT NULL,
    address     TEXT,
    phone       VARCHAR(50),
    email       VARCHAR(120),
    logo_path   VARCHAR(255),                        -- used on printed invoices
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ----------------------------------------------------------------------------
-- 2. USERS
--    Two roles: 'admin' and 'sales'. Admins create users, disable access,
--    and edit the recommended (selling) price. Sales users cannot.
--    Login-security columns support lockout after repeated failed logins.
-- ----------------------------------------------------------------------------
CREATE TABLE users (
    id                    SERIAL PRIMARY KEY,
    username              VARCHAR(60)  UNIQUE NOT NULL,
    password_hash         VARCHAR(255) NOT NULL,     -- bcrypt hash, never plain text
    full_name             VARCHAR(120) NOT NULL,
    role                  VARCHAR(20)  NOT NULL DEFAULT 'sales'
                            CHECK (role IN ('admin', 'sales')),
    is_active             BOOLEAN      NOT NULL DEFAULT TRUE,  -- admin can disable access
    failed_login_attempts INT          NOT NULL DEFAULT 0,
    locked_until          TIMESTAMPTZ,                          -- temporary lockout
    last_login            TIMESTAMPTZ,
    created_by            INT          REFERENCES users(id),
    created_at            TIMESTAMPTZ  NOT NULL DEFAULT now()
);


-- ----------------------------------------------------------------------------
-- 3. BRANCHES
--    A warehouse is just a branch with is_warehouse = TRUE.
--    Stock lives at a branch (or the warehouse). Each company has its own.
-- ----------------------------------------------------------------------------
CREATE TABLE branches (
    id            SERIAL PRIMARY KEY,
    company_id    INT          NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name          VARCHAR(120) NOT NULL,
    is_warehouse  BOOLEAN      NOT NULL DEFAULT FALSE,
    address       TEXT,
    phone         VARCHAR(50),
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    UNIQUE (company_id, name)
);

-- A user can have a default branch they sell from (admins usually have none).
ALTER TABLE users
    ADD COLUMN default_branch_id INT REFERENCES branches(id);


-- ----------------------------------------------------------------------------
-- 4. CATEGORIES
--    Users create categories; products live under a category.
-- ----------------------------------------------------------------------------
CREATE TABLE categories (
    id          SERIAL PRIMARY KEY,
    company_id  INT          NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name        VARCHAR(120) NOT NULL,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    UNIQUE (company_id, name)
);


-- ----------------------------------------------------------------------------
-- 5. PRODUCTS
--    product_code is the number you type during restock so quantities ADD UP
--    instead of creating a duplicate product.
--    cost_price          = what you buy it for (per unit)
--    recommended_price   = suggested selling price (only admin can edit)
--    Actual stock counts live in stock_levels (per branch), NOT here.
-- ----------------------------------------------------------------------------
CREATE TABLE products (
    id                 SERIAL PRIMARY KEY,
    company_id         INT          NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    category_id        INT          REFERENCES categories(id) ON DELETE SET NULL,
    product_code       VARCHAR(60)  NOT NULL,                 -- used on restock
    name               VARCHAR(150) NOT NULL,
    description        TEXT,
    unit               VARCHAR(30)  NOT NULL DEFAULT 'pcs',   -- pcs, roll, carton...
    cost_price         NUMERIC(14,2) NOT NULL DEFAULT 0,
    recommended_price  NUMERIC(14,2) NOT NULL DEFAULT 0,
    reorder_level      INT          NOT NULL DEFAULT 5,   -- low-stock threshold
    is_active          BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
    UNIQUE (company_id, product_code)                          -- code unique per company
);


-- ----------------------------------------------------------------------------
-- 6. STOCK_LEVELS
--    How many of each product sit at each branch/warehouse.
--    quantity can never go below 0 (enforced here AND in app logic).
--    Restock adds; sale subtracts; transfer moves between two rows.
-- ----------------------------------------------------------------------------
CREATE TABLE stock_levels (
    id          SERIAL PRIMARY KEY,
    product_id  INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    branch_id   INT NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    quantity    INT NOT NULL DEFAULT 0 CHECK (quantity >= 0),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (product_id, branch_id)
);


-- ----------------------------------------------------------------------------
-- 7. STOCK_MOVEMENTS
--    A full history of every stock change. Useful for audits and for spotting
--    mistakes ("where did these units go?"). Nothing changes stock without
--    leaving a row here.
-- ----------------------------------------------------------------------------
CREATE TABLE stock_movements (
    id              SERIAL PRIMARY KEY,
    company_id      INT NOT NULL REFERENCES companies(id),
    product_id      INT NOT NULL REFERENCES products(id),
    from_branch_id  INT REFERENCES branches(id),    -- null for restock
    to_branch_id    INT REFERENCES branches(id),    -- null for sale
    quantity        INT NOT NULL,
    movement_type   VARCHAR(20) NOT NULL
                      CHECK (movement_type IN
                        ('restock','transfer','sale','return','adjustment')),
    reference_id    INT,                            -- e.g. the sale id or return id
    note            TEXT,
    user_id         INT REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ----------------------------------------------------------------------------
-- 8. CUSTOMERS
--    One table for both kinds of debtor, separated by customer_type:
--      'credit'   = normal credit customer
--      'reseller' = bulk reseller who takes goods on credit to resell
--    balance_owed is the running amount they owe; it can never go negative.
-- ----------------------------------------------------------------------------
CREATE TABLE customers (
    id             SERIAL PRIMARY KEY,
    company_id     INT          NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    customer_type  VARCHAR(20)  NOT NULL
                     CHECK (customer_type IN ('credit','reseller')),
    name           VARCHAR(150) NOT NULL,
    phone          VARCHAR(50),
    address        TEXT,
    balance_owed   NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (balance_owed >= 0),
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);


-- ----------------------------------------------------------------------------
-- 9. SALES  (this is also the RECEIPT/INVOICE record)
--    sale_type:
--      'cash'     = paid in full now
--      'credit'   = credit customer owes (customer_id set)
--      'reseller' = bulk reseller took goods on credit (customer_id set)
--    invoice_number is generated by the app and is unique forever, so any
--    past receipt can be looked up by date and reprinted.
-- ----------------------------------------------------------------------------
CREATE TABLE sales (
    id              SERIAL PRIMARY KEY,
    company_id      INT          NOT NULL REFERENCES companies(id),
    branch_id       INT          NOT NULL REFERENCES branches(id),
    user_id         INT          NOT NULL REFERENCES users(id),
    customer_id     INT          REFERENCES customers(id),   -- null for cash sales
    sale_type       VARCHAR(20)  NOT NULL
                      CHECK (sale_type IN ('cash','credit','reseller')),
    payment_method  VARCHAR(20)  NOT NULL DEFAULT 'cash',  -- cash / transfer / pos
    invoice_number  VARCHAR(40)  UNIQUE NOT NULL,
    total_amount    NUMERIC(14,2) NOT NULL DEFAULT 0,
    amount_paid     NUMERIC(14,2) NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);


-- ----------------------------------------------------------------------------
-- 10. SALE_ITEMS
--    The line items on each sale. unit_price is the price ACTUALLY SOLD AT,
--    which may differ from the product's recommended_price. We snapshot
--    cost_price here so profit reporting stays correct even if cost changes later.
-- ----------------------------------------------------------------------------
CREATE TABLE sale_items (
    id          SERIAL PRIMARY KEY,
    sale_id     INT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
    product_id  INT NOT NULL REFERENCES products(id),
    quantity    INT NOT NULL CHECK (quantity > 0),
    unit_price  NUMERIC(14,2) NOT NULL,              -- price actually sold at
    cost_price  NUMERIC(14,2) NOT NULL DEFAULT 0,    -- snapshot for profit
    subtotal    NUMERIC(14,2) NOT NULL               -- quantity * unit_price
);


-- ----------------------------------------------------------------------------
-- 11. PAYMENTS
--    Money paid back against a credit customer's or reseller's balance.
--    On each payment the app subtracts from customers.balance_owed
--    (and clamps at 0). sale_id is optional (a payment can be general).
-- ----------------------------------------------------------------------------
CREATE TABLE payments (
    id           SERIAL PRIMARY KEY,
    company_id   INT NOT NULL REFERENCES companies(id),
    customer_id  INT NOT NULL REFERENCES customers(id),
    sale_id      INT REFERENCES sales(id),
    amount       NUMERIC(14,2) NOT NULL CHECK (amount > 0),
    payment_method VARCHAR(20) NOT NULL DEFAULT 'cash',     -- cash / transfer / pos
    user_id      INT NOT NULL REFERENCES users(id),
    note         TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ----------------------------------------------------------------------------
-- 12. RETURNS
--    A returned item: adds quantity back to stock at branch_id, and (for credit/
--    reseller sales) reduces the customer's balance_owed by refund_amount,
--    clamped at 0 so it can never go negative.
-- ----------------------------------------------------------------------------
CREATE TABLE returns (
    id             SERIAL PRIMARY KEY,
    company_id     INT NOT NULL REFERENCES companies(id),
    sale_id        INT NOT NULL REFERENCES sales(id),
    product_id     INT NOT NULL REFERENCES products(id),
    branch_id      INT NOT NULL REFERENCES branches(id),   -- where stock goes back
    quantity       INT NOT NULL CHECK (quantity > 0),
    unit_price     NUMERIC(14,2) NOT NULL,
    refund_amount  NUMERIC(14,2) NOT NULL,                 -- quantity * unit_price
    user_id        INT NOT NULL REFERENCES users(id),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ----------------------------------------------------------------------------
-- 12b. QUOTATIONS / PROFORMA INVOICES
--    A price offer for a list of items. Does NOT affect stock or balances.
--    When accepted, the Sales screen loads these items to complete a real sale.
-- ----------------------------------------------------------------------------
CREATE TABLE quotations (
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
);

CREATE TABLE quotation_items (
    id             SERIAL PRIMARY KEY,
    quotation_id   INT NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
    product_id     INT REFERENCES products(id),
    name_snapshot  VARCHAR(150) NOT NULL,
    quantity       INT NOT NULL CHECK (quantity > 0),
    unit_price     NUMERIC(14,2) NOT NULL,
    subtotal       NUMERIC(14,2) NOT NULL
);


-- ----------------------------------------------------------------------------
-- 13. AUDIT_LOG
--    Security trail: who did what, when, from where. Helps pass security
--    reviews and makes the system accountable.
-- ----------------------------------------------------------------------------
CREATE TABLE audit_log (
    id          SERIAL PRIMARY KEY,
    user_id     INT REFERENCES users(id),
    action      VARCHAR(80) NOT NULL,           -- e.g. 'login', 'create_product'
    entity      VARCHAR(60),                    -- e.g. 'product', 'sale'
    entity_id   INT,
    details     JSONB,
    ip_address  VARCHAR(60),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ----------------------------------------------------------------------------
-- 14. INDEXES  (make common lookups fast)
-- ----------------------------------------------------------------------------
CREATE INDEX idx_products_company      ON products(company_id);
CREATE INDEX idx_products_category     ON products(category_id);
CREATE INDEX idx_stock_branch          ON stock_levels(branch_id);
CREATE INDEX idx_sales_company_date    ON sales(company_id, created_at);
CREATE INDEX idx_sales_customer        ON sales(customer_id);
CREATE INDEX idx_sale_items_sale       ON sale_items(sale_id);
CREATE INDEX idx_payments_customer     ON payments(customer_id);
CREATE INDEX idx_payments_company_date ON payments(company_id, created_at);
CREATE INDEX idx_movements_product     ON stock_movements(product_id);
CREATE INDEX idx_movements_company_date ON stock_movements(company_id, created_at);
CREATE INDEX idx_customers_company_type ON customers(company_id, customer_type);
CREATE INDEX idx_returns_company_date  ON returns(company_id, created_at);
CREATE INDEX idx_quotations_company_date ON quotations(company_id, created_at);


-- ----------------------------------------------------------------------------
-- 15. SEED DATA — the two companies and a warehouse for each
--     (The first admin USER is created in Phase 2 by a Node seed script so the
--      password is hashed with bcrypt, the same way logins are checked.)
-- ----------------------------------------------------------------------------
INSERT INTO companies (code, name, phone, email) VALUES
    ('CTORCH',  'CTORCH Lighting', NULL, NULL),
    ('FOREVER', 'FOREVER NIGERIA WIRE & CABLE', NULL, NULL);

-- One warehouse per company to start (you can add branches in the app later).
INSERT INTO branches (company_id, name, is_warehouse)
SELECT id, 'Main Warehouse', TRUE FROM companies WHERE code = 'CTORCH';

INSERT INTO branches (company_id, name, is_warehouse)
SELECT id, 'Main Warehouse', TRUE FROM companies WHERE code = 'FOREVER';


-- ============================================================================
-- 16. FULL RESET (for clearing test data later — KEEP COMMENTED until needed)
--     Uncomment and run ONLY when you want to wipe everything and start fresh.
-- ============================================================================
-- DROP TABLE IF EXISTS audit_log, quotation_items, quotations, returns, payments, sale_items, sales,
--     customers, stock_movements, stock_levels, products, categories,
--     branches, users, companies CASCADE;
