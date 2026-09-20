import { Router } from 'express';
import { arr, bool, date, int, num, oneOf, str } from '../lib/validate.js';
import { badRequest, notFound, wrap } from '../lib/http.js';
import { requireRole } from '../lib/auth.js';
import { logAudit } from '../lib/audit.js';
import { docConfig, postAdjustment, postIssue, postReceipt, postReturn, voidDocument } from '../services/stock.js';

/** เงื่อนไขกรองที่ใช้ร่วมกันทุกเอกสาร: ช่วงวันที่ สถานะ และคำค้น */
function buildFilters(req, dateCol, searchCols) {
  const where = [];
  const params = {};
  if (req.query.from) { where.push(`d.${dateCol} >= @from`); params.from = date(req.query.from, 'ตั้งแต่วันที่'); }
  if (req.query.to) { where.push(`d.${dateCol} <= @to`); params.to = date(req.query.to, 'ถึงวันที่'); }
  if (req.query.status) { where.push('d.status = @status'); params.status = oneOf(req.query.status, 'สถานะ', ['posted', 'void']); }
  if (req.query.q) {
    where.push(`(${searchCols.map((c) => `${c} LIKE @q`).join(' OR ')})`);
    params.q = `%${req.query.q}%`;
  }
  return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

function paginate(req) {
  return {
    limit: int(req.query.per_page, 'per_page', { required: false, def: 50, min: 1, max: 500 }),
    page: int(req.query.page, 'page', { required: false, def: 1, min: 1 }),
  };
}

/** อ่านบรรทัดรายการจาก body พร้อมตรวจความถูกต้อง */
function parseLines(body, kind) {
  const lines = arr(body.lines, 'รายการอุปกรณ์');
  return lines.map((l, idx) => {
    const n = idx + 1;
    const base = {
      item_id: int(l.item_id, `อุปกรณ์ในบรรทัดที่ ${n}`),
      note: str(l.note, `หมายเหตุบรรทัดที่ ${n}`, { required: false, max: 500 }),
      serials: Array.isArray(l.serials) ? l.serials : [],
    };
    if (kind === 'adjustment') {
      const diff = int(l.qty_diff, `จำนวนที่ปรับในบรรทัดที่ ${n}`);
      if (diff === 0) throw badRequest(`จำนวนที่ปรับในบรรทัดที่ ${n} ต้องไม่เท่ากับ 0 (ใส่ค่าบวกเพื่อเพิ่ม หรือค่าลบเพื่อลด)`);
      return { ...base, qty_diff: diff };
    }
    const out = { ...base, qty: int(l.qty, `จำนวนในบรรทัดที่ ${n}`, { min: 1 }) };
    if (kind === 'receipt') out.unit_cost = num(l.unit_cost, `ราคาต่อหน่วยบรรทัดที่ ${n}`, { required: false, def: 0, min: 0 });
    if (kind === 'return') out.condition = oneOf(l.condition, `สภาพของบรรทัดที่ ${n}`, ['good', 'scrap'], { required: false, def: 'good' });
    return out;
  });
}

export function documentRoutes(db) {
  const router = Router();

  /* ================= ใบรับเข้า (IN) ================= */
  const receipts = Router();

  receipts.get('/', wrap((req, res) => {
    const { clause, params } = buildFilters(req, 'receive_date', ['d.doc_no', 'd.po_no', 'd.note', 's.name']);
    const base = `FROM receipts d
      LEFT JOIN suppliers s ON s.id = d.supplier_id
      LEFT JOIN users u ON u.id = d.created_by
      ${clause}`;
    const total = db.prepare(`SELECT COUNT(*) AS n ${base}`).get(params).n;
    const { limit, page } = paginate(req);
    const data = db.prepare(`
      SELECT d.*, s.name AS supplier_name, u.full_name AS created_by_name,
             (SELECT COALESCE(SUM(qty), 0) FROM receipt_lines WHERE receipt_id = d.id) AS total_qty,
             (SELECT COUNT(*) FROM receipt_lines WHERE receipt_id = d.id)               AS line_count,
             (SELECT COALESCE(SUM(qty * unit_cost), 0) FROM receipt_lines WHERE receipt_id = d.id) AS total_cost
      ${base}
      ORDER BY d.receive_date DESC, d.id DESC LIMIT @limit OFFSET @offset
    `).all({ ...params, limit, offset: (page - 1) * limit });
    res.json({ data, total, page, per_page: limit });
  }));

  receipts.get('/:id', wrap((req, res) => {
    const id = int(req.params.id, 'id');
    const doc = db.prepare(`
      SELECT d.*, s.name AS supplier_name, u.full_name AS created_by_name, v.full_name AS voided_by_name
      FROM receipts d
      LEFT JOIN suppliers s ON s.id = d.supplier_id
      LEFT JOIN users u ON u.id = d.created_by
      LEFT JOIN users v ON v.id = d.voided_by
      WHERE d.id = ?
    `).get(id);
    if (!doc) throw notFound('ไม่พบใบรับเข้า');
    doc.lines = db.prepare(`
      SELECT l.*, i.sku, i.name AS item_name, i.unit, i.track_serial, c.name AS category_name,
             (SELECT GROUP_CONCAT(m.serial_no, ', ') FROM stock_moves m
               WHERE m.line_id = l.id AND m.doc_type = 'receipt' AND m.doc_id = d.id AND m.move_type = 'IN') AS serial_list
      FROM receipt_lines l
      JOIN items i ON i.id = l.item_id
      JOIN categories c ON c.id = i.category_id
      JOIN receipts d ON d.id = l.receipt_id
      WHERE l.receipt_id = ? ORDER BY l.id
    `).all(id);
    res.json(doc);
  }));

  receipts.post('/', requireRole('officer'), wrap((req, res) => {
    const data = {
      receive_date: date(req.body.receive_date, 'วันที่รับเข้า'),
      po_no: str(req.body.po_no, 'เลขที่ PO', { required: false, max: 60 }),
      supplier_id: int(req.body.supplier_id, 'ผู้ขาย', { required: false, def: null }),
      note: str(req.body.note, 'หมายเหตุ', { required: false, max: 500 }),
      lines: parseLines(req.body, 'receipt'),
    };
    const out = db.transaction(() => postReceipt(db, data, req.user?.id ?? null))();
    logAudit(db, req, 'post', 'receipt', out.id, `รับเข้า ${out.doc_no}`);
    res.status(201).json(out);
  }));

  /* ================= ใบเบิกออก (OUT) ================= */
  const issues = Router();

  issues.get('/', wrap((req, res) => {
    const { clause, params } = buildFilters(req, 'issue_date', ['d.doc_no', 'd.remark', 'e.name', 'e.emp_code']);
    const extra = [];
    if (req.query.employee_id) { extra.push('d.employee_id = @employee_id'); params.employee_id = Number(req.query.employee_id); }
    if (req.query.charge === '0' || req.query.charge === '1') { extra.push('d.charge = @charge'); params.charge = Number(req.query.charge); }
    const full = extra.length ? `${clause ? `${clause} AND ` : 'WHERE '}${extra.join(' AND ')}` : clause;
    const base = `
      FROM issues d
      JOIN employees e ON e.id = d.employee_id
      LEFT JOIN departments dp ON dp.id = e.department_id
      LEFT JOIN is_staff st ON st.id = d.is_staff_id
      ${full}`;
    const total = db.prepare(`SELECT COUNT(*) AS n ${base}`).get(params).n;
    const { limit, page } = paginate(req);
    const data = db.prepare(`
      SELECT d.*, e.name AS employee_name, e.emp_code, dp.name AS department_name,
             st.name AS is_staff_name,
             (SELECT COALESCE(SUM(qty), 0) FROM issue_lines WHERE issue_id = d.id) AS total_qty,
             (SELECT COUNT(*) FROM issue_lines WHERE issue_id = d.id)              AS line_count
      ${base}
      ORDER BY d.issue_date DESC, d.id DESC LIMIT @limit OFFSET @offset
    `).all({ ...params, limit, offset: (page - 1) * limit });
    res.json({ data, total, page, per_page: limit });
  }));

  issues.get('/:id', wrap((req, res) => {
    const id = int(req.params.id, 'id');
    const doc = db.prepare(`
      SELECT d.*, e.name AS employee_name, e.emp_code, dp.name AS department_name,
             st.name AS is_staff_name, u.full_name AS created_by_name, v.full_name AS voided_by_name
      FROM issues d
      JOIN employees e ON e.id = d.employee_id
      LEFT JOIN departments dp ON dp.id = e.department_id
      LEFT JOIN is_staff st ON st.id = d.is_staff_id
      LEFT JOIN users u ON u.id = d.created_by
      LEFT JOIN users v ON v.id = d.voided_by
      WHERE d.id = ?
    `).get(id);
    if (!doc) throw notFound('ไม่พบใบเบิก');
    doc.lines = db.prepare(`
      SELECT l.*, i.sku, i.name AS item_name, i.unit, i.track_serial, c.name AS category_name, c.kind AS category_kind,
             (SELECT GROUP_CONCAT(m.serial_no, ', ') FROM stock_moves m
               WHERE m.line_id = l.id AND m.doc_type = 'issue' AND m.doc_id = l.issue_id AND m.move_type = 'OUT') AS serial_list
      FROM issue_lines l
      JOIN items i ON i.id = l.item_id
      JOIN categories c ON c.id = i.category_id
      WHERE l.issue_id = ? ORDER BY l.id
    `).all(id);
    res.json(doc);
  }));

  issues.post('/', requireRole('officer'), wrap((req, res) => {
    const data = {
      issue_date: date(req.body.issue_date, 'วันที่เบิก'),
      employee_id: int(req.body.employee_id, 'ผู้เบิก'),
      is_staff_id: int(req.body.is_staff_id, 'เจ้าหน้าที่ IS', { required: false, def: null }),
      charge: bool(req.body.charge, true),
      remark: str(req.body.remark, 'หมายเหตุ', { required: false, max: 500 }),
      lines: parseLines(req.body, 'issue'),
    };
    const out = db.transaction(() => postIssue(db, data, req.user?.id ?? null))();
    logAudit(db, req, 'post', 'issue', out.id, `เบิกออก ${out.doc_no}`);
    res.status(201).json(out);
  }));

  /* ================= ใบรับคืน (RETURN) ================= */
  const returns = Router();

  returns.get('/', wrap((req, res) => {
    const { clause, params } = buildFilters(req, 'return_date', ['d.doc_no', 'd.note', 'e.name', 'e.emp_code']);
    const base = `
      FROM returns d
      JOIN employees e ON e.id = d.employee_id
      LEFT JOIN departments dp ON dp.id = e.department_id
      LEFT JOIN is_staff st ON st.id = d.is_staff_id
      ${clause}`;
    const total = db.prepare(`SELECT COUNT(*) AS n ${base}`).get(params).n;
    const { limit, page } = paginate(req);
    const data = db.prepare(`
      SELECT d.*, e.name AS employee_name, e.emp_code, dp.name AS department_name, st.name AS is_staff_name,
             (SELECT COALESCE(SUM(qty), 0) FROM return_lines WHERE return_id = d.id) AS total_qty,
             (SELECT COUNT(*) FROM return_lines WHERE return_id = d.id)              AS line_count
      ${base} ORDER BY d.return_date DESC, d.id DESC LIMIT @limit OFFSET @offset
    `).all({ ...params, limit, offset: (page - 1) * limit });
    res.json({ data, total, page, per_page: limit });
  }));

  returns.get('/:id', wrap((req, res) => {
    const id = int(req.params.id, 'id');
    const doc = db.prepare(`
      SELECT d.*, e.name AS employee_name, e.emp_code, dp.name AS department_name,
             st.name AS is_staff_name, u.full_name AS created_by_name, v.full_name AS voided_by_name
      FROM returns d
      JOIN employees e ON e.id = d.employee_id
      LEFT JOIN departments dp ON dp.id = e.department_id
      LEFT JOIN is_staff st ON st.id = d.is_staff_id
      LEFT JOIN users u ON u.id = d.created_by
      LEFT JOIN users v ON v.id = d.voided_by
      WHERE d.id = ?
    `).get(id);
    if (!doc) throw notFound('ไม่พบใบรับคืน');
    doc.lines = db.prepare(`
      SELECT l.*, i.sku, i.name AS item_name, i.unit, i.track_serial, c.name AS category_name,
             (SELECT GROUP_CONCAT(se.serial_no, ', ') FROM serial_events ev
                JOIN serials se ON se.id = ev.serial_id
               WHERE ev.line_id = l.id AND ev.doc_type = 'return' AND ev.doc_id = l.return_id) AS serial_list
      FROM return_lines l
      JOIN items i ON i.id = l.item_id
      JOIN categories c ON c.id = i.category_id
      WHERE l.return_id = ? ORDER BY l.id
    `).all(id);
    res.json(doc);
  }));

  returns.post('/', requireRole('officer'), wrap((req, res) => {
    const data = {
      return_date: date(req.body.return_date, 'วันที่รับคืน'),
      employee_id: int(req.body.employee_id, 'ผู้คืน'),
      is_staff_id: int(req.body.is_staff_id, 'เจ้าหน้าที่ IS', { required: false, def: null }),
      note: str(req.body.note, 'หมายเหตุ', { required: false, max: 500 }),
      lines: parseLines(req.body, 'return'),
    };
    const out = db.transaction(() => postReturn(db, data, req.user?.id ?? null))();
    logAudit(db, req, 'post', 'return', out.id, `รับคืน ${out.doc_no}`);
    res.status(201).json(out);
  }));

  /* ================= ใบปรับปรุงสต็อก (ADJUST) ================= */
  const adjustments = Router();

  adjustments.get('/', wrap((req, res) => {
    const { clause, params } = buildFilters(req, 'adjust_date', ['d.doc_no', 'd.note']);
    const base = `FROM adjustments d LEFT JOIN users u ON u.id = d.created_by ${clause}`;
    const total = db.prepare(`SELECT COUNT(*) AS n ${base}`).get(params).n;
    const { limit, page } = paginate(req);
    const data = db.prepare(`
      SELECT d.*, u.full_name AS created_by_name,
             (SELECT COUNT(*) FROM adjustment_lines WHERE adjustment_id = d.id) AS line_count,
             (SELECT COALESCE(SUM(qty_diff), 0) FROM adjustment_lines WHERE adjustment_id = d.id) AS net_qty
      ${base}
      ORDER BY d.adjust_date DESC, d.id DESC LIMIT @limit OFFSET @offset
    `).all({ ...params, limit, offset: (page - 1) * limit });
    res.json({ data, total, page, per_page: limit });
  }));

  adjustments.get('/:id', wrap((req, res) => {
    const id = int(req.params.id, 'id');
    const doc = db.prepare(`
      SELECT d.*, u.full_name AS created_by_name, v.full_name AS voided_by_name
      FROM adjustments d
      LEFT JOIN users u ON u.id = d.created_by
      LEFT JOIN users v ON v.id = d.voided_by
      WHERE d.id = ?
    `).get(id);
    if (!doc) throw notFound('ไม่พบใบปรับปรุง');
    doc.lines = db.prepare(`
      SELECT l.*, i.sku, i.name AS item_name, i.unit, c.name AS category_name
      FROM adjustment_lines l
      JOIN items i ON i.id = l.item_id
      JOIN categories c ON c.id = i.category_id
      WHERE l.adjustment_id = ? ORDER BY l.id
    `).all(id);
    res.json(doc);
  }));

  adjustments.post('/', requireRole('officer'), wrap((req, res) => {
    const data = {
      adjust_date: date(req.body.adjust_date, 'วันที่ปรับปรุง'),
      reason: oneOf(req.body.reason, 'สาเหตุ', ['count', 'damaged', 'lost', 'found', 'other'], { required: false, def: 'count' }),
      note: str(req.body.note, 'หมายเหตุ', { required: false, max: 500 }),
      lines: parseLines(req.body, 'adjustment'),
    };
    const out = db.transaction(() => postAdjustment(db, data, req.user?.id ?? null))();
    logAudit(db, req, 'post', 'adjustment', out.id, `ปรับปรุง ${out.doc_no}`);
    res.status(201).json(out);
  }));

  /* ================= ยกเลิกเอกสาร (ใช้ร่วมกันทุกประเภท) ================= */
  for (const [type, r] of [['receipt', receipts], ['issue', issues], ['return', returns], ['adjustment', adjustments]]) {
    r.post('/:id/void', requireRole('officer'), wrap((req, res) => {
      const id = int(req.params.id, 'id');
      const reason = str(req.body?.reason, 'เหตุผลการยกเลิก', { required: false, max: 300 });
      docConfig(type);
      const out = db.transaction(() => voidDocument(db, type, id, reason, req.user?.id ?? null))();
      logAudit(db, req, 'void', type, id, `ยกเลิก ${out.doc_no}${reason ? ` — ${reason}` : ''}`);
      res.json(out);
    }));
  }

  router.use('/receipts', receipts);
  router.use('/issues', issues);
  router.use('/returns', returns);
  router.use('/adjustments', adjustments);
  return router;
}
