// ============================================================
//  Starts the server.
//  Run with:  npm run dev   (auto-restarts on changes)
//        or:  npm start
// ============================================================
const app = require('./app');
const { runMigrations } = require('../db/migrate');

const PORT = process.env.PORT || 4000;

// Apply any pending idempotent migrations, then start listening.
runMigrations()
  .catch((err) => {
    console.error('Migration error (continuing to start anyway):', err.message);
  })
  .finally(() => {
    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  });
