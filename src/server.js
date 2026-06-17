// ============================================================
//  Starts the server.
//  Run with:  npm run dev   (auto-restarts on changes)
//        or:  npm start
// ============================================================
const app = require('./app');

const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
