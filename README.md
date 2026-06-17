# CTORCH / FOREVER — Backend

Node + Express + PostgreSQL backend for the inventory management system.

## First-time setup

1. Install dependencies:
   ```
   npm install
   ```
2. Create your `.env` file from the template and fill it in:
   ```
   cp .env.example .env
   ```
   - `DATABASE_URL` = the External Database URL from your Render Postgres dashboard
   - `JWT_SECRET`  = a long random string (see the command inside .env.example)
   - `ADMIN_PASSWORD` = the password you want for the first admin
3. (If you haven't already) load the database tables:
   - Run `db/schema.sql` against your Render database.
4. Create the first admin user:
   ```
   npm run seed
   ```

## Running

```
npm run dev      # development, auto-restarts on changes
npm start        # plain start
```

Then open http://localhost:4000/api/health — you should see CTORCH and FOREVER.

## Folder map

- `src/config/db.js` — database connection
- `src/middleware/` — auth, role checks, company switching, errors
- `src/controllers/` — the logic for each feature
- `src/routes/` — the URL endpoints
- `src/utils/` — helpers (audit log)
- `db/schema.sql` — the database tables
- `db/seed.js` — creates the first admin
