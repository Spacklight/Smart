# Smartbase - SQL-Powered Cloud Database Management Platform

Smartbase is a lightweight database platform that allows users to create and manage databases through a modern web interface and a controlled SQL-like interface. It does NOT run MySQL/PostgreSQL - it implements its own operation engine with Hugging Face Datasets as persistent storage.

## Architecture

```
Smartbase User
       ↓
Smartbase API (Express)
       ↓
Authentication (JWT + bcrypt)
       ↓
Operation Engine (Database/Table/Record/SQL)
       ↓
Storage Adapter (Abstraction Layer)
       ↓
Hugging Face Storage Adapter
       ↓
Hugging Face Dataset Storage (or Local Mock)
```

## Features

- **5 databases** per free account, **10 tables** per database (enforced server-side)
- **Hugging Face persistence** - all data survives restarts
- **SQL engine (tastdone)**: multi-statement scripts, CREATE/ALTER/DROP TABLE, views and indexes, INSERT (multi-row, INSERT...SELECT, ON DUPLICATE KEY UPDATE), UPDATE/DELETE with expressions, SELECT with all JOINs, GROUP BY/HAVING, subqueries, WITH (recursive), UNION/INTERSECT/EXCEPT, CASE/CAST, 60+ functions, PRIMARY KEY/UNIQUE/NOT NULL/DEFAULT/CHECK/AUTO_INCREMENT, BEGIN/COMMIT/ROLLBACK. Platform statements CREATE/SHOW/DROP DATABASE still work.
- **Files**: per-account file storage (up to 50 MB per file, 1 GB free per account, or your own Backblaze B2 bucket) usable from the dashboard and with API keys (`/apiv1/files`).
- **Supported Types**: INTEGER, FLOAT, TEXT, BOOLEAN, DATE, DATETIME, JSON
- **User Isolation**: Every request verifies ownership - User A cannot access User B
- **REST API**: Full CRUD + SQL endpoint
- **Responsive**: Mobile-friendly, works on Android/iPhone/tablet/desktop
- **Security**: Password hashing, JWT, no HF tokens in browser, SQL parser whitelisting

## Storage Requirement (Critical)

ALL USER DATA PERSISTED IN HUGGING FACE.

- Local registry (`registry/registry.json`) is ONLY index/relationship map
- Actual metadata, schemas, records → Hugging Face Datasets
- Structure: `users/{userId}/databases.json`, `users/{userId}/databases/{dbId}/metadata.json`, `users/{userId}/databases/{dbId}/tables/{tableId}/records.json`
- Adapter pattern: `storage/adapter.js` talks to `storage/huggingface/client.js`
- Can swap provider without changing user interface

## Quick Start

```bash
npm install
npm start
# Open http://localhost:3000
```

### Enable Live Hugging Face

Create `.env` from `.env.example`:

```
HF_TOKEN=hf_xxx
HF_DATASET=username/smartbase-storage
HF_USERNAME=username
```

If not set, uses local mock at `./data/hf-mock` which is HF-compatible and survives restarts.

## API

```bash
# Register
POST /api/v1/auth/register { username, email, password }

# Login
POST /api/v1/auth/login { username, password } → { token }

# Databases
GET /api/v1/databases
POST /api/v1/databases { name, description }
GET /api/v1/databases/:id
PUT /api/v1/databases/:id
DELETE /api/v1/databases/:id

# Tables
GET /api/v1/databases/:dbId/tables
POST /api/v1/databases/:dbId/tables { name, columns: [{name, type, nullable}] }
DELETE /api/v1/databases/:dbId/tables/:tableId

# Records
GET /api/v1/databases/:dbId/tables/:tableId/records?page=1&limit=50
POST /api/v1/databases/:dbId/tables/:tableId/records { records: [...] }

# SQL
POST /api/v1/query { database_id, sql }
```

### SQL Examples

```sql
CREATE DATABASE shop;
SHOW DATABASES;
CREATE TABLE customers (id INTEGER, name TEXT, email TEXT, age INTEGER);
SHOW TABLES;
INSERT INTO customers (id, name, email, age) VALUES (1, 'John Banda', 'john@example.com', 25);
SELECT * FROM customers;
SELECT * FROM customers WHERE age > 25 ORDER BY age DESC LIMIT 10;
UPDATE customers SET age = 26 WHERE id = 1;
DELETE FROM customers WHERE id = 1;
DROP TABLE customers;
DROP DATABASE shop;
```

## Security Tests

- User A → Database B → 403 Unauthorized (enforced)
- SQL injection attempts blocked by parser whitelist
- HF tokens never exposed to frontend
- Limits enforced server-side, not just UI

## Project Structure

```
smartbase/
├── server/
│   ├── index.js
│   ├── auth/
│   ├── storage/
│   │   ├── adapter.js (abstraction)
│   │   └── huggingface/client.js (HF implementation)
│   ├── sql/
│   │   ├── parser.js
│   │   └── executor.js
│   ├── api/routes.js
│   └── middleware/auth.js
├── public/
│   ├── index.html (landing + SPA)
│   ├── css/style.css
│   └── js/app.js
├── registry/registry.json (index only)
├── data/hf-mock/ (HF-compatible local persistence)
└── .env.example
```

## Free Limits Display

Always shown:
- Databases: 3/5
- Tables: 8/10 per DB
- Error: { success:false, error:"DATABASE_LIMIT_REACHED", message:"Free accounts can create a maximum of 5 databases." }

## Future Expansion

- ALTER TABLE, JOIN, GROUP BY, COUNT/SUM/AVG, indexes, foreign keys
- CSV import/export, backups, team collaboration, webhooks, GraphQL
- Billing, premium plans

## License

MIT

## Private Administration

The production build includes a protected `/admin.html` page. It is not linked from the public application. The backend checks the authenticated account against the Cloudflare secret `ADMIN_EMAIL` (or optional `ADMIN_USER_ID`).

Admin capabilities:
- View registered-account counts and safe account metadata.
- View database/table/record totals per account.
- View aggregated request/session activity and last activity.
- View approximate network location (city/region/country) supplied by Cloudflare; exact GPS coordinates are not collected.
- Permanently delete one, several, or all non-administrator accounts and their Smartbase data.
- Maintain an administration catalog of Hugging Face dataset IDs.

Passwords, password hashes, session tokens, and API-key secrets are never returned by the administration API.

### Required Cloudflare secret

Set `ADMIN_EMAIL` to the email address of the administrator account. Keep it as a Cloudflare secret; do not put it in source code.

Optional:
- `ADMIN_USER_ID` can be set to the administrator's Smartbase user ID for an additional identity check.

The dataset catalog is administrative metadata only. The platform's primary storage remains the configured `HF_DATASET` dataset.

## Authentication

Smartbase signs users in with Google using its own OAuth client (authorization-code flow, no Firebase).

- Flow: `/api/v1/auth/google/start` sends the browser to Google; Google returns to `/api/v1/auth/google/callback`; the browser then collects its session from `/api/v1/auth/session`.
- Worker secrets: `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (never put the secret in frontend code). `PUBLIC_URL` (in `wrangler.jsonc`) is the official address, `https://smartbase.de5.net`.
- In Google Cloud Console (OAuth client "Smartbase Web Client") add this **Authorized redirect URI**: `https://smartbase.de5.net/api/v1/auth/google/callback`.
- Scopes requested: `openid email profile`. A verified Google email is required.
- Existing accounts are matched by email, so people who signed in before keep their account and data.

## Recent UI features
- Professional toast/prompt dialogs with no native browser alert/prompt/confirm UI.
- API Center with authentication guidance, endpoint reference, cURL and JavaScript examples.
- Learn Smartbase guide covering workflow, functions, users and free-plan limits.
- Community Experiences page with authenticated user submissions stored in cloud storage.

## v3 UX, terms, themes and usage limits

- Account creation requires accepting the Smartbase Terms & Conditions.
- Terms acceptance is persisted with newly created Google-authenticated accounts.
- Google login/account creation shows a full-screen loading state through redirect authentication.
- Light/dark theme toggle is available and persisted in the browser.
- API Center uses a key icon.
- Free-plan limits: 20 databases, 50 tables/database, 500 total tables, 1 GB/user file storage, 50 MB maximum file upload, 5 API keys/account, 2 MB API request body.
- API-key traffic is rate-limited to 20 requests/minute and 2,000 requests/day per user within each running application instance.

### File-storage note
Files are available at `/api/v1/files` (browser session) and `/apiv1/files` (API key): `GET /files`, `GET /files/:name`, `PUT /files/:name` (raw bytes), `POST /files` (JSON with base64 `data`), `DELETE /files/:name`, `GET /usage`. Read keys can list/download; write keys can upload/delete.

Hugging Face only accepts small files in a normal commit, so Smartbase stores a file as base64 text: files up to 5 MB are one document, and larger files (up to 50 MB) are stored in 5 MB parts (`users/<id>/files/<name>/part-0000.json` ...). The dashboard splits and uploads parts for you with a progress bar; API users send the parts themselves (`PUT /files/NAME/parts/INDEX?total=N&size=SIZE`, then `POST /files/NAME/complete`).

Each stored part is a separate Hugging Face commit, so a 50 MB file uses 11 commits. Workers also need enough CPU time for the base64 work (the **Workers Paid** plan is recommended for large files).

**Your own Backblaze B2 bucket.** Under External Storage → File Storage an account can send all new files straight to its own bucket (no 1 GB limit, not counted in the free storage). The browser uploads directly to the bucket with a signed link, so the bucket needs a CORS rule for `https://smartbase.de5.net` (operations `s3_put, s3_get, s3_head`, headers `*`). "Test direct upload" checks it. `FILE_QUOTA_BYTES` changes the 1 GB quota.

**Database bindings** now do real work: "Test connection" writes, finds and deletes a test object in the bucket, "Back up now" saves every table and record of the database into `databases/<id>/backups/` in the bucket, and the backups can be listed and downloaded.

### SQL engine notes (tastdone merge)
- `server/sql/engine.js` is the pure-JS engine; `server/sql/executor.js` bridges it to the existing Hugging Face layout (`tables.json`, table `metadata.json`, `records.json`), so dashboard tables, the Data Browser and the REST record endpoints keep working on the same data.
- Only tables mentioned in the SQL are loaded; only changed tables are written back. A script is atomic: if any statement fails, nothing is saved.
- Records inserted by SQL get an `id` (for the record REST endpoints) unless the table declares its own `id` column.
- Views, indexes and engine metadata (keys, defaults, auto-increment) are stored in the database/table metadata.
- API keys: a script that only reads (SELECT/SHOW) needs a read key; anything else needs a write key.
- Tests: `node test/merge.test.mjs` (no network needed).
