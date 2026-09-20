import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDatabase, openDatabase } from '../server/db.js';
import { createApp } from '../server/app.js';
import { ensureSeed } from '../server/seed.js';
import { load, override } from '../server/config.js';

/* ============================================================
 *  ตัวช่วยสำหรับการทดสอบ
 *  แต่ละไฟล์ทดสอบใช้ฐานข้อมูลของตัวเอง (Stock-MC-test-<ชื่อไฟล์>)
 *  เพราะ node:test รันไฟล์ทดสอบพร้อมกันหลายไฟล์
 * ============================================================ */

/** ตั้งชื่อฐานข้อมูลทดสอบจากชื่อไฟล์ที่เรียก เพื่อไม่ให้ชนกัน */
export function testDbName(metaUrl) {
  const base = path.basename(fileURLToPath(metaUrl)).replace(/\.test\.js$/, '');
  return process.env.TEST_DB_PREFIX
    ? `${process.env.TEST_DB_PREFIX}-${base}`
    : `Stock-MC-test-${base}`;
}

const TABLES = [
  'stock_moves', 'serial_events', 'serials',
  'receipt_lines', 'receipts', 'issue_lines', 'issues',
  'return_lines', 'returns', 'adjustment_lines', 'adjustments',
  'transfer_lines', 'transfers', 'audit_logs',
  'items', 'employees', 'is_staff', 'suppliers', 'departments', 'categories',
  'warehouses', 'users',
];

/** ล้างข้อมูลทุกตารางให้กลับเป็นฐานว่าง */
export async function wipe(db) {
  await db.run('SET FOREIGN_KEY_CHECKS = 0');
  try {
    for (const t of TABLES) await db.run(`TRUNCATE TABLE ${t}`);
  } finally {
    await db.run('SET FOREIGN_KEY_CHECKS = 1');
  }
}

let shared = null;

/** เปิดฐานข้อมูลทดสอบของไฟล์นี้ (ใช้ pool เดียวกันทั้งไฟล์) */
export async function connect(metaUrl) {
  if (shared) return shared;
  const name = testDbName(metaUrl);
  override({ db: { ...load().db, name } });
  await ensureDatabase({ ...load().db, name });
  shared = await openDatabase({ ...load().db, name });
  return shared;
}

export async function disconnect() {
  if (shared) { await shared.close(); shared = null; }
}

/** ฐานข้อมูลสะอาดพร้อมข้อมูลพื้นฐานสำหรับการทดสอบหนึ่งเคส */
export async function testDb(metaUrl) {
  const db = await connect(metaUrl);
  await wipe(db);
  // migration สร้างคลังเริ่มต้น ส่วน ensureSeed สร้าง admin + หมวดหมู่
  const { runMigrations } = await import('../server/migrations.js');
  await runMigrations(db);
  await ensureSeed(db);
  await db.exec(`
    INSERT INTO departments (code, name) VALUES ('MFG', 'MFG Eng.'), ('QA', 'QA');
    INSERT INTO employees (emp_code, name, department_id) VALUES ('897500', 'Tanakit W.', 1), ('893203', 'Somchai P.', 2);
    INSERT INTO is_staff (name) VALUES ('Suwan'), ('Kittisak');
  `);
  // หมวดหมู่ที่ ensureSeed สร้างไว้: 1 DESKTOP, 2 LAPTOP, 3 MONITOR, 4 ACC, 5 NETWORK, 6 OTHER
  await db.exec(`
    INSERT INTO items (sku, name, category_id, unit, track_serial, min_qty, unit_cost)
      VALUES ('MOUSE', 'ESD Mouse', 4, 'EA', 0, 5, 350);
    INSERT INTO items (sku, name, category_id, unit, track_serial, min_qty, unit_cost)
      VALUES ('MON', 'Dell 17 monitor', 3, 'EA', 1, 2, 4500);
    INSERT INTO items (sku, name, category_id, unit, track_serial, min_qty, unit_cost)
      VALUES ('LT', 'Dell Latitude 5440', 2, 'EA', 1, 1, 38000);
  `);
  return db;
}

export const ITEM = { mouse: 1, monitor: 2, laptop: 3 };
export const EMP = { tanakit: 1, somchai: 2 };
/** คลังเริ่มต้นที่ระบบสร้างให้อัตโนมัติ */
export const WH = { mmt: 1, mthai: 2 };

/** เปิดเซิร์ฟเวอร์ทดสอบพร้อมตัวช่วยเรียก API ที่จำคุกกี้เซสชันให้ */
export async function startServer(db) {
  const app = createApp(db);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';

  const call = async (method, p, body) => {
    const res = await fetch(base + p, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json };
  };

  const raw = async (p) => {
    const res = await fetch(base + p, { headers: cookie ? { Cookie: cookie } : {} });
    // อ่านเป็น bytes เพราะ res.text() ของ fetch จะตัด BOM ทิ้งตามมาตรฐาน
    const bytes = Buffer.from(await res.arrayBuffer());
    return { status: res.status, type: res.headers.get('content-type'), bytes, text: bytes.toString('utf8') };
  };

  return {
    db,
    base,
    raw,
    get: (p) => call('GET', p),
    post: (p, b) => call('POST', p, b ?? {}),
    put: (p, b) => call('PUT', p, b ?? {}),
    del: (p) => call('DELETE', p),
    login: (username = 'admin', password = 'admin1234') => call('POST', '/api/auth/login', { username, password }),
    logout: () => { cookie = ''; return call('POST', '/api/auth/logout', {}); },
    // ปิดเฉพาะ HTTP server — pool ฐานข้อมูลใช้ร่วมกันทั้งไฟล์ทดสอบ
    close: () => new Promise((r) => server.close(() => r())),
  };
}
