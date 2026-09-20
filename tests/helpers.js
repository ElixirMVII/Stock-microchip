import { openDatabase } from '../server/db.js';
import { createApp } from '../server/app.js';
import { ensureSeed } from '../server/seed.js';

/** ฐานข้อมูลในหน่วยความจำพร้อมข้อมูลพื้นฐานสำหรับการทดสอบ */
export function testDb() {
  const db = openDatabase(':memory:');
  ensureSeed(db);
  db.exec(`
    INSERT INTO departments (code, name) VALUES ('MFG', 'MFG Eng.'), ('QA', 'QA');
    INSERT INTO employees (emp_code, name, department_id) VALUES ('897500', 'Tanakit W.', 1), ('893203', 'Somchai P.', 2);
    INSERT INTO is_staff (name) VALUES ('Suwan'), ('Kittisak');
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
export async function startServer(db = testDb()) {
  const app = createApp(db);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';

  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
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

  const raw = async (path) => {
    const res = await fetch(base + path, { headers: cookie ? { Cookie: cookie } : {} });
    // อ่านเป็น bytes เพราะ res.text() ของ fetch จะตัด BOM ทิ้งตามมาตรฐาน
    const bytes = Buffer.from(await res.arrayBuffer());
    return {
      status: res.status,
      type: res.headers.get('content-type'),
      bytes,
      text: bytes.toString('utf8'),
    };
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
    close: () => new Promise((r) => server.close(() => { db.close(); r(); })),
  };
}
