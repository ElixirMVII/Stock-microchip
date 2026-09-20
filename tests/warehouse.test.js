import test from 'node:test';
import assert from 'node:assert/strict';
import {
  balanceOf, postAdjustment, postIssue, postReceipt, postReturn, postTransfer, voidDocument,
} from '../server/services/stock.js';
import { ITEM, EMP, WH, startServer, testDb } from './helpers.js';

const run = (db, fn) => db.transaction(fn)();

/* ---------------- ยอดแยกรายคลัง / รวมทุกคลัง ---------------- */

test('ระบบสร้างคลัง MMT และ MTHAI ให้อัตโนมัติ', () => {
  const db = testDb();
  const rows = db.prepare('SELECT code FROM warehouses ORDER BY sort_order, id').all();
  assert.deepEqual(rows.map((r) => r.code), ['MMT', 'MTHAI']);
});

test('ยอดคงเหลือแยกรายคลังและยอดรวมถูกต้อง', () => {
  const db = testDb();
  run(db, () => postReceipt(db, { warehouse_id: WH.mmt, receive_date: '2026-09-01', lines: [{ item_id: ITEM.mouse, qty: 30 }] }));
  run(db, () => postReceipt(db, { warehouse_id: WH.mthai, receive_date: '2026-09-01', lines: [{ item_id: ITEM.mouse, qty: 12 }] }));

  assert.equal(balanceOf(db, ITEM.mouse, WH.mmt), 30);
  assert.equal(balanceOf(db, ITEM.mouse, WH.mthai), 12);
  assert.equal(balanceOf(db, ITEM.mouse), 42, 'ไม่ระบุคลัง = ยอดรวมทุกคลัง');

  const wh = db.prepare('SELECT warehouse_code, balance FROM v_stock_balance_wh WHERE item_id = ? ORDER BY warehouse_id').all(ITEM.mouse);
  assert.deepEqual(wh.map((r) => [r.warehouse_code, r.balance]), [['MMT', 30], ['MTHAI', 12]]);
  assert.equal(db.prepare('SELECT balance FROM v_stock_balance WHERE item_id = ?').get(ITEM.mouse).balance, 42);
});

test('เบิกจากคลังหนึ่งไม่กระทบอีกคลัง', () => {
  const db = testDb();
  run(db, () => postReceipt(db, { warehouse_id: WH.mmt, receive_date: '2026-09-01', lines: [{ item_id: ITEM.mouse, qty: 20 }] }));
  run(db, () => postReceipt(db, { warehouse_id: WH.mthai, receive_date: '2026-09-01', lines: [{ item_id: ITEM.mouse, qty: 8 }] }));
  run(db, () => postIssue(db, { warehouse_id: WH.mthai, issue_date: '2026-09-02', employee_id: EMP.tanakit, charge: true, lines: [{ item_id: ITEM.mouse, qty: 5 }] }));

  assert.equal(balanceOf(db, ITEM.mouse, WH.mmt), 20, 'คลังที่ไม่เกี่ยวข้องต้องไม่เปลี่ยน');
  assert.equal(balanceOf(db, ITEM.mouse, WH.mthai), 3);
  assert.equal(balanceOf(db, ITEM.mouse), 23);
});

test('เบิกเกินยอดของคลังนั้นไม่ได้ แม้ยอดรวมทุกคลังจะพอ', () => {
  const db = testDb();
  run(db, () => postReceipt(db, { warehouse_id: WH.mmt, receive_date: '2026-09-01', lines: [{ item_id: ITEM.mouse, qty: 50 }] }));
  run(db, () => postReceipt(db, { warehouse_id: WH.mthai, receive_date: '2026-09-01', lines: [{ item_id: ITEM.mouse, qty: 3 }] }));

  assert.throws(
    () => run(db, () => postIssue(db, { warehouse_id: WH.mthai, issue_date: '2026-09-02', employee_id: EMP.tanakit, charge: true, lines: [{ item_id: ITEM.mouse, qty: 10 }] })),
    /คลัง MTHAI/,
  );
  assert.equal(balanceOf(db, ITEM.mouse, WH.mthai), 3, 'ต้อง rollback');
});

test('ปรับปรุงสต็อกมีผลเฉพาะคลังที่ระบุ', () => {
  const db = testDb();
  run(db, () => postReceipt(db, { warehouse_id: WH.mmt, receive_date: '2026-09-01', lines: [{ item_id: ITEM.mouse, qty: 10 }] }));
  run(db, () => postReceipt(db, { warehouse_id: WH.mthai, receive_date: '2026-09-01', lines: [{ item_id: ITEM.mouse, qty: 10 }] }));
  run(db, () => postAdjustment(db, { warehouse_id: WH.mmt, adjust_date: '2026-09-05', lines: [{ item_id: ITEM.mouse, qty_diff: -4 }] }));

  assert.equal(balanceOf(db, ITEM.mouse, WH.mmt), 6);
  assert.equal(balanceOf(db, ITEM.mouse, WH.mthai), 10);
});

/* ---------------- Serial ผูกกับคลัง ---------------- */

test('serial อยู่ในคลังที่รับเข้า และเบิกข้ามคลังไม่ได้', () => {
  const db = testDb();
  run(db, () => postReceipt(db, { warehouse_id: WH.mmt, receive_date: '2026-09-01', lines: [{ item_id: ITEM.monitor, qty: 1, serials: ['A1'] }] }));
  run(db, () => postReceipt(db, { warehouse_id: WH.mthai, receive_date: '2026-09-01', lines: [{ item_id: ITEM.monitor, qty: 1, serials: ['B1'] }] }));

  assert.equal(db.prepare("SELECT warehouse_id FROM serials WHERE serial_no='A1'").get().warehouse_id, WH.mmt);
  assert.throws(
    () => run(db, () => postIssue(db, { warehouse_id: WH.mthai, issue_date: '2026-09-02', employee_id: EMP.tanakit, charge: true, lines: [{ item_id: ITEM.monitor, qty: 1, serials: ['A1'] }] })),
    /อยู่ที่คลัง MMT/,
  );
});

/* ---------------- การโอนย้ายระหว่างคลัง ---------------- */

test('โอนย้ายลดคลังต้นทาง เพิ่มคลังปลายทาง และยอดรวมไม่เปลี่ยน', () => {
  const db = testDb();
  run(db, () => postReceipt(db, { warehouse_id: WH.mmt, receive_date: '2026-09-01', lines: [{ item_id: ITEM.mouse, qty: 20 }] }));
  const before = balanceOf(db, ITEM.mouse);

  const tr = run(db, () => postTransfer(db, {
    transfer_date: '2026-09-05', from_warehouse_id: WH.mmt, to_warehouse_id: WH.mthai,
    lines: [{ item_id: ITEM.mouse, qty: 7 }],
  }));
  assert.match(tr.doc_no, /^TR-2026-0001$/);
  assert.equal(balanceOf(db, ITEM.mouse, WH.mmt), 13);
  assert.equal(balanceOf(db, ITEM.mouse, WH.mthai), 7);
  assert.equal(balanceOf(db, ITEM.mouse), before, 'ยอดรวมทุกคลังต้องเท่าเดิม');
});

test('โอนย้าย serial ทำให้ serial เปลี่ยนคลัง และเบิกจากคลังใหม่ได้', () => {
  const db = testDb();
  run(db, () => postReceipt(db, { warehouse_id: WH.mmt, receive_date: '2026-09-01', lines: [{ item_id: ITEM.laptop, qty: 1, serials: ['LT-9'] }] }));
  run(db, () => postTransfer(db, {
    transfer_date: '2026-09-05', from_warehouse_id: WH.mmt, to_warehouse_id: WH.mthai,
    lines: [{ item_id: ITEM.laptop, qty: 1, serials: ['LT-9'] }],
  }));
  assert.equal(db.prepare("SELECT warehouse_id FROM serials WHERE serial_no='LT-9'").get().warehouse_id, WH.mthai);
  assert.equal(balanceOf(db, ITEM.laptop, WH.mmt), 0);
  assert.equal(balanceOf(db, ITEM.laptop, WH.mthai), 1);

  // เบิกจากคลังปลายทางได้แล้ว
  run(db, () => postIssue(db, { warehouse_id: WH.mthai, issue_date: '2026-09-06', employee_id: EMP.tanakit, charge: true, lines: [{ item_id: ITEM.laptop, qty: 1, serials: ['LT-9'] }] }));
  assert.equal(db.prepare("SELECT status FROM serials WHERE serial_no='LT-9'").get().status, 'issued');
});

test('โอนเกินยอดคลังต้นทาง และโอนเข้าคลังเดียวกันต้องถูกปฏิเสธ', () => {
  const db = testDb();
  run(db, () => postReceipt(db, { warehouse_id: WH.mmt, receive_date: '2026-09-01', lines: [{ item_id: ITEM.mouse, qty: 5 }] }));

  assert.throws(() => run(db, () => postTransfer(db, {
    transfer_date: '2026-09-05', from_warehouse_id: WH.mmt, to_warehouse_id: WH.mthai,
    lines: [{ item_id: ITEM.mouse, qty: 99 }],
  })), /สต็อกไม่พอ/);

  assert.throws(() => run(db, () => postTransfer(db, {
    transfer_date: '2026-09-05', from_warehouse_id: WH.mmt, to_warehouse_id: WH.mmt,
    lines: [{ item_id: ITEM.mouse, qty: 1 }],
  })), /คลังเดียวกัน/);

  assert.equal(balanceOf(db, ITEM.mouse, WH.mmt), 5);
});

test('ยกเลิกใบโอนย้ายคืนยอดให้ทั้งสองคลัง และย้อนคลังของ serial', () => {
  const db = testDb();
  run(db, () => postReceipt(db, { warehouse_id: WH.mmt, receive_date: '2026-09-01', lines: [
    { item_id: ITEM.mouse, qty: 10 },
    { item_id: ITEM.laptop, qty: 1, serials: ['LT-V'] },
  ] }));
  const tr = run(db, () => postTransfer(db, {
    transfer_date: '2026-09-05', from_warehouse_id: WH.mmt, to_warehouse_id: WH.mthai,
    lines: [{ item_id: ITEM.mouse, qty: 4 }, { item_id: ITEM.laptop, qty: 1, serials: ['LT-V'] }],
  }));
  assert.equal(balanceOf(db, ITEM.mouse, WH.mthai), 4);

  run(db, () => voidDocument(db, 'transfer', tr.id, 'คีย์ผิด'));
  assert.equal(balanceOf(db, ITEM.mouse, WH.mmt), 10);
  assert.equal(balanceOf(db, ITEM.mouse, WH.mthai), 0);
  assert.equal(db.prepare("SELECT warehouse_id FROM serials WHERE serial_no='LT-V'").get().warehouse_id, WH.mmt);
  assert.equal(db.prepare('SELECT status FROM transfers WHERE id = ?').get(tr.id).status, 'void');
});

test('คืนของเข้าคลังอื่นได้ และของย้ายไปอยู่คลังที่รับคืน', () => {
  const db = testDb();
  run(db, () => postReceipt(db, { warehouse_id: WH.mmt, receive_date: '2026-09-01', lines: [{ item_id: ITEM.laptop, qty: 1, serials: ['LT-R'] }] }));
  run(db, () => postIssue(db, { warehouse_id: WH.mmt, issue_date: '2026-09-02', employee_id: EMP.tanakit, charge: true, lines: [{ item_id: ITEM.laptop, qty: 1, serials: ['LT-R'] }] }));
  run(db, () => postReturn(db, { warehouse_id: WH.mthai, return_date: '2026-09-10', employee_id: EMP.tanakit, lines: [{ item_id: ITEM.laptop, qty: 1, condition: 'good', serials: ['LT-R'] }] }));

  assert.equal(db.prepare("SELECT warehouse_id FROM serials WHERE serial_no='LT-R'").get().warehouse_id, WH.mthai);
  assert.equal(balanceOf(db, ITEM.laptop, WH.mmt), 0);
  assert.equal(balanceOf(db, ITEM.laptop, WH.mthai), 1);
});

test('ยอดรายคลังของอุปกรณ์ที่ติดตาม serial เท่ากับจำนวน serial ในคลังนั้นเสมอ', () => {
  const db = testDb();
  run(db, () => postReceipt(db, { warehouse_id: WH.mmt, receive_date: '2026-09-01', lines: [{ item_id: ITEM.monitor, qty: 3, serials: ['S1', 'S2', 'S3'] }] }));
  run(db, () => postTransfer(db, { transfer_date: '2026-09-02', from_warehouse_id: WH.mmt, to_warehouse_id: WH.mthai, lines: [{ item_id: ITEM.monitor, qty: 2, serials: ['S1', 'S2'] }] }));
  run(db, () => postIssue(db, { warehouse_id: WH.mthai, issue_date: '2026-09-03', employee_id: EMP.tanakit, charge: true, lines: [{ item_id: ITEM.monitor, qty: 1, serials: ['S1'] }] }));

  for (const whId of [WH.mmt, WH.mthai]) {
    const inStock = db.prepare(
      "SELECT COUNT(*) AS n FROM serials WHERE item_id = ? AND warehouse_id = ? AND status = 'in_stock'",
    ).get(ITEM.monitor, whId).n;
    assert.equal(balanceOf(db, ITEM.monitor, whId), inStock, `คลัง #${whId} ยอดต้องตรงกับจำนวน serial`);
  }
});

/* ---------------- API ---------------- */

test('API: ดูยอดแยกรายคลังและยอดรวมผ่าน /stock/by-warehouse', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  await s.login();

  await s.post('/api/receipts', { warehouse_id: WH.mmt, receive_date: '2026-09-01', lines: [{ item_id: ITEM.mouse, qty: 30 }] });
  await s.post('/api/receipts', { warehouse_id: WH.mthai, receive_date: '2026-09-01', lines: [{ item_id: ITEM.mouse, qty: 12 }] });

  const res = await s.get('/api/stock/by-warehouse');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.warehouses.map((w) => w.code), ['MMT', 'MTHAI']);

  const row = res.body.data.find((r) => r.sku === 'MOUSE');
  assert.equal(row.by_warehouse[WH.mmt], 30);
  assert.equal(row.by_warehouse[WH.mthai], 12);
  assert.equal(row.total, 42);
  assert.equal(res.body.summary.total_qty, 42);
  assert.equal(res.body.summary.by_warehouse[WH.mmt].qty, 30);
});

test('API: /stock/balance กรองรายคลังได้ และไม่กรอง = รวมทุกคลัง', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  await s.login();
  await s.post('/api/receipts', { warehouse_id: WH.mmt, receive_date: '2026-09-01', lines: [{ item_id: ITEM.mouse, qty: 30 }] });
  await s.post('/api/receipts', { warehouse_id: WH.mthai, receive_date: '2026-09-01', lines: [{ item_id: ITEM.mouse, qty: 12 }] });

  assert.equal((await s.get('/api/stock/balance')).body.summary.total_qty, 42);
  assert.equal((await s.get(`/api/stock/balance?warehouse_id=${WH.mmt}`)).body.summary.total_qty, 30);
  assert.equal((await s.get(`/api/stock/balance?warehouse_id=${WH.mthai}`)).body.summary.total_qty, 12);
});

test('API: สร้างและยกเลิกใบโอนย้ายผ่าน HTTP', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  await s.login();
  await s.post('/api/receipts', { warehouse_id: WH.mmt, receive_date: '2026-09-01', lines: [{ item_id: ITEM.mouse, qty: 20 }] });

  const tr = await s.post('/api/transfers', {
    transfer_date: '2026-09-05', from_warehouse_id: WH.mmt, to_warehouse_id: WH.mthai,
    note: 'เกลี่ยสต็อก', lines: [{ item_id: ITEM.mouse, qty: 6 }],
  });
  assert.equal(tr.status, 201);

  const detail = await s.get(`/api/transfers/${tr.body.id}`);
  assert.equal(detail.body.from_code, 'MMT');
  assert.equal(detail.body.to_code, 'MTHAI');
  assert.equal(detail.body.lines[0].qty, 6);

  assert.equal((await s.get(`/api/stock/balance?warehouse_id=${WH.mthai}`)).body.summary.total_qty, 6);

  const voided = await s.post(`/api/transfers/${tr.body.id}/void`, { reason: 'ทดสอบ' });
  assert.equal(voided.status, 200);
  assert.equal((await s.get(`/api/stock/balance?warehouse_id=${WH.mthai}`)).body.summary.total_qty, 0);
  assert.equal((await s.get(`/api/stock/balance?warehouse_id=${WH.mmt}`)).body.summary.total_qty, 20);
});

test('API: เอกสารต้องระบุคลัง มิฉะนั้นได้ 400', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  await s.login();
  const res = await s.post('/api/receipts', { receive_date: '2026-09-01', lines: [{ item_id: ITEM.mouse, qty: 1 }] });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /คลัง/);
});

test('API: รายการเอกสารกรองตามคลังได้', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  await s.login();
  await s.post('/api/receipts', { warehouse_id: WH.mmt, receive_date: '2026-09-01', lines: [{ item_id: ITEM.mouse, qty: 5 }] });
  await s.post('/api/receipts', { warehouse_id: WH.mthai, receive_date: '2026-09-02', lines: [{ item_id: ITEM.mouse, qty: 5 }] });

  assert.equal((await s.get('/api/receipts')).body.total, 2, 'ไม่กรอง = ทุกคลัง');
  const only = await s.get(`/api/receipts?warehouse_id=${WH.mthai}`);
  assert.equal(only.body.total, 1);
  assert.equal(only.body.data[0].warehouse_code, 'MTHAI');
});

test('API: แดชบอร์ดมีสรุปแยกรายคลังพร้อมยอดรวม', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  await s.login();
  await s.post('/api/receipts', { warehouse_id: WH.mmt, receive_date: '2026-09-01', lines: [{ item_id: ITEM.mouse, qty: 10, unit_cost: 350 }] });
  await s.post('/api/receipts', { warehouse_id: WH.mthai, receive_date: '2026-09-01', lines: [{ item_id: ITEM.mouse, qty: 4, unit_cost: 350 }] });

  const d = await s.get('/api/dashboard');
  assert.equal(d.body.totals.total_qty, 14);
  assert.deepEqual(d.body.warehouses.map((w) => [w.code, w.balance]), [['MMT', 10], ['MTHAI', 4]]);

  const only = await s.get(`/api/dashboard?warehouse_id=${WH.mmt}`);
  assert.equal(only.body.totals.total_qty, 10);
});

test('API: จัดการคลังเป็นข้อมูลหลักได้ และลบคลังที่ใช้งานอยู่ไม่ได้', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  await s.login();

  const created = await s.post('/api/warehouses', { code: 'WH3', name: 'คลังสำรอง', location: 'อาคาร C' });
  assert.equal(created.status, 201);
  assert.equal((await s.get('/api/warehouses')).body.total, 3);

  // คลังใหม่ยังไม่มีการใช้งาน จึงลบได้
  assert.equal((await s.del(`/api/warehouses/${created.body.id}`)).status, 200);

  // คลังที่มีเอกสารอ้างอิงแล้ว ลบไม่ได้
  await s.post('/api/receipts', { warehouse_id: WH.mmt, receive_date: '2026-09-01', lines: [{ item_id: ITEM.mouse, qty: 1 }] });
  const del = await s.del(`/api/warehouses/${WH.mmt}`);
  assert.equal(del.status, 409);
  assert.match(del.body.error, /ปิดใช้งาน/);
});
