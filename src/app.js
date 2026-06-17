// ============================================================
//  Builds the Express app: security middleware, routes, errors.
//  (server.js starts it; keeping them separate makes testing easier.)
// ============================================================
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
require('dotenv').config();

const { query } = require('./config/db');

// Feature routes
const authRoutes = require('./routes/auth.routes');
const companiesRoutes = require('./routes/companies.routes');
const categoriesRoutes = require('./routes/categories.routes');
const branchesRoutes = require('./routes/branches.routes');
const productsRoutes = require('./routes/products.routes');
const stockRoutes = require('./routes/stock.routes');
const customersRoutes = require('./routes/customers.routes');
const salesRoutes = require('./routes/sales.routes');
const paymentsRoutes = require('./routes/payments.routes');
const returnsRoutes = require('./routes/returns.routes');

const { errorHandler } = require('./middleware/errorHandler');

const app = express();

// --- Security & basics ---
app.use(helmet());                        // sets secure HTTP headers
app.use(express.json({ limit: '1mb' }));  // parse JSON request bodies
app.set('trust proxy', 1);                // correct client IPs behind Render

// Only let your frontend call this API.
const allowedOrigins = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: allowedOrigins.length ? allowedOrigins : true,
    credentials: true,
  })
);

// --- Health check: also proves the database has the seed data ---
app.get('/api/health', async (req, res, next) => {
  try {
    const { rows } = await query('SELECT code, name FROM companies ORDER BY id');
    res.json({ status: 'ok', companies: rows });
  } catch (err) {
    next(err);
  }
});

// --- Feature routes ---
app.use('/api/auth', authRoutes);
app.use('/api/companies', companiesRoutes);
app.use('/api/categories', categoriesRoutes);
app.use('/api/branches', branchesRoutes);
app.use('/api/products', productsRoutes);
app.use('/api/stock', stockRoutes);
app.use('/api/customers', customersRoutes);
app.use('/api/sales', salesRoutes);
app.use('/api/payments', paymentsRoutes);
app.use('/api/returns', returnsRoutes);

// --- Error handler must be LAST ---
app.use(errorHandler);

module.exports = app;
