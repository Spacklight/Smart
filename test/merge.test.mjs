import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStorageAdapter } from '../server/storage/adapter.js';
import { executeSQL, classifySQLPermission } from '../server/sql/executor.js';
import { createFileService } from '../server/files/files.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-'));
const mk = () => createStorageAdapter({ token: '', dataset: '', isProduction: false, allowMock: true, localPath: dir });
let storage = mk(); const U = 'user_1';
let n = 0; const authModule = { generateId: (p) => p + '_' + (++n).toString(36) + Math.random().toString(36).slice(2, 6) };
const sql = (q, db) => executeSQL(U, db, q, { storage, authModule });
const fail = async (q, db) => { try { await sql(q, db); } catch (e) { return e; } assert.fail('expected failure: ' + q); };

// --- platform statements
assert.match((await sql('CREATE DATABASE shop')).message, /created/);
const dbs = (await sql('SHOW DATABASES')).rows; assert.equal(dbs.length, 1); const DB = dbs[0].id;
assert.equal((await fail('CREATE DATABASE shop')).code, 'DUPLICATE_DATABASE');

// --- DDL + DML + joins through the new engine
await sql(`CREATE TABLE customers (id INTEGER PRIMARY KEY AUTO_INCREMENT, name VARCHAR(50) NOT NULL, email TEXT UNIQUE, age INT);
           CREATE TABLE orders (oid INT PRIMARY KEY, customer_id INT, total DECIMAL(10,2), status TEXT DEFAULT 'open');
           INSERT INTO customers (name,email,age) VALUES ('Ann','a@x.com',30),('Bob','b@x.com',25),('Cy','c@x.com',NULL);
           INSERT INTO orders (oid,customer_id,total) VALUES (1,1,100.5),(2,1,20),(3,2,50);`, DB);
let r = await sql('SELECT c.name, SUM(o.total) AS spent, COUNT(o.oid) n FROM customers c LEFT JOIN orders o ON o.customer_id=c.id GROUP BY c.name ORDER BY spent DESC', DB);
assert.deepEqual(r.rows, [{ name: 'Ann', spent: 120.5, n: 2 }, { name: 'Bob', spent: 50, n: 1 }, { name: 'Cy', spent: null, n: 0 }]);
assert.equal(r.count, 3); assert.deepEqual(r.columns, ['name', 'spent', 'n']);

// --- storage layout stays compatible with the existing REST endpoints
let tables = await storage.getDatabaseTables(U, DB);
assert.deepEqual(tables.map((t) => [t.name, t.record_count]).sort(), [['customers', 3], ['orders', 3]]);
const cust = tables.find((t) => t.name === 'customers'), ord = tables.find((t) => t.name === 'orders');
assert.deepEqual(cust.columns.map((c) => [c.name, c.type, c.nullable]), [['id', 'INTEGER', false], ['name', 'TEXT', false], ['email', 'TEXT', true], ['age', 'INTEGER', true]]);
const orders = await storage.getRecords(U, DB, ord.id); assert.ok(orders.every((o) => String(o.id).startsWith('sb_rec_')), 'rows get ids for REST PUT/DELETE');

// --- persistence + engine metadata survive a fresh adapter (no cache)
storage = mk();
r = await sql("INSERT INTO customers (name,email) VALUES ('Dee','d@x.com')", DB); assert.equal(r.insert_id, 4);
assert.equal((await sql('SELECT COUNT(*) c FROM customers', DB)).rows[0].c, 4);
// --- failures save nothing and give proper codes
let e = await fail("INSERT INTO customers (name,email) VALUES ('Ann2','a@x.com')", DB); assert.equal(e.code, 'SQL_ERROR'); assert.match(e.message, /Duplicate/);
e = await fail("INSERT INTO customers (name,email) VALUES ('Ok','ok@x.com'); INSERT INTO customers (email) VALUES ('nope@x.com')", DB); assert.match(e.message, /Statement 2/);
assert.equal((await sql('SELECT COUNT(*) c FROM customers', DB)).rows[0].c, 4, 'script is atomic');
assert.equal((await fail('SELEC 1', DB)).code, 'INVALID_SQL');
assert.equal((await fail('SELECT * FROM nope', DB)).code, 'TABLE_NOT_FOUND');

// --- legacy (dashboard-created) table keeps working through SQL, and untouched tables are not rewritten
const legacy = { id: 'sb_tbl_legacy', database_id: DB, name: 'products', columns: [{ name: 'sku', type: 'TEXT', nullable: false }, { name: 'price', type: 'FLOAT', nullable: true }], created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
await storage.createTable(U, DB, legacy); await storage.insertRecords(U, DB, legacy.id, [{ id: 'sb_rec_a', sku: 'A1', price: 10 }, { id: 'sb_rec_b', sku: 'B2', price: 70 }]);
const ordersBefore = JSON.stringify(await storage.getRecords(U, DB, ord.id));
await sql("UPDATE products SET price = price * 2 WHERE sku='A1'; INSERT INTO products VALUES ('C3', 5)", DB);
const prods = await storage.getRecords(U, DB, legacy.id);
assert.deepEqual(prods.map((p) => [p.id.startsWith('sb_rec'), p.sku, p.price]), [[true, 'A1', 20], [true, 'B2', 70], [true, 'C3', 5]]); assert.equal(prods[0].id, 'sb_rec_a');
assert.equal(JSON.stringify(await storage.getRecords(U, DB, ord.id)), ordersBefore);

// --- ALTER / rename / views / indexes persist
await sql('ALTER TABLE products RENAME COLUMN price TO cost; ALTER TABLE products RENAME TO items; CREATE VIEW cheap AS SELECT sku FROM items WHERE cost < 50; CREATE UNIQUE INDEX ux_sku ON items (sku)', DB);
storage = mk();
assert.deepEqual((await sql('SELECT * FROM cheap', DB)).rows, [{ sku: 'A1' }, { sku: 'C3' }]);
assert.ok((await storage.getDatabaseTables(U, DB)).some((t) => t.name === 'items' && t.columns.some((c) => c.name === 'cost')));
assert.equal((await fail("INSERT INTO items VALUES ('A1', 1)", DB)).code, 'SQL_ERROR');
assert.equal((await sql('SHOW TABLES', DB)).rows.length, 4);
await sql('DROP TABLE items', DB); assert.ok(!(await storage.getDatabaseTables(U, DB)).some((t) => t.name === 'items'));

// --- limits
const many = Array.from({ length: 48 }, (_, i) => `CREATE TABLE t${i} (a INT)`).join(';'); await sql(many, DB); // 2 + 48 = 50 tables
assert.equal((await fail('CREATE TABLE one_too_many (a INT)', DB)).code, 'TABLE_LIMIT_REACHED');

// --- permissions used by API keys
for (const [q, want] of [['SELECT 1', 'read'], ['SHOW DATABASES', 'read'], ['SHOW TABLES', 'read'], ['WITH x AS (SELECT 1) SELECT * FROM x', 'read'], ['DROP DATABASE shop', 'write'], ['CREATE DATABASE z', 'write'], ['SELECT 1; DROP TABLE a', 'write'], ['INSERT INTO a VALUES (1)', 'write'], ['SELEC', 'read']]) assert.equal(classifySQLPermission(q), want, q);

// --- drop database via SQL
assert.match((await sql('DROP DATABASE shop')).message, /deleted/); assert.equal((await sql('SHOW DATABASES')).rows.length, 0);

// --- files
const files = createFileService({ storage, env: { FILE_QUOTA_BYTES: 5000 } });
const bin = Buffer.from([0x25, 0x50, 0x44, 0x46, 0, 255, 254, 128]);
let up = await files.put(U, 'a.pdf', bin, 'application/pdf'); assert.equal(up.usage.used, 8);
assert.deepEqual((await files.get(U, 'a.pdf')).bytes, bin);
assert.equal((await files.list(U)).files.length, 1);
await files.put(U, 'a.pdf', Buffer.from('replaced'), 'text/plain'); assert.equal((await files.usage(U)).used, 8);
await assert.rejects(files.put(U, '../x', bin), (x) => x.code === 'INVALID_FILE_NAME');
await assert.rejects(files.put(U, 'big.bin', Buffer.alloc(6000)), (x) => x.code === 'STORAGE_QUOTA_EXCEEDED');
await assert.rejects(files.put(U, 'huge.bin', Buffer.alloc(8 * 1024 * 1024)), (x) => x.code === 'FILE_TOO_LARGE');
await assert.rejects(files.get(U, 'nope'), (x) => x.code === 'FILE_NOT_FOUND');
await files.remove(U, 'a.pdf'); assert.equal((await files.usage(U)).used, 0);
// other users cannot see these files
assert.equal((await createFileService({ storage, env: {} }).list('someone_else')).files.length, 0);
fs.rmSync(dir, { recursive: true, force: true });
console.log('merge tests passed');
