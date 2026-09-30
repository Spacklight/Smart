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
- **Controlled SQL**: CREATE/SHOW/DROP DATABASE, CREATE/SHOW/DROP TABLE, INSERT, SELECT (with WHERE, ORDER BY, LIMIT), UPDATE, DELETE
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

Smartbase uses Firebase Authentication with Google Sign-In for browser account creation and sign-in. Firebase is used only as the identity/authentication layer; Smartbase application records, databases, tables, records, usage data and API-key metadata remain in the configured Hugging Face dataset storage.

The Firebase Web API key and project ID are client configuration values and are included in the web configuration. Do not add Firebase service-account private keys to the project.

Google authentication requires the production Smartbase domain to be listed in Firebase Authentication > Settings > Authorized domains.


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
- Free-plan limits: 20 databases, 50 tables/database, 500 total tables, 500 MB/user target file storage, 25 MB maximum file upload, 5 API keys/account, 2 MB API request body.
- API-key traffic is rate-limited to 20 requests/minute and 2,000 requests/day per user within each running application instance.

### File-storage note
The current Smartbase core is dataset/database focused and does not yet expose a production binary-file upload endpoint. The 500 MB storage and 25 MB per-file values are the product policy for the file-storage feature; they should be enforced by the future file-storage endpoint. Binary files should not be stored as large Base64 database fields in production.
