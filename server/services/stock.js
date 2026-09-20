import { badRequest, conflict, notFound } from '../lib/http.js';

/* ============================================================
 *  บริการจัดการสต็อก (MySQL, รองรับหลายคลัง)
 *  - ยอดคงเหลือคำนวณจากตาราง stock_moves (ledger) เสมอ
 *  - ทุกรายการเดินสต็อกผูกกับคลังหนึ่งคลังเสมอ ยอดจึงแยกรายคลังได้
 *  - ทุกเอกสารบันทึกแบบ posted ทันที และยกเลิกด้วยการกลับรายการ (void)
 *
 *  ทุกฟังก์ชันรับ handle ฐานข้อมูล (db หรือ t ที่อยู่ในทรานแซกชัน)
 *  เป็นพารามิเตอร์แรก และเป็น async ทั้งหมด
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

/** สร้างเลขที่เอกสารถัดไป เช่น IN-2026-0001 (เรียกภายในทรานแซกชัน) */
export async function nextDocNo(db, docType, dateStr) {
  const { table, prefix } = docConfig(docType);
  const year = String(dateStr).slice(0, 4);
  const row = await db.get(
    `SELECT doc_no FROM ${table} WHERE doc_no LIKE @like ORDER BY LENGTH(doc_no) DESC, doc_no DESC LIMIT 1`,
    { like: `${prefix}-${year}-%` },
  );
  let seq = 1;
  if (row) {
    const n = parseInt(String(row.doc_no).split('-').pop(), 10);
    if (Number.isInteger(n)) seq = n + 1;
  }
  return `${prefix}-${year}-${String(seq).padStart(4, '0')}`;
}

/** ยอดคงเหลือ — ระบุคลังเพื่อดูรายคลัง หรือไม่ระบุเพื่อดูยอดรวมทุกคลัง */
export async function balanceOf(db, itemId, warehouseId = null) {
  const sql = warehouseId
    ? 'SELECT COALESCE(SUM(qty), 0) AS balance FROM stock_moves WHERE item_id = @item AND warehouse_id = @wh'
    : 'SELECT COALESCE(SUM(qty), 0) AS balance FROM stock_moves WHERE item_id = @item';
  const row = await db.get(sql, warehouseId ? { item: itemId, wh: warehouseId } : { item: itemId });
  return Number(row.balance);
}

export async function getItem(db, itemId) {
  const item = await db.get('SELECT * FROM items WHERE id = @id', { id: itemId });
  if (!item) throw notFound(`ไม่พบอุปกรณ์รหัส #${itemId}`);
  return item;
}

export async function getWarehouse(db, warehouseId) {
  const wh = await db.get('SELECT * FROM warehouses WHERE id = @id', { id: warehouseId });
  if (!wh) throw notFound(`ไม่พบคลังรหัส #${warehouseId}`);
  return wh;
}

/** บันทึกรายการเดินสต็อกหนึ่งบรรทัด */
async function addMove(db, move) {
  if (!move.warehouse_id) throw badRequest('รายการเดินสต็อกต้องระบุคลัง');
  return db.run(`
    INSERT INTO stock_moves (item_id, warehouse_id, serial_id, serial_no, move_type, qty,
                             doc_type, doc_id, doc_no, line_id, moved_at, note, created_by)
    VALUES (@item_id, @warehouse_id, @serial_id, @serial_no, @move_type, @qty,
            @doc_type, @doc_id, @doc_no, @line_id, @moved_at, @note, @created_by)
  `, { serial_id: null, serial_no: null, line_id: null, note: null, created_by: null, ...move });
}

/** บันทึกเหตุการณ์ของ Serial หนึ่งชิ้น (ใช้ทำไทม์ไลน์ และย้อนสถานะตอนยกเลิก) */
async function addSerialEvent(db, ev) {
  await db.run(`
    INSERT INTO serial_events (serial_id, doc_type, doc_id, doc_no, line_id, event,
                               status_before, status_after, holder_before, holder_after,
                               wh_before, wh_after, event_date, note)
    VALUES (@serial_id, @doc_type, @doc_id, @doc_no, @line_id, @event,
            @status_before, @status_after, @holder_before, @holder_after,
            @wh_before, @wh_after, @event_date, @note)
  `, {
    line_id: null, status_before: null, holder_before: null, holder_after: null,
    wh_before: null, wh_after: null, note: null, ...ev,
  });
}

/** ตรวจว่ายอดคงเหลือของทุกคู่ (อุปกรณ์ × คลัง) ที่ระบุต้องไม่ติดลบ */
async function assertNotNegative(db, pairs) {
  const seen = new Set();
  for (const { itemId, warehouseId } of pairs) {
    const key = `${itemId}:${warehouseId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const bal = await balanceOf(db, itemId, warehouseId);
    if (bal < 0) {
      const item = await getItem(db, itemId);
      const wh = await getWarehouse(db, warehouseId);
      throw conflict(`ยอดคงเหลือของ "${item.name}" (${item.sku}) ในคลัง ${wh.code} จะติดลบ (${bal}) จึงไม่สามารถทำรายการนี้ได้`);
    }
  }
}

/**
 * แปลงรายการ serial ที่ส่งเข้ามาเป็นแถวในตาราง serials พร้อมตรวจสถานะ
 * @param {number|null} warehouseId ถ้าระบุ serial ต้องอยู่ในคลังนี้ (ใช้ตอนเบิก/โอน)
 */
async function resolveSerials(db, item, input, expectedStatus, qty, warehouseId = null) {
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

  const out = [];
  for (const token of cleaned) {
    // collation utf8mb4_unicode_ci เทียบแบบไม่สนตัวพิมพ์อยู่แล้ว
    let row = /^\d+$/.test(token)
      ? await db.get('SELECT * FROM serials WHERE id = @id', { id: Number(token) })
      : null;
    if (!row) row = await db.get('SELECT * FROM serials WHERE serial_no = @sn', { sn: token });

    if (!row) throw notFound(`ไม่พบ Serial "${token}" ในระบบ`);
    if (row.item_id !== item.id) {
      throw badRequest(`Serial "${row.serial_no}" ไม่ได้อยู่ในอุปกรณ์ "${item.name}"`);
    }
    if (row.status !== expectedStatus) {
      const label = { in_stock: 'อยู่ในคลัง', issued: 'ถูกเบิกออกไปแล้ว', scrapped: 'ตัดจำหน่ายแล้ว' };
      throw conflict(`Serial "${row.serial_no}" มีสถานะ "${label[row.status] || row.status}" จึงทำรายการนี้ไม่ได้`);
    }
    if (warehouseId && row.warehouse_id !== warehouseId) {
      const here = await getWarehouse(db, warehouseId);
      const there = await getWarehouse(db, row.warehouse_id);
      throw conflict(`Serial "${row.serial_no}" อยู่ที่คลัง ${there.code} ไม่ใช่คลัง ${here.code} — หากต้องการใช้ ให้โอนย้ายระหว่างคลังก่อน`);
    }
    out.push(row);
  }
  return out;
}

/** ตรวจว่า serial นี้ไม่มีเหตุการณ์อื่นเกิดขึ้นหลังเอกสารที่กำลังจะยกเลิก */
async function assertNoLaterSerialEvents(db, serialId, docType, docId) {
  const cur = await db.get(
    'SELECT MAX(id) AS last_id FROM serial_events WHERE serial_id = @s AND doc_type = @dt AND doc_id = @di',
    { s: serialId, dt: docType, di: docId },
  );
  const later = await db.get(
    'SELECT COUNT(*) AS n FROM serial_events WHERE serial_id = @s AND id > @last AND reversed = 0',
    { s: serialId, last: cur?.last_id ?? 0 },
  );
  if (Number(later.n) > 0) {
    const s = await db.get('SELECT serial_no FROM serials WHERE id = @id', { id: serialId });
    throw conflict(`Serial "${s?.serial_no ?? serialId}" มีการทำรายการอื่นต่อจากเอกสารนี้แล้ว กรุณายกเลิกเอกสารล่าสุดก่อน`);
  }
}

/* ------------------------------------------------------------
 *  รับอุปกรณ์เข้าคลัง (IN)
 * ------------------------------------------------------------ */
export async function postReceipt(db, data, userId = null) {
  const wh = await getWarehouse(db, data.warehouse_id);
  const docNo = data.doc_no || await nextDocNo(db, 'receipt', data.receive_date);
  const receiptId = (await db.run(`
    INSERT INTO receipts (doc_no, warehouse_id, receive_date, po_no, supplier_id, note, status, created_by)
    VALUES (@doc_no, @wh, @d, @po, @sup, @note, 'posted', @uid)
  `, {
    doc_no: docNo, wh: wh.id, d: data.receive_date, po: data.po_no ?? null,
    sup: data.supplier_id ?? null, note: data.note ?? null, uid: userId,
  })).lastInsertRowid;

  for (const line of data.lines) {
    const item = await getItem(db, line.item_id);
    if (!item.active) throw badRequest(`อุปกรณ์ "${item.name}" ถูกปิดใช้งานอยู่`);
    const lineId = (await db.run(
      'INSERT INTO receipt_lines (receipt_id, item_id, qty, unit_cost, note) VALUES (@r, @i, @q, @c, @n)',
      { r: receiptId, i: item.id, q: line.qty, c: line.unit_cost ?? item.unit_cost ?? 0, n: line.note ?? null },
    )).lastInsertRowid;

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
        if (await db.get('SELECT id FROM serials WHERE serial_no = @sn', { sn })) {
          throw conflict(`Serial "${sn}" มีอยู่ในระบบแล้ว`);
        }
        const serialId = (await db.run(`
          INSERT INTO serials (item_id, serial_no, status, warehouse_id, receipt_id, received_at, note)
          VALUES (@i, @sn, 'in_stock', @wh, @r, @d, @n)
        `, { i: item.id, sn, wh: wh.id, r: receiptId, d: data.receive_date, n: line.note ?? null })).lastInsertRowid;

        await addSerialEvent(db, {
          serial_id: serialId, doc_type: 'receipt', doc_id: receiptId, doc_no: docNo, line_id: lineId,
          event: 'receive', status_before: null, status_after: 'in_stock',
          wh_before: null, wh_after: wh.id, event_date: data.receive_date, note: line.note ?? null,
        });
        await addMove(db, {
          item_id: item.id, warehouse_id: wh.id, serial_id: serialId, serial_no: sn, move_type: 'IN', qty: 1,
          doc_type: 'receipt', doc_id: receiptId, doc_no: docNo, line_id: lineId,
          moved_at: data.receive_date, note: line.note ?? null, created_by: userId,
        });
      }
    } else {
      await addMove(db, {
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
export async function postIssue(db, data, userId = null) {
  const wh = await getWarehouse(db, data.warehouse_id);
  const emp = await db.get('SELECT * FROM employees WHERE id = @id', { id: data.employee_id });
  if (!emp) throw notFound(`ไม่พบพนักงานรหัส #${data.employee_id}`);

  const docNo = data.doc_no || await nextDocNo(db, 'issue', data.issue_date);
  const issueId = (await db.run(`
    INSERT INTO issues (doc_no, warehouse_id, issue_date, employee_id, is_staff_id, charge, remark, status, created_by)
    VALUES (@doc_no, @wh, @d, @emp, @staff, @charge, @remark, 'posted', @uid)
  `, {
    doc_no: docNo, wh: wh.id, d: data.issue_date, emp: emp.id, staff: data.is_staff_id ?? null,
    charge: data.charge ? 1 : 0, remark: data.remark ?? null, uid: userId,
  })).lastInsertRowid;

  // รวมจำนวนที่ต้องตัดต่ออุปกรณ์ เพื่อตรวจยอดคงเหลือ "ในคลังนี้" แบบรวมทุกบรรทัด
  const need = new Map();
  for (const line of data.lines) need.set(line.item_id, (need.get(line.item_id) || 0) + line.qty);
  for (const [itemId, qty] of need) {
    const item = await getItem(db, itemId);
    const bal = await balanceOf(db, itemId, wh.id);
    if (bal < qty) {
      throw conflict(`สต็อกไม่พอสำหรับ "${item.name}" (${item.sku}) ในคลัง ${wh.code} — คงเหลือ ${bal} ${item.unit} แต่ต้องการ ${qty} ${item.unit}`);
    }
  }

  for (const line of data.lines) {
    const item = await getItem(db, line.item_id);
    const lineId = (await db.run(
      'INSERT INTO issue_lines (issue_id, item_id, qty, note) VALUES (@i, @it, @q, @n)',
      { i: issueId, it: item.id, q: line.qty, n: line.note ?? null },
    )).lastInsertRowid;
    const serials = await resolveSerials(db, item, line.serials, 'in_stock', line.qty, wh.id);

    if (serials.length) {
      for (const s of serials) {
        await db.run(
          "UPDATE serials SET status = 'issued', holder_id = @h, issued_at = @d, updated_at = NOW() WHERE id = @id",
          { h: emp.id, d: data.issue_date, id: s.id },
        );
        await addSerialEvent(db, {
          serial_id: s.id, doc_type: 'issue', doc_id: issueId, doc_no: docNo, line_id: lineId,
          event: 'issue', status_before: s.status, status_after: 'issued',
          holder_before: s.holder_id, holder_after: emp.id,
          wh_before: s.warehouse_id, wh_after: s.warehouse_id,
          event_date: data.issue_date, note: line.note ?? null,
        });
        await addMove(db, {
          item_id: item.id, warehouse_id: wh.id, serial_id: s.id, serial_no: s.serial_no, move_type: 'OUT', qty: -1,
          doc_type: 'issue', doc_id: issueId, doc_no: docNo, line_id: lineId,
          moved_at: data.issue_date, note: line.note ?? null, created_by: userId,
        });
      }
    } else {
      await addMove(db, {
        item_id: item.id, warehouse_id: wh.id, move_type: 'OUT', qty: -line.qty,
        doc_type: 'issue', doc_id: issueId, doc_no: docNo, line_id: lineId,
        moved_at: data.issue_date, note: line.note ?? null, created_by: userId,
      });
    }
  }
  await assertNotNegative(db, [...need.keys()].map((itemId) => ({ itemId, warehouseId: wh.id })));
  return { id: issueId, doc_no: docNo, warehouse_id: wh.id };
}

/* ------------------------------------------------------------
 *  รับคืนอุปกรณ์ (RETURN) — คืนเข้าคลังที่ระบุ (อาจต่างจากคลังที่เบิกไป)
 *  condition = 'good'  -> คืนเข้าคลัง (บวกยอด)
 *  condition = 'scrap' -> ชำรุด ไม่คืนเข้าคลัง (ไม่กระทบยอด, serial = scrapped)
 * ------------------------------------------------------------ */
export async function postReturn(db, data, userId = null) {
  const wh = await getWarehouse(db, data.warehouse_id);
  const emp = await db.get('SELECT * FROM employees WHERE id = @id', { id: data.employee_id });
  if (!emp) throw notFound(`ไม่พบพนักงานรหัส #${data.employee_id}`);

  const docNo = data.doc_no || await nextDocNo(db, 'return', data.return_date);
  const returnId = (await db.run(`
    INSERT INTO returns (doc_no, warehouse_id, return_date, employee_id, is_staff_id, note, status, created_by)
    VALUES (@doc_no, @wh, @d, @emp, @staff, @note, 'posted', @uid)
  `, {
    doc_no: docNo, wh: wh.id, d: data.return_date, emp: emp.id,
    staff: data.is_staff_id ?? null, note: data.note ?? null, uid: userId,
  })).lastInsertRowid;

  for (const line of data.lines) {
    const item = await getItem(db, line.item_id);
    const condition = line.condition === 'scrap' ? 'scrap' : 'good';
    const lineId = (await db.run(
      'INSERT INTO return_lines (return_id, item_id, qty, `condition`, note) VALUES (@r, @i, @q, @c, @n)',
      { r: returnId, i: item.id, q: line.qty, c: condition, n: line.note ?? null },
    )).lastInsertRowid;
    const serials = await resolveSerials(db, item, line.serials, 'issued', line.qty);

    if (serials.length) {
      for (const s of serials) {
        const statusAfter = condition === 'good' ? 'in_stock' : 'scrapped';
        await db.run(
          'UPDATE serials SET status = @st, holder_id = NULL, warehouse_id = @wh, received_at = @d, updated_at = NOW() WHERE id = @id',
          { st: statusAfter, wh: wh.id, d: data.return_date, id: s.id },
        );
        await addSerialEvent(db, {
          serial_id: s.id, doc_type: 'return', doc_id: returnId, doc_no: docNo, line_id: lineId,
          event: condition === 'good' ? 'return' : 'scrap',
          status_before: s.status, status_after: statusAfter,
          holder_before: s.holder_id, holder_after: null,
          wh_before: s.warehouse_id, wh_after: wh.id,
          event_date: data.return_date, note: line.note ?? null,
        });
        // ของชำรุด (scrap) ไม่กลับเข้าคลัง จึงไม่บันทึกรายการเดินสต็อก
        if (condition === 'good') {
          await addMove(db, {
            item_id: item.id, warehouse_id: wh.id, serial_id: s.id, serial_no: s.serial_no, move_type: 'RETURN', qty: 1,
            doc_type: 'return', doc_id: returnId, doc_no: docNo, line_id: lineId,
            moved_at: data.return_date, note: line.note ?? null, created_by: userId,
          });
        }
      }
    } else if (condition === 'good') {
      await addMove(db, {
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
export async function postAdjustment(db, data, userId = null) {
  const wh = await getWarehouse(db, data.warehouse_id);
  const docNo = data.doc_no || await nextDocNo(db, 'adjustment', data.adjust_date);
  const adjId = (await db.run(`
    INSERT INTO adjustments (doc_no, warehouse_id, adjust_date, reason, note, status, created_by)
    VALUES (@doc_no, @wh, @d, @reason, @note, 'posted', @uid)
  `, {
    doc_no: docNo, wh: wh.id, d: data.adjust_date,
    reason: data.reason || 'count', note: data.note ?? null, uid: userId,
  })).lastInsertRowid;

  const touched = [];
  for (const line of data.lines) {
    const item = await getItem(db, line.item_id);
    if (item.track_serial) {
      throw badRequest(`อุปกรณ์ "${item.name}" ติดตามด้วย Serial จึงต้องปรับปรุงผ่านเอกสารรับเข้า/รับคืนแทน`);
    }
    const lineId = (await db.run(
      'INSERT INTO adjustment_lines (adjustment_id, item_id, qty_diff, note) VALUES (@a, @i, @q, @n)',
      { a: adjId, i: item.id, q: line.qty_diff, n: line.note ?? null },
    )).lastInsertRowid;
    await addMove(db, {
      item_id: item.id, warehouse_id: wh.id, move_type: 'ADJUST', qty: line.qty_diff,
      doc_type: 'adjustment', doc_id: adjId, doc_no: docNo, line_id: lineId,
      moved_at: data.adjust_date, note: line.note ?? null, created_by: userId,
    });
    touched.push({ itemId: item.id, warehouseId: wh.id });
  }
  await assertNotNegative(db, touched);
  return { id: adjId, doc_no: docNo, warehouse_id: wh.id };
}

/* ------------------------------------------------------------
 *  โอนย้ายระหว่างคลัง (TRANSFER)
 * ------------------------------------------------------------ */
export async function postTransfer(db, data, userId = null) {
  const from = await getWarehouse(db, data.from_warehouse_id);
  const to = await getWarehouse(db, data.to_warehouse_id);
  if (from.id === to.id) throw badRequest('คลังต้นทางและคลังปลายทางต้องไม่ใช่คลังเดียวกัน');

  const docNo = data.doc_no || await nextDocNo(db, 'transfer', data.transfer_date);
  const transferId = (await db.run(`
    INSERT INTO transfers (doc_no, transfer_date, from_warehouse_id, to_warehouse_id, note, status, created_by)
    VALUES (@doc_no, @d, @from, @to, @note, 'posted', @uid)
  `, { doc_no: docNo, d: data.transfer_date, from: from.id, to: to.id, note: data.note ?? null, uid: userId }))
    .lastInsertRowid;

  // ตรวจยอดคงเหลือของคลังต้นทางแบบรวมทุกบรรทัดก่อน
  const need = new Map();
  for (const line of data.lines) need.set(line.item_id, (need.get(line.item_id) || 0) + line.qty);
  for (const [itemId, qty] of need) {
    const item = await getItem(db, itemId);
    const bal = await balanceOf(db, itemId, from.id);
    if (bal < qty) {
      throw conflict(`สต็อกไม่พอสำหรับ "${item.name}" (${item.sku}) ในคลังต้นทาง ${from.code} — คงเหลือ ${bal} ${item.unit} แต่ต้องการโอน ${qty} ${item.unit}`);
    }
  }

  for (const line of data.lines) {
    const item = await getItem(db, line.item_id);
    const lineId = (await db.run(
      'INSERT INTO transfer_lines (transfer_id, item_id, qty, note) VALUES (@t, @i, @q, @n)',
      { t: transferId, i: item.id, q: line.qty, n: line.note ?? null },
    )).lastInsertRowid;
    const serials = await resolveSerials(db, item, line.serials, 'in_stock', line.qty, from.id);

    const emit = async (serial) => {
      const common = {
        item_id: item.id, serial_id: serial?.id ?? null, serial_no: serial?.serial_no ?? null,
        move_type: 'TRANSFER', doc_type: 'transfer', doc_id: transferId, doc_no: docNo, line_id: lineId,
        moved_at: data.transfer_date, note: line.note ?? null, created_by: userId,
      };
      const qty = serial ? 1 : line.qty;
      await addMove(db, { ...common, warehouse_id: from.id, qty: -qty });
      await addMove(db, { ...common, warehouse_id: to.id, qty });
    };

    if (serials.length) {
      for (const s of serials) {
        await db.run('UPDATE serials SET warehouse_id = @wh, updated_at = NOW() WHERE id = @id', { wh: to.id, id: s.id });
        await addSerialEvent(db, {
          serial_id: s.id, doc_type: 'transfer', doc_id: transferId, doc_no: docNo, line_id: lineId,
          event: 'transfer', status_before: s.status, status_after: s.status,
          holder_before: s.holder_id, holder_after: s.holder_id,
          wh_before: from.id, wh_after: to.id,
          event_date: data.transfer_date, note: line.note ?? null,
        });
        await emit(s);
      }
    } else {
      await emit(null);
    }
  }
  await assertNotNegative(db, [...need.keys()].map((itemId) => ({ itemId, warehouseId: from.id })));
  return { id: transferId, doc_no: docNo, from_warehouse_id: from.id, to_warehouse_id: to.id };
}

/* ------------------------------------------------------------
 *  ยกเลิกเอกสาร (VOID) ด้วยการกลับรายการในบัญชีเดินสต็อก
 * ------------------------------------------------------------ */
export async function voidDocument(db, docType, docId, reason, userId = null) {
  const cfg = docConfig(docType);
  const doc = await db.get(`SELECT * FROM ${cfg.table} WHERE id = @id`, { id: docId });
  if (!doc) throw notFound('ไม่พบเอกสารที่ต้องการยกเลิก');
  if (doc.status === 'void') throw conflict(`เอกสาร ${doc.doc_no} ถูกยกเลิกไปแล้ว`);

  const moves = await db.all(
    'SELECT * FROM stock_moves WHERE doc_type = @dt AND doc_id = @di ORDER BY id', { dt: docType, di: docId },
  );
  const events = await db.all(
    'SELECT * FROM serial_events WHERE doc_type = @dt AND doc_id = @di AND reversed = 0 ORDER BY id',
    { dt: docType, di: docId },
  );
  const voidedAt = new Date().toISOString().slice(0, 10);

  // --- ตรวจเงื่อนไขทั้งหมดก่อน แล้วจึงเริ่มเขียนข้อมูล ---
  for (const ev of events) await assertNoLaterSerialEvents(db, ev.serial_id, docType, docId);
  if (docType === 'receipt') {
    const created = await db.all('SELECT * FROM serials WHERE receipt_id = @id', { id: docId });
    for (const sr of created) {
      if (sr.status !== 'in_stock') {
        throw conflict(`Serial "${sr.serial_no}" ไม่ได้อยู่ในคลังแล้ว จึงยกเลิกใบรับเข้านี้ไม่ได้`);
      }
    }
  }

  // --- กลับรายการในบัญชีเดินสต็อก (คงคลังเดิมของแต่ละรายการไว้) ---
  const touched = [];
  for (const mv of moves) {
    await addMove(db, {
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
  for (const ev of [...events].reverse()) {
    if (ev.event === 'receive') continue; // serial เกิดจากเอกสารนี้ เดี๋ยวลบทิ้งด้านล่าง
    await db.run(
      'UPDATE serials SET status = @st, holder_id = @h, warehouse_id = COALESCE(@wh, warehouse_id), updated_at = NOW() WHERE id = @id',
      { st: ev.status_before, h: ev.holder_before, wh: ev.wh_before ?? null, id: ev.serial_id },
    );
  }
  await db.run(
    'UPDATE serial_events SET reversed = 1 WHERE doc_type = @dt AND doc_id = @di AND reversed = 0',
    { dt: docType, di: docId },
  );

  // --- ใบรับเข้า: ลบ serial ที่สร้างจากเอกสารนี้ เพื่อให้คีย์เลขเดิมใหม่ได้ ---
  if (docType === 'receipt') {
    await db.run(
      'UPDATE stock_moves SET serial_id = NULL WHERE serial_id IN (SELECT id FROM (SELECT id FROM serials WHERE receipt_id = @id) AS s)',
      { id: docId },
    );
    await db.run('DELETE FROM serials WHERE receipt_id = @id', { id: docId });
  }

  await db.run(
    `UPDATE ${cfg.table} SET status = 'void', voided_by = @uid, voided_at = NOW(), void_reason = @reason WHERE id = @id`,
    { uid: userId, reason: reason ?? null, id: docId },
  );

  await assertNotNegative(db, touched);
  return { id: docId, doc_no: doc.doc_no, status: 'void' };
}

/** ไทม์ไลน์การใช้งานของ Serial หนึ่งชิ้น */
export async function serialTimeline(db, serialId) {
  return db.all(`
    SELECT e.*,
           emp_b.name AS holder_before_name, emp_a.name AS holder_after_name,
           wb.code AS wh_before_code, wa.code AS wh_after_code
    FROM serial_events e
    LEFT JOIN employees emp_b ON emp_b.id = e.holder_before
    LEFT JOIN employees emp_a ON emp_a.id = e.holder_after
    LEFT JOIN warehouses wb ON wb.id = e.wh_before
    LEFT JOIN warehouses wa ON wa.id = e.wh_after
    WHERE e.serial_id = @id
    ORDER BY e.id
  `, { id: serialId });
}
