import test from 'node:test';
import assert from 'node:assert/strict';
import { balanceOf, nextDocNo, postAdjustment, postIssue, postReceipt, postReturn, voidDocument } from '../server/services/stock.js';
import { ITEM, EMP, testDb } from './helpers.js';

const run = (db, fn) => db.transaction(fn)();

test('รับเข้าแบบไม่มี serial เพิ่มยอดคงเหลือถูกต้อง', () => {
  const db = testDb();
  const r = run(db, () => postReceipt(db, { receive_date: '2026-08-11', po_no: '22001999', lines: [{ item_id: ITEM.mouse, qty: 17 }] }));
  assert.equal(balanceOf(db, ITEM.mouse), 17);
  assert.equal(r.doc_no, 'IN-2026-0001');
});

test('รับเข้าแบบมี serial สร้าง serial และยอดตรงกัน', () => {
  const db = testDb();
  run(db, () => postReceipt(db, { receive_date: '2026-08-01', lines: [{ item_id: ITEM.monitor, qty: 3, serials: ['S1', 'S2', 'S3'] }] }));
  assert.equal(balanceOf(db, ITEM.monitor), 3);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM serials WHERE status='in_stock'").get().n, 3);
});

test('จำนวน serial ไม่ตรงกับ qty ต้องถูกปฏิเสธ', () => {
  const db = testDb();
  assert.throws(
    () => run(db, () => postReceipt(db, { receive_date: '2026-08-01', lines: [{ item_id: ITEM.monitor, qty: 3, serials: ['S1'] }] })),
    /ต้องระบุ Serial ให้ครบ/,
  );
  assert.equal(balanceOf(db, ITEM.monitor), 0, 'transaction ต้อง rollback ทั้งหมด');
});

test('serial ซ้ำในระบบต้องถูกปฏิเสธ', () => {
  const db = testDb();
  run(db, () => postReceipt(db, { receive_date: '2026-08-01', lines: [{ item_id: ITEM.monitor, qty: 1, serials: ['DUP'] }] }));
  assert.throws(
    () => run(db, () => postReceipt(db, { receive_date: '2026-08-02', lines: [{ item_id: ITEM.monitor, qty: 1, serials: ['dup'] }] })),
    /มีอยู่ในระบบแล้ว/,
  );
});

test('เบิกออกตัดยอดและเปลี่ยนสถานะ serial เป็น issued', () => {
  const db = testDb();
  run(db, () => postReceipt(db, { receive_date: '2026-08-01', lines: [{ item_id: ITEM.monitor, qty: 2, serials: ['A1', 'A2'] }] }));
  run(db, () => postIssue(db, { issue_date: '2026-08-05', employee_id: EMP.tanakit, is_staff_id: 1, charge: true, lines: [{ item_id: ITEM.monitor, qty: 1, serials: ['A1'] }] }));
  assert.equal(balanceOf(db, ITEM.monitor), 1);
  const s = db.prepare("SELECT * FROM serials WHERE serial_no='A1'").get();
  assert.equal(s.status, 'issued');
  assert.equal(s.holder_id, EMP.tanakit);
});

test('เบิกเกินยอดคงเหลือต้องถูกปฏิเสธ', () => {
  const db = testDb();
  run(db, () => postReceipt(db, { receive_date: '2026-08-01', lines: [{ item_id: ITEM.mouse, qty: 5 }] }));
  assert.throws(
    () => run(db, () => postIssue(db, { issue_date: '2026-08-02', employee_id: EMP.tanakit, charge: true, lines: [{ item_id: ITEM.mouse, qty: 6 }] })),
    /สต็อกไม่พอ/,
  );
  assert.equal(balanceOf(db, ITEM.mouse), 5);
});

test('เบิกหลายบรรทัดของอุปกรณ์เดียวกันต้องรวมจำนวนก่อนตรวจสต็อก', () => {
  const db = testDb();
  run(db, () => postReceipt(db, { receive_date: '2026-08-01', lines: [{ item_id: ITEM.mouse, qty: 5 }] }));
  assert.throws(
    () => run(db, () => postIssue(db, {
      issue_date: '2026-08-02', employee_id: EMP.tanakit, charge: true,
      lines: [{ item_id: ITEM.mouse, qty: 3 }, { item_id: ITEM.mouse, qty: 3 }],
    })),
    /สต็อกไม่พอ/,
  );
  assert.equal(balanceOf(db, ITEM.mouse), 5);
});

test('เบิก serial ที่ถูกเบิกไปแล้วซ้ำไม่ได้ แม้ยังมีของคงเหลือ', () => {
  const db = testDb();
  // รับเข้า 2 ชิ้น เบิกออก 1 ชิ้น -> ยังเหลือ 1 ชิ้น ทำให้การตรวจยอดผ่าน
  // แล้วจึงไปติดที่การตรวจสถานะของ serial โดยเฉพาะ
  run(db, () => postReceipt(db, { receive_date: '2026-08-01', lines: [{ item_id: ITEM.monitor, qty: 2, serials: ['B1', 'B2'] }] }));
  run(db, () => postIssue(db, { issue_date: '2026-08-02', employee_id: EMP.tanakit, charge: true, lines: [{ item_id: ITEM.monitor, qty: 1, serials: ['B1'] }] }));
  assert.equal(balanceOf(db, ITEM.monitor), 1);
  assert.throws(
    () => run(db, () => postIssue(db, { issue_date: '2026-08-03', employee_id: EMP.somchai, charge: true, lines: [{ item_id: ITEM.monitor, qty: 1, serials: ['B1'] }] })),
    /ถูกเบิกออกไปแล้ว/,
  );
  assert.equal(balanceOf(db, ITEM.monitor), 1, 'ต้อง rollback ไม่กระทบยอด');
});

test('เบิก serial ของอุปกรณ์อื่นไม่ได้', () => {
  const db = testDb();
  run(db, () => postReceipt(db, { receive_date: '2026-08-01', lines: [
    { item_id: ITEM.monitor, qty: 1, serials: ['MON-1'] },
    { item_id: ITEM.laptop, qty: 1, serials: ['LT-1'] },
  ] }));
  assert.throws(
    () => run(db, () => postIssue(db, { issue_date: '2026-08-02', employee_id: EMP.tanakit, charge: true, lines: [{ item_id: ITEM.monitor, qty: 1, serials: ['LT-1'] }] })),
    /ไม่ได้อยู่ในอุปกรณ์/,
  );
});

test('รับคืนสภาพดีเพิ่มยอดกลับ และชำรุดไม่เพิ่มยอด', () => {
  const db = testDb();
  run(db, () => postReceipt(db, { receive_date: '2026-08-01', lines: [{ item_id: ITEM.monitor, qty: 2, serials: ['C1', 'C2'] }] }));
  run(db, () => postIssue(db, { issue_date: '2026-08-02', employee_id: EMP.tanakit, charge: true, lines: [{ item_id: ITEM.monitor, qty: 2, serials: ['C1', 'C2'] }] }));
  assert.equal(balanceOf(db, ITEM.monitor), 0);

  run(db, () => postReturn(db, { return_date: '2026-09-01', employee_id: EMP.tanakit, lines: [{ item_id: ITEM.monitor, qty: 1, condition: 'good', serials: ['C1'] }] }));
  assert.equal(balanceOf(db, ITEM.monitor), 1);

  run(db, () => postReturn(db, { return_date: '2026-09-02', employee_id: EMP.tanakit, lines: [{ item_id: ITEM.monitor, qty: 1, condition: 'scrap', serials: ['C2'] }] }));
  assert.equal(balanceOf(db, ITEM.monitor), 1, 'ของชำรุดไม่กลับเข้าคลัง');
  assert.equal(db.prepare("SELECT status FROM serials WHERE serial_no='C2'").get().status, 'scrapped');
});

test('ปรับปรุงสต็อกเพิ่ม/ลดได้ และห้ามทำให้ติดลบ', () => {
  const db = testDb();
  run(db, () => postReceipt(db, { receive_date: '2026-08-01', lines: [{ item_id: ITEM.mouse, qty: 10 }] }));
  run(db, () => postAdjustment(db, { adjust_date: '2026-09-01', reason: 'count', lines: [{ item_id: ITEM.mouse, qty_diff: -3 }] }));
  assert.equal(balanceOf(db, ITEM.mouse), 7);
  assert.throws(
    () => run(db, () => postAdjustment(db, { adjust_date: '2026-09-02', lines: [{ item_id: ITEM.mouse, qty_diff: -100 }] })),
    /ติดลบ/,
  );
  assert.equal(balanceOf(db, ITEM.mouse), 7);
});

test('ยกเลิกใบรับเข้าคืนยอดและลบ serial ที่สร้างไว้', () => {
  const db = testDb();
  const r = run(db, () => postReceipt(db, { receive_date: '2026-08-01', lines: [{ item_id: ITEM.monitor, qty: 2, serials: ['D1', 'D2'] }] }));
  run(db, () => voidDocument(db, 'receipt', r.id, 'คีย์ผิด'));
  assert.equal(balanceOf(db, ITEM.monitor), 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM serials').get().n, 0);
  assert.equal(db.prepare('SELECT status FROM receipts WHERE id = ?').get(r.id).status, 'void');
  // เลข serial เดิมต้องคีย์ซ้ำได้หลังยกเลิก
  run(db, () => postReceipt(db, { receive_date: '2026-08-02', lines: [{ item_id: ITEM.monitor, qty: 1, serials: ['D1'] }] }));
  assert.equal(balanceOf(db, ITEM.monitor), 1);
});

test('ยกเลิกใบรับเข้าไม่ได้ถ้า serial ถูกเบิกออกไปแล้ว', () => {
  const db = testDb();
  const r = run(db, () => postReceipt(db, { receive_date: '2026-08-01', lines: [{ item_id: ITEM.monitor, qty: 1, serials: ['E1'] }] }));
  run(db, () => postIssue(db, { issue_date: '2026-08-02', employee_id: EMP.tanakit, charge: true, lines: [{ item_id: ITEM.monitor, qty: 1, serials: ['E1'] }] }));
  assert.throws(() => run(db, () => voidDocument(db, 'receipt', r.id, 'x')), /รายการอื่นต่อจากเอกสารนี้|ไม่ได้อยู่ในคลัง/);
  assert.equal(db.prepare('SELECT status FROM receipts WHERE id = ?').get(r.id).status, 'posted');
});

test('ยกเลิกใบเบิกคืนยอดและคืนสถานะ serial', () => {
  const db = testDb();
  run(db, () => postReceipt(db, { receive_date: '2026-08-01', lines: [{ item_id: ITEM.monitor, qty: 2, serials: ['F1', 'F2'] }] }));
  const i = run(db, () => postIssue(db, { issue_date: '2026-08-02', employee_id: EMP.tanakit, charge: true, lines: [{ item_id: ITEM.monitor, qty: 2, serials: ['F1', 'F2'] }] }));
  assert.equal(balanceOf(db, ITEM.monitor), 0);
  run(db, () => voidDocument(db, 'issue', i.id, 'ยกเลิกคำขอ'));
  assert.equal(balanceOf(db, ITEM.monitor), 2);
  const rows = db.prepare('SELECT status, holder_id FROM serials').all();
  assert.ok(rows.every((r) => r.status === 'in_stock' && r.holder_id === null));
});

test('ยกเลิกใบเบิกไม่ได้ถ้ามีการรับคืนต่อแล้ว', () => {
  const db = testDb();
  run(db, () => postReceipt(db, { receive_date: '2026-08-01', lines: [{ item_id: ITEM.monitor, qty: 1, serials: ['G1'] }] }));
  const i = run(db, () => postIssue(db, { issue_date: '2026-08-02', employee_id: EMP.tanakit, charge: true, lines: [{ item_id: ITEM.monitor, qty: 1, serials: ['G1'] }] }));
  run(db, () => postReturn(db, { return_date: '2026-08-03', employee_id: EMP.tanakit, lines: [{ item_id: ITEM.monitor, qty: 1, condition: 'good', serials: ['G1'] }] }));
  assert.throws(() => run(db, () => voidDocument(db, 'issue', i.id, 'x')), /รายการอื่นต่อจากเอกสารนี้/);
});

test('ยกเลิกใบรับคืนชนิดชำรุด คืนสถานะ serial กลับเป็น issued', () => {
  const db = testDb();
  run(db, () => postReceipt(db, { receive_date: '2026-08-01', lines: [{ item_id: ITEM.laptop, qty: 1, serials: ['H1'] }] }));
  run(db, () => postIssue(db, { issue_date: '2026-08-02', employee_id: EMP.tanakit, charge: true, lines: [{ item_id: ITEM.laptop, qty: 1, serials: ['H1'] }] }));
  const rt = run(db, () => postReturn(db, { return_date: '2026-08-03', employee_id: EMP.tanakit, lines: [{ item_id: ITEM.laptop, qty: 1, condition: 'scrap', serials: ['H1'] }] }));
  assert.equal(db.prepare("SELECT status FROM serials WHERE serial_no='H1'").get().status, 'scrapped');

  run(db, () => voidDocument(db, 'return', rt.id, 'คีย์ผิดสภาพ'));
  const s = db.prepare("SELECT * FROM serials WHERE serial_no='H1'").get();
  assert.equal(s.status, 'issued');
  assert.equal(s.holder_id, EMP.tanakit);
  assert.equal(balanceOf(db, ITEM.laptop), 0);
});

test('ยกเลิกเอกสารซ้ำสองครั้งไม่ได้', () => {
  const db = testDb();
  const r = run(db, () => postReceipt(db, { receive_date: '2026-08-01', lines: [{ item_id: ITEM.mouse, qty: 3 }] }));
  run(db, () => voidDocument(db, 'receipt', r.id, 'x'));
  assert.throws(() => run(db, () => voidDocument(db, 'receipt', r.id, 'x')), /ถูกยกเลิกไปแล้ว/);
});

test('ยอดคงเหลือของอุปกรณ์ที่ติดตาม serial ต้องเท่ากับจำนวน serial ที่อยู่ในคลังเสมอ', () => {
  const db = testDb();
  run(db, () => postReceipt(db, { receive_date: '2026-08-01', lines: [{ item_id: ITEM.monitor, qty: 4, serials: ['I1', 'I2', 'I3', 'I4'] }] }));
  run(db, () => postIssue(db, { issue_date: '2026-08-02', employee_id: EMP.tanakit, charge: true, lines: [{ item_id: ITEM.monitor, qty: 2, serials: ['I1', 'I2'] }] }));
  run(db, () => postReturn(db, { return_date: '2026-08-03', employee_id: EMP.tanakit, lines: [{ item_id: ITEM.monitor, qty: 1, condition: 'good', serials: ['I1'] }] }));
  run(db, () => postReturn(db, { return_date: '2026-08-04', employee_id: EMP.tanakit, lines: [{ item_id: ITEM.monitor, qty: 1, condition: 'scrap', serials: ['I2'] }] }));
  const inStock = db.prepare("SELECT COUNT(*) n FROM serials WHERE item_id = ? AND status = 'in_stock'").get(ITEM.monitor).n;
  assert.equal(balanceOf(db, ITEM.monitor), inStock);
  assert.equal(inStock, 3);
});

test('เลขที่เอกสารเรียงต่อเนื่องและแยกตามปี', () => {
  const db = testDb();
  run(db, () => postReceipt(db, { receive_date: '2026-08-01', lines: [{ item_id: ITEM.mouse, qty: 1 }] }));
  run(db, () => postReceipt(db, { receive_date: '2026-08-02', lines: [{ item_id: ITEM.mouse, qty: 1 }] }));
  assert.equal(nextDocNo(db, 'receipt', '2026-08-03'), 'IN-2026-0003');
  assert.equal(nextDocNo(db, 'receipt', '2027-01-01'), 'IN-2027-0001');
});
