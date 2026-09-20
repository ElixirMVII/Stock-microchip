import { badRequest, conflict, notFound } from '../lib/http.js';

/* ============================================================
 *  บริการจัดการสต็อก (รองรับหลายคลัง)
 *  - ยอดคงเหลือคำนวณจากตาราง stock_moves (ledger) เสมอ
 *  - ทุกรายการเดินสต็อกผูกกับคลังหนึ่งคลังเสมอ ยอดจึงแยกรายคลังได้
 *  - ทุกเอกสารบันทึกแบบ posted ทันที และยกเลิกด้วยการกลับรายการ (void)
 * ============================================================ */

const DOC_CONFIG = {
  receipt: { table: 'receipts', lines: 'receipt_lines', fk: 'receipt_id', prefix: 'IN', dateCol: 'receive_date' },
  issue: { table: 'issues', lines: 'issue_lines', fk: 'issue_id', prefix: 'OUT', dateCol: 'issue_date' },
  return: { table: 'returns', lines: 'return_lines', fk: 'return_id', prefix: 'RT', dateCol: 'return_date' },
  adjustment: { table: 'adjustments', lines: 'adjustment_lines', fk: 'adjustment_id', prefix: 'ADJ', dateCol: 'adjust_date' },
  transfer: { table: 'transfers', lines: 'transfer_lines', fk: 'transfer_id', prefix: 'TR', dateCol: 'transfer_date' },
};

export const docConfig = (type) => {
  const cfg = DOC_CONFIG[type];
  if (!cfg) throw badRequest(`ประเภทเอกสารไม่ถูกต้อง: ${type}`);
  return cfg;
};

/** สร้างเลขที่เอกสารถัดไป เช่น IN-2026-0001 (เรียกภายใน transaction) */
export function nextDocNo(db, docType, dateStr) {
  const { table, prefix } = docConfig(docType);
  const year = String(dateStr).slice(0, 4);
  const row = db.prepare(
    `SELECT doc_no FROM ${table} WHERE doc_no LIKE ? ORDER BY LENGTH(doc_no) DESC, doc_no DESC LIMIT 1`,
  ).get(`${prefix}-${year}-%`);
  let seq = 1;
  if (row) {
    const n = parseInt(String(row.doc_no).split('-').pop(), 10);
    if (Number.isInteger(n)) seq = n + 1;
  }
  return `${prefix}-${year}-${String(seq).padStart(4, '0')}`;
}

/** ยอดคงเหลือ — ระบุคลังเพื่อดูรายคลัง หรือไม่ระบุเพื่อดูยอดรวมทุกคลัง */
export function balanceOf(db, itemId, warehouseId = null) {
  const row = warehouseId
    ? db.prepare('SELECT COALESCE(SUM(qty), 0) AS balance FROM stock_moves WHERE item_id = ? AND warehouse_id = ?')
      .get(itemId, warehouseId)
    : db.prepare('SELECT COALESCE(SUM(qty), 0) AS balance FROM stock_moves WHERE item_id = ?').get(itemId);
  return row.balance;
}

export function getItem(db, itemId) {
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(itemId);
  if (!item) throw notFound(`ไม่พบอุปกรณ์รหัส #${itemId}`);
  return item;
}

export function getWarehouse(db, warehouseId) {
  const wh = db.prepare('SELECT * FROM warehouses WHERE id = ?').get(warehouseId);
  if (!wh) throw notFound(`ไม่พบคลังรหัส #${warehouseId}`);
  return wh;
}

/** บันทึกรายการเดินสต็อกหนึ่งบรรทัด */
function addMove(db, move) {
  if (!move.warehouse_id) throw badRequest('รายการเดินสต็อกต้องระบุคลัง');
  return db.prepare(`
    INSERT INTO stock_moves (item_id, warehouse_id, serial_id, serial_no, move_type, qty,
                             doc_type, doc_id, doc_no, line_id, moved_at, note, created_by)
    VALUES (@item_id, @warehouse_id, @serial_id, @serial_no, @move_type, @qty,
            @doc_type, @doc_id, @doc_no, @line_id, @moved_at, @note, @created_by)
  `).run({ serial_id: null, serial_no: null, line_id: null, note: null, created_by: null, ...move });
}

/** บันทึกเหตุการณ์ของ Serial หนึ่งชิ้น (ใช้ทำไทม์ไลน์ และย้อนสถานะตอนยกเลิก) */
function addSerialEvent(db, ev) {
  db.prepare(`
    INSERT INTO serial_events (serial_id, doc_type, doc_id, doc_no, line_id, event,
                               status_before, status_after, holder_before, holder_after,
                               wh_before, wh_after, event_date, note)
    VALUES (@serial_id, @doc_type, @doc_id, @doc_no, @line_id, @event,
            @status_before, @status_after, @holder_before, @holder_after,
            @wh_before, @wh_after, @event_date, @note)
  `).run({
    line_id: null, status_before: null, holder_before: null, holder_after: null,
    wh_before: null, wh_after: null, note: null, ...ev,
  });
}

/** ตรวจว่ายอดคงเหลือของทุกคู่ (อุปกรณ์ × คลัง) ที่ระบุต้องไม่ติดลบ */
function assertNotNegative(db, pairs) {
  const seen = new Set();
  for (const { itemId, warehouseId } of pairs) {
    const key = `${itemId}:${warehouseId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const bal = balanceOf(db, itemId, warehouseId);
    if (bal < 0) {
      const item = getItem(db, itemId);
      const wh = getWarehouse(db, warehouseId);
      throw conflict(`ยอดคงเหลือของ "${item.name}" (${item.sku}) ในคลัง ${wh.code} จะติดลบ (${bal}) จึงไม่สามารถทำรายการนี้ได้`);
    }
  }
}

/**
 * แปลงรายการ serial ที่ส่งเข้ามาเป็นแถวในตาราง serials พร้อมตรวจสถานะ
 * @param {number|null} warehouseId ถ้าระบุ serial ต้องอยู่ในคลังนี้ (ใช้ตอนเบิก/โอน)
 */
function resolveSerials(db, item, input, expectedStatus, qty, warehouseId = null) {
  const list = Array.isArray(input) ? input : [];
  const cleaned = list
    .map((s) => String(typeof s === 'object' && s !== null ? (s.serial_no ?? s.id ?? '') : s).trim())
    .filter(Boolean);

  if (!item.track_serial) {
    if (cleaned.length) {
      throw badRequest(`อุปกรณ์ "${item.name}" ไม่ได้เปิดใช้การติดตาม Serial จึงระบุ Serial ไม่ได้`);
    }
    return [];
  }
  if (cleaned.length !== qty) {
    throw badRequest(`อุปกรณ์ "${item.name}" ต้องระบุ Serial ให้ครบตามจำนวน (ต้องการ ${qty} รายการ แต่ได้รับ ${cleaned.length} รายการ)`);
  }
  if (new Set(cleaned.map((s) => s.toLowerCase())).size !== cleaned.length) {
    throw badRequest(`มี Serial ซ้ำกันในรายการของ "${item.name}"`);
  }

  const byNo = db.prepare('SELECT * FROM serials WHERE serial_no = ? COLLATE NOCASE');
  const byId = db.prepare('SELECT * FROM serials WHERE id = ?');
  return cleaned.map((token) => {
    const row = (/^\d+$/.test(token) ? byId.get(Number(token)) : null) || byNo.get(token);
    if (!row) throw notFound(`ไม่พบ Serial "${token}" ในระบบ`);
    if (row.item_id !== item.id) {
      throw badRequest(`Serial "${row.serial_no}" ไม่ได้อยู่ในอุปกรณ์ "${item.name}"`);
    }
    if (row.status !== expectedStatus) {
      const label = { in_stock: 'อยู่ในคลัง', issued: 'ถูกเบิกออกไปแล้ว', scrapped: 'ตัดจำหน่ายแล้ว' };
      throw conflict(`Serial "${row.serial_no}" มีสถานะ "${label[row.status] || row.status}" จึงทำรายการนี้ไม่ได้`);
    }
    if (warehouseId && row.warehouse_id !== warehouseId) {
      const here = getWarehouse(db, warehouseId);
      const there = getWarehouse(db, row.warehouse_id);
      throw conflict(`Serial "${row.serial_no}" อยู่ที่คลัง ${there.code} ไม่ใช่คลัง ${here.code} — หากต้องการใช้ ให้โอนย้ายระหว่างคลังก่อน`);
    }
    return row;
  });
}

/** ตรวจว่า serial นี้ไม่มีเหตุการณ์อื่นเกิดขึ้นหลังเอกสารที่กำลังจะยกเลิก */
function assertNoLaterSerialEvents(db, serialId, docType, docId) {
  const cur = db.prepare(
    'SELECT MAX(id) AS last_id FROM serial_events WHERE serial_id = ? AND doc_type = ? AND doc_id = ?',
  ).get(serialId, docType, docId);
  const later = db.prepare('SELECT COUNT(*) AS n FROM serial_events WHERE serial_id = ? AND id > ? AND reversed = 0')
    .get(serialId, cur.last_id ?? 0);
  if (later.n > 0) {
    const s = db.prepare('SELECT serial_no FROM serials WHERE id = ?').get(serialId);
    throw conflict(`Serial "${s?.serial_no ?? serialId}" มีการทำรายการอื่นต่อจากเอกสารนี้แล้ว กรุณายกเลิกเอกสารล่าสุดก่อน`);
  }
}

/* ------------------------------------------------------------
 *  รับอุปกรณ์เข้าคลัง (IN)
 * ------------------------------------------------------------ */
export function postReceipt(db, data, userId = null) {
  const wh = getWarehouse(db, data.warehouse_id);
  const docNo = data.doc_no || nextDocNo(db, 'receipt', data.receive_date);
  const receiptId = db.prepare(`
    INSERT INTO receipts (doc_no, warehouse_id, receive_date, po_no, supplier_id, note, status, created_by)
    VALUES (?, ?, ?, ?, ?, ?, 'posted', ?)
  `).run(docNo, wh.id, data.receive_date, data.po_no ?? null, data.supplier_id ?? null, data.note ?? null, userId)
    .lastInsertRowid;

  const insLine = db.prepare('INSERT INTO receipt_lines (receipt_id, item_id, qty, unit_cost, note) VALUES (?, ?, ?, ?, ?)');
  const insSerial = db.prepare(`
    INSERT INTO serials (item_id, serial_no, status, warehouse_id, receipt_id, received_at, note)
    VALUES (?, ?, 'in_stock', ?, ?, ?, ?)
  `);
  const findSerial = db.prepare('SELECT id FROM serials WHERE serial_no = ? COLLATE NOCASE');

  for (const line of data.lines) {
    const item = getItem(db, line.item_id);
    if (!item.active) throw badRequest(`อุปกรณ์ "${item.name}" ถูกปิดใช้งานอยู่`);
    const lineId = insLine.run(receiptId, item.id, line.qty, line.unit_cost ?? item.unit_cost ?? 0, line.note ?? null).lastInsertRowid;

    if (item.track_serial) {
      const serials = (line.serials || [])
        .map((s) => String(typeof s === 'object' && s !== null ? s.serial_no : s).trim()).filter(Boolean);
      if (serials.length !== line.qty) {
        throw badRequest(`อุปกรณ์ "${item.name}" ต้องระบุ Serial ให้ครบ ${line.qty} รายการ (ได้รับ ${serials.length} รายการ)`);
      }
      if (new Set(serials.map((s) => s.toLowerCase())).size !== serials.length) {
        throw badRequest(`มี Serial ซ้ำกันในรายการของ "${item.name}"`);
      }
      for (const sn of serials) {
        if (findSerial.get(sn)) throw conflict(`Serial "${sn}" มีอยู่ในระบบแล้ว`);
        const serialId = insSerial.run(item.id, sn, wh.id, receiptId, data.receive_date, line.note ?? null).lastInsertRowid;
        addSerialEvent(db, {
          serial_id: serialId, doc_type: 'receipt', doc_id: receiptId, doc_no: docNo, line_id: lineId,
          event: 'receive', status_before: null, status_after: 'in_stock',
          wh_before: null, wh_after: wh.id, event_date: data.receive_date, note: line.note ?? null,
        });
        addMove(db, {
          item_id: item.id, warehouse_id: wh.id, serial_id: serialId, serial_no: sn, move_type: 'IN', qty: 1,
          doc_type: 'receipt', doc_id: receiptId, doc_no: docNo, line_id: lineId,
          moved_at: data.receive_date, note: line.note ?? null, created_by: userId,
        });
      }
    } else {
      addMove(db, {
        item_id: item.id, warehouse_id: wh.id, move_type: 'IN', qty: line.qty,
        doc_type: 'receipt', doc_id: receiptId, doc_no: docNo, line_id: lineId,
        moved_at: data.receive_date, note: line.note ?? null, created_by: userId,
      });
    }
  }
  return { id: receiptId, doc_no: docNo, warehouse_id: wh.id };
}

/* ------------------------------------------------------------
 *  เบิกอุปกรณ์ออก (OUT) — ตัดจากคลังที่ระบุเท่านั้น
 * ------------------------------------------------------------ */
export function postIssue(db, data, userId = null) {
  const wh = getWarehouse(db, data.warehouse_id);
  const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(data.employee_id);
  if (!emp) throw notFound(`ไม่พบพนักงานรหัส #${data.employee_id}`);

  const docNo = data.doc_no || nextDocNo(db, 'issue', data.issue_date);
  const issueId = db.prepare(`
    INSERT INTO issues (doc_no, warehouse_id, issue_date, employee_id, is_staff_id, charge, remark, status, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'posted', ?)
  `).run(docNo, wh.id, data.issue_date, emp.id, data.is_staff_id ?? null,
    data.charge ? 1 : 0, data.remark ?? null, userId).lastInsertRowid;

  const insLine = db.prepare('INSERT INTO issue_lines (issue_id, item_id, qty, note) VALUES (?, ?, ?, ?)');
  const markIssued = db.prepare(
    "UPDATE serials SET status = 'issued', holder_id = ?, issued_at = ?, updated_at = datetime('now') WHERE id = ?",
  );

  // รวมจำนวนที่ต้องตัดต่ออุปกรณ์ เพื่อตรวจยอดคงเหลือ "ในคลังนี้" แบบรวมทุกบรรทัด
  const need = new Map();
  for (const line of data.lines) need.set(line.item_id, (need.get(line.item_id) || 0) + line.qty);
  for (const [itemId, qty] of need) {
    const item = getItem(db, itemId);
    const bal = balanceOf(db, itemId, wh.id);
    if (bal < qty) {
      throw conflict(`สต็อกไม่พอสำหรับ "${item.name}" (${item.sku}) ในคลัง ${wh.code} — คงเหลือ ${bal} ${item.unit} แต่ต้องการ ${qty} ${item.unit}`);
    }
  }

  for (const line of data.lines) {
    const item = getItem(db, line.item_id);
    const lineId = insLine.run(issueId, item.id, line.qty, line.note ?? null).lastInsertRowid;
    const serials = resolveSerials(db, item, line.serials, 'in_stock', line.qty, wh.id);

    if (serials.length) {
      for (const s of serials) {
        markIssued.run(emp.id, data.issue_date, s.id);
        addSerialEvent(db, {
          serial_id: s.id, doc_type: 'issue', doc_id: issueId, doc_no: docNo, line_id: lineId,
          event: 'issue', status_before: s.status, status_after: 'issued',
          holder_before: s.holder_id, holder_after: emp.id,
          wh_before: s.warehouse_id, wh_after: s.warehouse_id,
          event_date: data.issue_date, note: line.note ?? null,
        });
        addMove(db, {
          item_id: item.id, warehouse_id: wh.id, serial_id: s.id, serial_no: s.serial_no, move_type: 'OUT', qty: -1,
          doc_type: 'issue', doc_id: issueId, doc_no: docNo, line_id: lineId,
          moved_at: data.issue_date, note: line.note ?? null, created_by: userId,
        });
      }
    } else {
      addMove(db, {
        item_id: item.id, warehouse_id: wh.id, move_type: 'OUT', qty: -line.qty,
        doc_type: 'issue', doc_id: issueId, doc_no: docNo, line_id: lineId,
        moved_at: data.issue_date, note: line.note ?? null, created_by: userId,
      });
    }
  }
  assertNotNegative(db, [...need.keys()].map((itemId) => ({ itemId, warehouseId: wh.id })));
  return { id: issueId, doc_no: docNo, warehouse_id: wh.id };
}

/* ------------------------------------------------------------
 *  รับคืนอุปกรณ์ (RETURN) — คืนเข้าคลังที่ระบุ (อาจต่างจากคลังที่เบิกไป)
 *  condition = 'good'  -> คืนเข้าคลัง (บวกยอด)
 *  condition = 'scrap' -> ชำรุด ไม่คืนเข้าคลัง (ไม่กระทบยอด, serial = scrapped)
 * ------------------------------------------------------------ */
export function postReturn(db, data, userId = null) {
  const wh = getWarehouse(db, data.warehouse_id);
  const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(data.employee_id);
  if (!emp) throw notFound(`ไม่พบพนักงานรหัส #${data.employee_id}`);

  const docNo = data.doc_no || nextDocNo(db, 'return', data.return_date);
  const returnId = db.prepare(`
    INSERT INTO returns (doc_no, warehouse_id, return_date, employee_id, is_staff_id, note, status, created_by)
    VALUES (?, ?, ?, ?, ?, ?, 'posted', ?)
  `).run(docNo, wh.id, data.return_date, emp.id, data.is_staff_id ?? null, data.note ?? null, userId).lastInsertRowid;

  const insLine = db.prepare('INSERT INTO return_lines (return_id, item_id, qty, condition, note) VALUES (?, ?, ?, ?, ?)');
  const updSerial = db.prepare(
    "UPDATE serials SET status = ?, holder_id = NULL, warehouse_id = ?, received_at = ?, updated_at = datetime('now') WHERE id = ?",
  );

  for (const line of data.lines) {
    const item = getItem(db, line.item_id);
    const condition = line.condition === 'scrap' ? 'scrap' : 'good';
    const lineId = insLine.run(returnId, item.id, line.qty, condition, line.note ?? null).lastInsertRowid;
    const serials = resolveSerials(db, item, line.serials, 'issued', line.qty);

    if (serials.length) {
      for (const s of serials) {
        const statusAfter = condition === 'good' ? 'in_stock' : 'scrapped';
        updSerial.run(statusAfter, wh.id, data.return_date, s.id);
        addSerialEvent(db, {
          serial_id: s.id, doc_type: 'return', doc_id: returnId, doc_no: docNo, line_id: lineId,
          event: condition === 'good' ? 'return' : 'scrap',
          status_before: s.status, status_after: statusAfter,
          holder_before: s.holder_id, holder_after: null,
          wh_before: s.warehouse_id, wh_after: wh.id,
          event_date: data.return_date, note: line.note ?? null,
        });
        // ของชำรุด (scrap) ไม่กลับเข้าคลัง จึงไม่บันทึกรายการเดินสต็อก
        if (condition === 'good') {
          addMove(db, {
            item_id: item.id, warehouse_id: wh.id, serial_id: s.id, serial_no: s.serial_no, move_type: 'RETURN', qty: 1,
            doc_type: 'return', doc_id: returnId, doc_no: docNo, line_id: lineId,
            moved_at: data.return_date, note: line.note ?? null, created_by: userId,
          });
        }
      }
    } else if (condition === 'good') {
      addMove(db, {
        item_id: item.id, warehouse_id: wh.id, move_type: 'RETURN', qty: line.qty,
        doc_type: 'return', doc_id: returnId, doc_no: docNo, line_id: lineId,
        moved_at: data.return_date, note: line.note ?? null, created_by: userId,
      });
    }
  }
  return { id: returnId, doc_no: docNo, warehouse_id: wh.id };
}

/* ------------------------------------------------------------
 *  ปรับปรุงสต็อก (ADJUST) — ปรับเฉพาะคลังที่ระบุ
 * ------------------------------------------------------------ */
export function postAdjustment(db, data, userId = null) {
  const wh = getWarehouse(db, data.warehouse_id);
  const docNo = data.doc_no || nextDocNo(db, 'adjustment', data.adjust_date);
  const adjId = db.prepare(`
    INSERT INTO adjustments (doc_no, warehouse_id, adjust_date, reason, note, status, created_by)
    VALUES (?, ?, ?, ?, ?, 'posted', ?)
  `).run(docNo, wh.id, data.adjust_date, data.reason || 'count', data.note ?? null, userId).lastInsertRowid;

  const insLine = db.prepare('INSERT INTO adjustment_lines (adjustment_id, item_id, qty_diff, note) VALUES (?, ?, ?, ?)');
  const touched = [];

  for (const line of data.lines) {
    const item = getItem(db, line.item_id);
    if (item.track_serial) {
      throw badRequest(`อุปกรณ์ "${item.name}" ติดตามด้วย Serial จึงต้องปรับปรุงผ่านเอกสารรับเข้า/รับคืนแทน`);
    }
    const lineId = insLine.run(adjId, item.id, line.qty_diff, line.note ?? null).lastInsertRowid;
    addMove(db, {
      item_id: item.id, warehouse_id: wh.id, move_type: 'ADJUST', qty: line.qty_diff,
      doc_type: 'adjustment', doc_id: adjId, doc_no: docNo, line_id: lineId,
      moved_at: data.adjust_date, note: line.note ?? null, created_by: userId,
    });
    touched.push({ itemId: item.id, warehouseId: wh.id });
  }
  assertNotNegative(db, touched);
  return { id: adjId, doc_no: docNo, warehouse_id: wh.id };
}

/* ------------------------------------------------------------
 *  โอนย้ายระหว่างคลัง (TRANSFER)
 *  ตัดออกจากคลังต้นทาง และเพิ่มเข้าคลังปลายทางในเอกสารเดียว
 * ------------------------------------------------------------ */
export function postTransfer(db, data, userId = null) {
  const from = getWarehouse(db, data.from_warehouse_id);
  const to = getWarehouse(db, data.to_warehouse_id);
  if (from.id === to.id) throw badRequest('คลังต้นทางและคลังปลายทางต้องไม่ใช่คลังเดียวกัน');

  const docNo = data.doc_no || nextDocNo(db, 'transfer', data.transfer_date);
  const transferId = db.prepare(`
    INSERT INTO transfers (doc_no, transfer_date, from_warehouse_id, to_warehouse_id, note, status, created_by)
    VALUES (?, ?, ?, ?, ?, 'posted', ?)
  `).run(docNo, data.transfer_date, from.id, to.id, data.note ?? null, userId).lastInsertRowid;

  const insLine = db.prepare('INSERT INTO transfer_lines (transfer_id, item_id, qty, note) VALUES (?, ?, ?, ?)');
  const moveSerial = db.prepare("UPDATE serials SET warehouse_id = ?, updated_at = datetime('now') WHERE id = ?");

  // ตรวจยอดคงเหลือของคลังต้นทางแบบรวมทุกบรรทัดก่อน
  const need = new Map();
  for (const line of data.lines) need.set(line.item_id, (need.get(line.item_id) || 0) + line.qty);
  for (const [itemId, qty] of need) {
    const item = getItem(db, itemId);
    const bal = balanceOf(db, itemId, from.id);
    if (bal < qty) {
      throw conflict(`สต็อกไม่พอสำหรับ "${item.name}" (${item.sku}) ในคลังต้นทาง ${from.code} — คงเหลือ ${bal} ${item.unit} แต่ต้องการโอน ${qty} ${item.unit}`);
    }
  }

  for (const line of data.lines) {
    const item = getItem(db, line.item_id);
    const lineId = insLine.run(transferId, item.id, line.qty, line.note ?? null).lastInsertRowid;
    const serials = resolveSerials(db, item, line.serials, 'in_stock', line.qty, from.id);

    const emit = (serial) => {
      const common = {
        item_id: item.id, serial_id: serial?.id ?? null, serial_no: serial?.serial_no ?? null,
        move_type: 'TRANSFER', doc_type: 'transfer', doc_id: transferId, doc_no: docNo, line_id: lineId,
        moved_at: data.transfer_date, note: line.note ?? null, created_by: userId,
      };
      const qty = serial ? 1 : line.qty;
      addMove(db, { ...common, warehouse_id: from.id, qty: -qty });
      addMove(db, { ...common, warehouse_id: to.id, qty });
    };

    if (serials.length) {
      for (const s of serials) {
        moveSerial.run(to.id, s.id);
        addSerialEvent(db, {
          serial_id: s.id, doc_type: 'transfer', doc_id: transferId, doc_no: docNo, line_id: lineId,
          event: 'transfer', status_before: s.status, status_after: s.status,
          holder_before: s.holder_id, holder_after: s.holder_id,
          wh_before: from.id, wh_after: to.id,
          event_date: data.transfer_date, note: line.note ?? null,
        });
        emit(s);
      }
    } else {
      emit(null);
    }
  }
  assertNotNegative(db, [...need.keys()].map((itemId) => ({ itemId, warehouseId: from.id })));
  return { id: transferId, doc_no: docNo, from_warehouse_id: from.id, to_warehouse_id: to.id };
}

/* ------------------------------------------------------------
 *  ยกเลิกเอกสาร (VOID) ด้วยการกลับรายการในบัญชีเดินสต็อก
 * ------------------------------------------------------------ */
export function voidDocument(db, docType, docId, reason, userId = null) {
  const cfg = docConfig(docType);
  const doc = db.prepare(`SELECT * FROM ${cfg.table} WHERE id = ?`).get(docId);
  if (!doc) throw notFound('ไม่พบเอกสารที่ต้องการยกเลิก');
  if (doc.status === 'void') throw conflict(`เอกสาร ${doc.doc_no} ถูกยกเลิกไปแล้ว`);

  const moves = db.prepare('SELECT * FROM stock_moves WHERE doc_type = ? AND doc_id = ? ORDER BY id').all(docType, docId);
  const events = db.prepare(
    'SELECT * FROM serial_events WHERE doc_type = ? AND doc_id = ? AND reversed = 0 ORDER BY id',
  ).all(docType, docId);
  const voidedAt = new Date().toISOString().slice(0, 10);

  // --- ตรวจเงื่อนไขทั้งหมดก่อน แล้วจึงเริ่มเขียนข้อมูล ---
  for (const ev of events) assertNoLaterSerialEvents(db, ev.serial_id, docType, docId);

  // --- กลับรายการในบัญชีเดินสต็อก (คงคลังเดิมของแต่ละรายการไว้) ---
  const touched = [];
  for (const mv of moves) {
    addMove(db, {
      item_id: mv.item_id,
      warehouse_id: mv.warehouse_id,
      // ใบรับเข้าจะลบ serial ทิ้ง จึงอ้างอิงเฉพาะเลข serial เป็นข้อความ
      serial_id: docType === 'receipt' ? null : mv.serial_id,
      serial_no: mv.serial_no,
      move_type: 'VOID',
      qty: -mv.qty,
      doc_type: docType,
      doc_id: docId,
      doc_no: doc.doc_no,
      line_id: mv.line_id,
      moved_at: voidedAt,
      note: `ยกเลิกเอกสาร ${doc.doc_no}${reason ? ` — ${reason}` : ''}`,
      created_by: userId,
    });
    touched.push({ itemId: mv.item_id, warehouseId: mv.warehouse_id });
  }

  // --- ย้อนสถานะและคลังของ Serial กลับเป็นค่าก่อนทำเอกสารนี้ ---
  const restore = db.prepare(
    "UPDATE serials SET status = ?, holder_id = ?, warehouse_id = COALESCE(?, warehouse_id), updated_at = datetime('now') WHERE id = ?",
  );
  for (const ev of [...events].reverse()) {
    if (ev.event === 'receive') continue; // serial เกิดจากเอกสารนี้ เดี๋ยวลบทิ้งด้านล่าง
    restore.run(ev.status_before, ev.holder_before, ev.wh_before ?? null, ev.serial_id);
  }
  db.prepare('UPDATE serial_events SET reversed = 1 WHERE doc_type = ? AND doc_id = ? AND reversed = 0').run(docType, docId);

  // --- ใบรับเข้า: ลบ serial ที่สร้างจากเอกสารนี้ เพื่อให้คีย์เลขเดิมใหม่ได้ ---
  if (docType === 'receipt') {
    const created = db.prepare('SELECT * FROM serials WHERE receipt_id = ?').all(docId);
    for (const sr of created) {
      if (sr.status !== 'in_stock') {
        throw conflict(`Serial "${sr.serial_no}" ไม่ได้อยู่ในคลังแล้ว จึงยกเลิกใบรับเข้านี้ไม่ได้`);
      }
    }
    db.prepare('UPDATE stock_moves SET serial_id = NULL WHERE serial_id IN (SELECT id FROM serials WHERE receipt_id = ?)').run(docId);
    db.prepare('DELETE FROM serials WHERE receipt_id = ?').run(docId);
  }

  db.prepare(
    `UPDATE ${cfg.table} SET status = 'void', voided_by = ?, voided_at = datetime('now'), void_reason = ? WHERE id = ?`,
  ).run(userId, reason ?? null, docId);

  assertNotNegative(db, touched);
  return { id: docId, doc_no: doc.doc_no, status: 'void' };
}

/** ไทม์ไลน์การใช้งานของ Serial หนึ่งชิ้น */
export function serialTimeline(db, serialId) {
  return db.prepare(`
    SELECT e.*,
           emp_b.name AS holder_before_name, emp_a.name AS holder_after_name,
           wb.code AS wh_before_code, wa.code AS wh_after_code
    FROM serial_events e
    LEFT JOIN employees emp_b ON emp_b.id = e.holder_before
    LEFT JOIN employees emp_a ON emp_a.id = e.holder_after
    LEFT JOIN warehouses wb ON wb.id = e.wh_before
    LEFT JOIN warehouses wa ON wa.id = e.wh_after
    WHERE e.serial_id = ?
    ORDER BY e.id
  `).all(serialId);
}
