// ============================================================
//  Canonical registry of every toggleable feature (49).
//  Admins & super-admins always have every feature. For sales and
//  warehouse users the effective value is:
//     per-user override  →  per-role override  →  this default.
//  type: 'action' (can perform) or 'view' (can see in the UI).
// ============================================================
// key, label, category, type, default for sales, default for warehouse
const FEATURES = [
  // Sales & Payments
  ['sale.cash', 'Record cash sale', 'Sales & Payments', 'action', true, false],
  ['sale.credit', 'Record credit sale', 'Sales & Payments', 'action', true, false],
  ['sale.distributor', 'Record distributor sale', 'Sales & Payments', 'action', true, false],
  ['sale.warehouse', 'Warehouse sale (cross-company)', 'Sales & Payments', 'action', true, true],
  ['sale.backdate', 'Back-date a sale', 'Sales & Payments', 'action', true, true],
  ['payment.split', 'Split payment across methods', 'Sales & Payments', 'action', true, false],
  ['payment.record', 'Record a customer payment', 'Sales & Payments', 'action', true, false],
  ['return.record', 'Record a return', 'Sales & Payments', 'action', true, false],

  // Quotations
  ['quote.create', 'Create sales order', 'Quotations', 'action', true, false],
  ['quote.convert', 'Convert order to sale', 'Quotations', 'action', true, false],
  ['quote.status', 'Change order status', 'Quotations', 'action', true, false],
  ['quote.revise', 'Revise a sales order', 'Quotations', 'action', false, false],
  ['quote.delete', 'Delete a sales order', 'Quotations', 'action', false, false],
  ['quote.print', 'Print a sales order', 'Quotations', 'view', true, false],

  // Inventory & Products
  ['inventory.view', 'View inventory', 'Inventory & Products', 'view', true, true],
  ['product.add', 'Add product', 'Inventory & Products', 'action', false, false],
  ['product.edit', 'Edit product', 'Inventory & Products', 'action', false, false],
  ['product.price', 'Set / edit price', 'Inventory & Products', 'action', false, false],
  ['inventory.cost.view', 'Show cost price column', 'Inventory & Products', 'view', false, false],
  ['product.active', 'Deactivate / reactivate product', 'Inventory & Products', 'action', false, false],
  ['stock.restock', 'Restock (add stock)', 'Inventory & Products', 'action', false, true],
  ['stock.transfer', 'Transfer stock', 'Inventory & Products', 'action', false, true],
  ['stock.adjust', 'Adjust / set exact stock', 'Inventory & Products', 'action', false, false],
  ['category.manage', 'Manage categories', 'Inventory & Products', 'action', false, false],
  ['inventory.print', 'Print inventory', 'Inventory & Products', 'view', true, true],
  ['restocks.print', 'Print restocks log', 'Inventory & Products', 'view', false, true],

  // Customers & Debtors
  ['customer.view', 'View customers', 'Customers & Debtors', 'view', true, false],
  ['customer.add', 'Add customer', 'Customers & Debtors', 'action', true, false],
  ['customer.edit', 'Edit customer', 'Customers & Debtors', 'action', false, false],
  ['customer.balance', 'Adjust customer balance', 'Customers & Debtors', 'action', false, false],
  ['customer.statement', 'View customer statement', 'Customers & Debtors', 'view', true, false],
  ['debtors.view', 'View debtors (who owes me)', 'Customers & Debtors', 'view', true, false],

  // Dashboard & Reports
  ['dashboard.money', 'See dashboard money cards', 'Dashboard & Reports', 'view', false, false],
  ['reports.open', 'Open Reports at all', 'Dashboard & Reports', 'view', false, false],
  ['reports.profit', 'View Profit reports', 'Dashboard & Reports', 'view', false, false],
  ['reports.sales_summary', 'View Sales summary', 'Dashboard & Reports', 'view', false, false],
  ['reports.branch', 'View Branch performance', 'Dashboard & Reports', 'view', false, false],
  ['reports.inventory', 'View Inventory report', 'Dashboard & Reports', 'view', false, false],
  ['reports.daily_cash', 'View Daily cash report', 'Dashboard & Reports', 'view', false, false],
  ['reports.account', 'View Account report', 'Dashboard & Reports', 'view', false, false],

  // Records
  ['records.sales', 'View sales records', 'Records', 'view', true, false],
  ['records.payments', 'View payment records', 'Records', 'view', true, false],
  ['records.returns', 'View return records', 'Records', 'view', true, false],
  ['records.stock_changes', 'View stock-change records', 'Records', 'view', false, false],
  ['records.products_added', 'View products-added records', 'Records', 'view', false, false],
  ['records.edit_date', "Edit a record's date", 'Records', 'action', false, false],

  // System / Admin
  ['users.manage', 'Manage users', 'System / Admin', 'action', false, false],
  ['branches.manage', 'Manage branches', 'System / Admin', 'action', false, false],
  ['company.switch', 'Switch active company', 'System / Admin', 'action', true, true],
].map(([key, label, category, type, sales, warehouse]) => ({ key, label, category, type, defaults: { sales, warehouse } }));

const FEATURE_KEYS = new Set(FEATURES.map((f) => f.key));
const TOGGLEABLE_ROLES = ['sales', 'warehouse'];

module.exports = { FEATURES, FEATURE_KEYS, TOGGLEABLE_ROLES };
