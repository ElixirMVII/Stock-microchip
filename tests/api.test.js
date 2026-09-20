import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword } from '../server/lib/auth.js';
import { ITEM, EMP, startServer, testDb } from './helpers.js';

/* ---------------- การยืนยันตัวตนและสิทธิ์ ---------------- */

test('API ต้องเข้าสู่ระบบก่อนจึงเรียกได้', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  assert.equal((await s.get('/api/items')).status, 401);
  assert.equal((await s.get('/api/stock/balance')).status, 401);
  assert.equal((await s.get('/api/health')).status, 200, 'health เปิดให้ตรวจสอบได้เสมอ');
});

test('เข้าสู่ระบบสำเร็จและอ่านข้อมูลตัวเองได้', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  const login = await s.login();
  assert.equal(login.status, 200);
  assert.equal(login.body.user.role, 'admin');
  const me = await s.get('/api/auth/me');
  assert.equal(me.body.user.username, 'admin');
});

test('รหัสผ่านผิดต้องได้ 401 และไม่หลุดข้อมูลผู้ใช้', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  const res = await s.login('admin', 'ผิดแน่นอน');
  assert.equal(res.status, 401);
  assert.match(res.body.error, /ไม่ถูกต้อง/);
});

test('สิทธิ์ viewer ดูได้อย่างเดียว บันทึกเอกสารไม่ได้', async (t) => {
  const db = testDb();
  db.prepare("INSERT INTO users (username, password_hash, full_name, role) VALUES ('view1', ?, 'ผู้ดู', 'viewer')")
    .run(hashPassword('viewer1234'));
  const s = await startServer(db);
  t.after(() => s.close());

  await s.login('view1', 'viewer1234');
  assert.equal((await s.get('/api/stock/balance')).status, 200, 'viewer ต้องดูได้');
  const create = await s.post('/api/receipts', { receive_date: '2026-08-01', lines: [{ item_id: ITEM.mouse, qty: 1 }] });
  assert.equal(create.status, 403);
  assert.equal((await s.get('/api/users')).status, 403, 'viewer เข้าหน้าผู้ใช้ไม่ได้');
});

test('สิทธิ์ officer บันทึกเอกสารได้ แต่จัดการผู้ใช้ไม่ได้', async (t) => {
  const db = testDb();
  db.prepare("INSERT INTO users (username, password_hash, full_name, role) VALUES ('off1', ?, 'เจ้าหน้าที่', 'officer')")
    .run(hashPassword('officer1234'));
  const s = await startServer(db);
  t.after(() => s.close());

  await s.login('off1', 'officer1234');
  const create = await s.post('/api/receipts', { receive_date: '2026-08-01', lines: [{ item_id: ITEM.mouse, qty: 4 }] });
  assert.equal(create.status, 201);
  assert.equal((await s.get('/api/users')).status, 403);
  assert.equal((await s.del('/api/items/1')).status, 403, 'ลบข้อมูลหลักต้องเป็น admin');
});

/* ---------------- ข้อมูลหลัก ---------------- */

test('เพิ่ม/แก้ไข/ลบอุปกรณ์ผ่าน API ได้ครบวงจร', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  await s.login();

  const created = await s.post('/api/items', { sku: 'NEW-1', name: 'อุปกรณ์ใหม่', category_id: 4, min_qty: 3, unit_cost: 120 });
  assert.equal(created.status, 201);
  assert.equal(created.body.sku, 'NEW-1');
  assert.equal(created.body.balance, 0);

  const updated = await s.put(`/api/items/${created.body.id}`, { min_qty: 9 });
  assert.equal(updated.body.min_qty, 9);
  assert.equal(updated.body.name, 'อุปกรณ์ใหม่', 'ฟิลด์ที่ไม่ได้ส่งต้องไม่ถูกล้าง');

  assert.equal((await s.del(`/api/items/${created.body.id}`)).status, 200);
  assert.equal((await s.get(`/api/items/${created.body.id}`)).status, 404);
});

test('รหัสอุปกรณ์ซ้ำต้องได้ 409 พร้อมข้อความภาษาไทย', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  await s.login();
  const res = await s.post('/api/items', { sku: 'MOUSE', name: 'ซ้ำ', category_id: 4 });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /ซ้ำ/);
});

test('ลบข้อมูลหลักที่ถูกอ้างอิงอยู่ต้องได้ 409 พร้อมคำแนะนำ', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  await s.login();
  const res = await s.del('/api/categories/4');
  assert.equal(res.status, 409);
  assert.match(res.body.error, /ปิดใช้งาน/);
});

test('ค้นหาและแบ่งหน้าข้อมูลหลักได้', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  await s.login();
  const found = await s.get('/api/items?q=Mouse');
  assert.equal(found.body.total, 1);
  assert.equal(found.body.data[0].sku, 'MOUSE');
  const paged = await s.get('/api/items?per_page=2&page=1');
  assert.equal(paged.body.data.length, 2);
  assert.equal(paged.body.total, 3);
});

/* ---------------- เอกสารรับเข้า / เบิกออก ---------------- */

test('บันทึกใบรับเข้าแล้วยอดคงเหลือเปลี่ยนตาม', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  await s.login();

  const res = await s.post('/api/receipts', {
    receive_date: '2026-08-11', po_no: '22001999',
    lines: [{ item_id: ITEM.mouse, qty: 17, unit_cost: 350 }],
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.doc_no, 'IN-2026-0001');

  const detail = await s.get(`/api/receipts/${res.body.id}`);
  assert.equal(detail.body.po_no, '22001999');
  assert.equal(detail.body.lines[0].qty, 17);

  const bal = await s.get('/api/stock/balance?q=MOUSE');
  assert.equal(bal.body.data[0].balance, 17);
});

test('บันทึกใบเบิกพร้อม serial และดูรายละเอียดได้', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  await s.login();

  await s.post('/api/receipts', { receive_date: '2026-08-01', lines: [{ item_id: ITEM.monitor, qty: 2, serials: ['ST:3X76N3', 'ST:2KP76N3'] }] });
  const issue = await s.post('/api/issues', {
    issue_date: '2026-08-05', employee_id: EMP.tanakit, is_staff_id: 1, charge: true,
    lines: [{ item_id: ITEM.monitor, qty: 1, serials: ['ST:3X76N3'] }],
  });
  assert.equal(issue.status, 201);

  const detail = await s.get(`/api/issues/${issue.body.id}`);
  assert.equal(detail.body.employee_name, 'Tanakit W.');
  assert.equal(detail.body.department_name, 'MFG Eng.');
  assert.equal(detail.body.is_staff_name, 'Suwan');
  assert.equal(detail.body.charge, 1);
  assert.equal(detail.body.lines[0].serial_list, 'ST:3X76N3');
});

test('เบิกเกินสต็อกผ่าน API ต้องได้ 409 และไม่บันทึกเอกสาร', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  await s.login();
  await s.post('/api/receipts', { receive_date: '2026-08-01', lines: [{ item_id: ITEM.mouse, qty: 2 }] });

  const res = await s.post('/api/issues', {
    issue_date: '2026-08-02', employee_id: EMP.tanakit, charge: true,
    lines: [{ item_id: ITEM.mouse, qty: 5 }],
  });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /สต็อกไม่พอ/);
  assert.equal((await s.get('/api/issues')).body.total, 0, 'ต้องไม่มีเอกสารค้างในระบบ');
  assert.equal((await s.get('/api/stock/balance?q=MOUSE')).body.data[0].balance, 2);
});

test('ยกเลิกเอกสารผ่าน API คืนยอดและเปลี่ยนสถานะ', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  await s.login();

  const r = await s.post('/api/receipts', { receive_date: '2026-08-01', lines: [{ item_id: ITEM.mouse, qty: 10 }] });
  const voided = await s.post(`/api/receipts/${r.body.id}/void`, { reason: 'คีย์ผิด' });
  assert.equal(voided.status, 200);
  assert.equal(voided.body.status, 'void');

  const detail = await s.get(`/api/receipts/${r.body.id}`);
  assert.equal(detail.body.status, 'void');
  assert.equal(detail.body.void_reason, 'คีย์ผิด');
  assert.equal((await s.get('/api/stock/balance?q=MOUSE')).body.data[0].balance, 0);
});

test('ข้อมูลไม่ครบหรือรูปแบบผิดต้องได้ 400 พร้อมข้อความภาษาไทย', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  await s.login();

  const cases = [
    [{ receive_date: '2026-13-01', lines: [{ item_id: 1, qty: 1 }] }, /วันที่รับเข้า/],
    [{ receive_date: '2026-08-01', lines: [] }, /อย่างน้อย 1 รายการ/],
    [{ receive_date: '2026-08-01', lines: [{ item_id: 1, qty: 0 }] }, /ไม่น้อยกว่า 1/],
    [{ receive_date: '2026-08-01', lines: [{ item_id: 999, qty: 1 }] }, /ไม่พบอุปกรณ์/],
  ];
  for (const [body, re] of cases) {
    const res = await s.post('/api/receipts', body);
    assert.ok(res.status === 400 || res.status === 404, `คาดหวัง 4xx ได้ ${res.status}`);
    assert.match(res.body.error, re);
  }
});

/* ---------------- คลังและรายงาน ---------------- */

test('รายงานรายเดือนจัดกลุ่มคอลัมน์ตามหมวดหมู่เหมือนไฟล์เดิม', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  await s.login();

  await s.post('/api/receipts', { receive_date: '2026-08-01', lines: [
    { item_id: ITEM.monitor, qty: 1, serials: ['ST:3X76N3'] },
    { item_id: ITEM.laptop, qty: 1, serials: ['ST:6B5R034'] },
  ] });
  await s.post('/api/issues', {
    issue_date: '2026-08-08', employee_id: EMP.tanakit, is_staff_id: 2, charge: false,
    remark: 'Use old laptop B78470',
    lines: [
      { item_id: ITEM.laptop, qty: 1, serials: ['ST:6B5R034'] },
      { item_id: ITEM.monitor, qty: 1, serials: ['ST:3X76N3'] },
    ],
  });

  const rep = await s.get('/api/reports/monthly?year=2026&month=8');
  assert.equal(rep.body.outbound.length, 1);
  const row = rep.body.outbound[0];
  assert.equal(row.name_dept, '897500 - Tanakit W. / MFG Eng.');
  assert.equal(row.charge_label, 'N');
  assert.equal(row.is_staff_name, 'Kittisak');
  assert.deepEqual(row.laptop, ['Dell Latitude 5440 - ST:6B5R034']);
  assert.deepEqual(row.accessories, ['Dell 17 monitor - ST:3X76N3']);
  assert.equal(rep.body.summary.not_charged, 1);
});

test('รายงานอุปกรณ์ใกล้หมดและทรัพย์สินที่พนักงานถือครอง', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  await s.login();

  await s.post('/api/receipts', { receive_date: '2026-08-01', lines: [
    { item_id: ITEM.mouse, qty: 4 },
    { item_id: ITEM.laptop, qty: 1, serials: ['LT-9'] },
  ] });
  const low = await s.get('/api/stock/low');
  assert.ok(low.body.data.some((r) => r.sku === 'MOUSE'), 'เมาส์ 4 ชิ้น ต่ำกว่าขั้นต่ำ 5');

  await s.post('/api/issues', {
    issue_date: '2026-08-05', employee_id: EMP.somchai, charge: true,
    lines: [{ item_id: ITEM.laptop, qty: 1, serials: ['LT-9'] }],
  });
  const held = await s.get('/api/reports/assets-by-holder');
  assert.equal(held.body.data.length, 1);
  assert.equal(held.body.data[0].employee_name, 'Somchai P.');
  assert.equal(held.body.data[0].asset_count, 1);
});

test('ไทม์ไลน์ของ serial บันทึกครบทุกขั้นตอน', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  await s.login();

  await s.post('/api/receipts', { receive_date: '2026-08-01', lines: [{ item_id: ITEM.laptop, qty: 1, serials: ['TL-1'] }] });
  await s.post('/api/issues', { issue_date: '2026-08-05', employee_id: EMP.tanakit, charge: true, lines: [{ item_id: ITEM.laptop, qty: 1, serials: ['TL-1'] }] });
  await s.post('/api/returns', { return_date: '2026-09-01', employee_id: EMP.tanakit, lines: [{ item_id: ITEM.laptop, qty: 1, condition: 'good', serials: ['TL-1'] }] });

  const found = await s.get('/api/serials?q=TL-1');
  const detail = await s.get(`/api/serials/${found.body.data[0].id}`);
  assert.deepEqual(detail.body.timeline.map((e) => e.event), ['receive', 'issue', 'return']);
  assert.equal(detail.body.status, 'in_stock');
});

test('การ์ดสต็อกแสดงยอดสะสมถูกต้อง', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  await s.login();
  await s.post('/api/receipts', { receive_date: '2026-08-01', lines: [{ item_id: ITEM.mouse, qty: 10 }] });
  await s.post('/api/issues', { issue_date: '2026-08-02', employee_id: EMP.tanakit, charge: true, lines: [{ item_id: ITEM.mouse, qty: 3 }] });

  const card = await s.get(`/api/stock/card/${ITEM.mouse}`);
  const running = card.body.data.map((r) => r.running_balance);
  assert.deepEqual(running, [7, 10], 'เรียงจากใหม่ไปเก่า');
  assert.equal(card.body.item.balance, 7);
});

test('ส่งออก CSV ได้พร้อม BOM สำหรับ Excel ภาษาไทย', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  await s.login();
  await s.post('/api/receipts', { receive_date: '2026-08-01', lines: [{ item_id: ITEM.mouse, qty: 6 }] });

  const csv = await s.raw('/api/stock/balance.csv');
  assert.equal(csv.status, 200);
  assert.match(csv.type, /text\/csv/);
  assert.deepEqual([...csv.bytes.subarray(0, 3)], [0xEF, 0xBB, 0xBF], 'ต้องมี BOM ให้ Excel อ่านภาษาไทยได้');
  assert.match(csv.text, /รหัสอุปกรณ์/);
  assert.match(csv.text, /MOUSE/);

  const moves = await s.raw('/api/stock/moves.csv');
  assert.equal(moves.status, 200);
  assert.match(moves.text, /IN-2026-0001/);
});

test('แดชบอร์ดรวมยอดได้ถูกต้อง', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  await s.login();
  await s.post('/api/receipts', { receive_date: '2026-08-01', lines: [{ item_id: ITEM.mouse, qty: 10, unit_cost: 350 }] });

  const d = await s.get('/api/dashboard');
  assert.equal(d.body.totals.item_count, 3);
  assert.equal(d.body.totals.total_qty, 10);
  assert.equal(d.body.totals.total_value, 3500);
  assert.ok(d.body.recentMoves.length >= 1);
});

/* ---------------- ผู้ใช้งาน ---------------- */

test('admin จัดการผู้ใช้ได้ และห้ามเหลือ admin ศูนย์คน', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  await s.login();

  const created = await s.post('/api/users', { username: 'somchai', password: 'password123', full_name: 'สมชาย', role: 'officer' });
  assert.equal(created.status, 201);
  assert.equal(created.body.role, 'officer');
  assert.ok(!('password_hash' in created.body), 'ต้องไม่ส่ง hash รหัสผ่านกลับไป');

  const demote = await s.put('/api/users/1', { role: 'viewer' });
  assert.equal(demote.status, 409, 'ลดสิทธิ์ admin คนสุดท้ายไม่ได้');
  assert.equal((await s.del('/api/users/1')).status, 409, 'ลบตัวเองไม่ได้');
});

test('เปลี่ยนรหัสผ่านแล้วต้องใช้รหัสใหม่เข้าสู่ระบบ', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  await s.login();

  assert.equal((await s.post('/api/auth/change-password', { current_password: 'ผิด', new_password: 'newpass123' })).status, 400);
  assert.equal((await s.post('/api/auth/change-password', { current_password: 'admin1234', new_password: 'สั้น' })).status, 400);
  assert.equal((await s.post('/api/auth/change-password', { current_password: 'admin1234', new_password: 'newpass123' })).status, 200);

  await s.logout();
  assert.equal((await s.login('admin', 'admin1234')).status, 401);
  assert.equal((await s.login('admin', 'newpass123')).status, 200);
});
