import { Router } from 'express';
import { crudRouter, activeField } from './crud.js';
import { bool, int, num, oneOf, str } from '../lib/validate.js';
import { notFound, wrap } from '../lib/http.js';
import { requireRole } from '../lib/auth.js';
import { serialTimeline } from '../services/stock.js';

export function masterRoutes(db) {
  const router = Router();

  /* ---------------- หมวดหมู่อุปกรณ์ ---------------- */
  router.use('/categories', crudRouter(db, {
    table: 'categories',
    label: 'หมวดหมู่',
    searchCols: ['code', 'name'],
    orderBy: 'sort_order, name COLLATE NOCASE',
    references: [{ table: 'items', column: 'category_id', label: 'อุปกรณ์' }],
    parse: (b, { isUpdate }) => ({
      ...(isUpdate && b.code === undefined ? {} : { code: str(b.code, 'รหัสหมวดหมู่', { max: 30 }) }),
      ...(isUpdate && b.name === undefined ? {} : { name: str(b.name, 'ชื่อหมวดหมู่', { max: 120 }) }),
      ...(isUpdate && b.kind === undefined ? {} : {
        kind: oneOf(b.kind, 'ประเภทคอลัมน์', ['desktop', 'laptop', 'accessory', 'other'], { required: false, def: 'other' }),
      }),
      ...(isUpdate && b.sort_order === undefined ? {} : {
        sort_order: int(b.sort_order, 'ลำดับ', { required: false, def: 100, min: 0 }),
      }),
      ...activeField(b, isUpdate),
    }),
  }));

  /* ---------------- แผนก ---------------- */
  router.use('/departments', crudRouter(db, {
    table: 'departments',
    label: 'แผนก',
    searchCols: ['code', 'name'],
    references: [{ table: 'employees', column: 'department_id', label: 'พนักงาน' }],
    parse: (b, { isUpdate }) => ({
      ...(isUpdate && b.code === undefined ? {} : { code: str(b.code, 'รหัสแผนก', { max: 30 }) }),
      ...(isUpdate && b.name === undefined ? {} : { name: str(b.name, 'ชื่อแผนก', { max: 120 }) }),
      ...activeField(b, isUpdate),
    }),
  }));

  /* ---------------- พนักงาน (ผู้เบิก) ---------------- */
  router.use('/employees', crudRouter(db, {
    table: 'employees',
    label: 'พนักงาน',
    searchCols: ['emp_code', 'name', 'department_name'],
    orderBy: 't.emp_code COLLATE NOCASE',
    selectSql: `
      SELECT e.*, d.name AS department_name, d.code AS department_code
      FROM employees e LEFT JOIN departments d ON d.id = e.department_id
    `,
    references: [
      { table: 'issues', column: 'employee_id', label: 'ใบเบิก' },
      { table: 'returns', column: 'employee_id', label: 'ใบรับคืน' },
      { table: 'serials', column: 'holder_id', label: 'ทรัพย์สินที่ถืออยู่' },
    ],
    parse: (b, { isUpdate }) => ({
      ...(isUpdate && b.emp_code === undefined ? {} : { emp_code: str(b.emp_code, 'รหัสพนักงาน', { max: 40 }) }),
      ...(isUpdate && b.name === undefined ? {} : { name: str(b.name, 'ชื่อพนักงาน', { max: 160 }) }),
      ...(isUpdate && b.department_id === undefined ? {} : {
        department_id: int(b.department_id, 'แผนก', { required: false, def: null }),
      }),
      ...(isUpdate && b.position === undefined ? {} : { position: str(b.position, 'ตำแหน่ง', { required: false, max: 120 }) }),
      ...(isUpdate && b.email === undefined ? {} : { email: str(b.email, 'อีเมล', { required: false, max: 160 }) }),
      ...(isUpdate && b.phone === undefined ? {} : { phone: str(b.phone, 'โทรศัพท์', { required: false, max: 60 }) }),
      ...activeField(b, isUpdate),
    }),
  }));

  /* ---------------- เจ้าหน้าที่ IS (ผู้จ่ายของ) ---------------- */
  router.use('/is-staff', crudRouter(db, {
    table: 'is_staff',
    label: 'เจ้าหน้าที่ IS',
    searchCols: ['name'],
    references: [
      { table: 'issues', column: 'is_staff_id', label: 'ใบเบิก' },
      { table: 'returns', column: 'is_staff_id', label: 'ใบรับคืน' },
    ],
    parse: (b, { isUpdate }) => ({
      ...(isUpdate && b.name === undefined ? {} : { name: str(b.name, 'ชื่อเจ้าหน้าที่', { max: 120 }) }),
      ...(isUpdate && b.email === undefined ? {} : { email: str(b.email, 'อีเมล', { required: false, max: 160 }) }),
      ...activeField(b, isUpdate),
    }),
  }));

  /* ---------------- ผู้ขาย ---------------- */
  router.use('/suppliers', crudRouter(db, {
    table: 'suppliers',
    label: 'ผู้ขาย',
    searchCols: ['code', 'name', 'contact'],
    references: [{ table: 'receipts', column: 'supplier_id', label: 'ใบรับเข้า' }],
    parse: (b, { isUpdate }) => ({
      ...(isUpdate && b.code === undefined ? {} : { code: str(b.code, 'รหัสผู้ขาย', { max: 40 }) }),
      ...(isUpdate && b.name === undefined ? {} : { name: str(b.name, 'ชื่อผู้ขาย', { max: 160 }) }),
      ...(isUpdate && b.contact === undefined ? {} : { contact: str(b.contact, 'ผู้ติดต่อ', { required: false, max: 160 }) }),
      ...(isUpdate && b.phone === undefined ? {} : { phone: str(b.phone, 'โทรศัพท์', { required: false, max: 60 }) }),
      ...(isUpdate && b.email === undefined ? {} : { email: str(b.email, 'อีเมล', { required: false, max: 160 }) }),
      ...activeField(b, isUpdate),
    }),
  }));

  /* ---------------- อุปกรณ์ ---------------- */
  const itemsRouter = crudRouter(db, {
    table: 'items',
    label: 'อุปกรณ์',
    searchCols: ['sku', 'name', 'brand', 'model', 'category_name'],
    orderBy: 't.name COLLATE NOCASE',
    selectSql: 'SELECT * FROM v_stock_balance',
    references: [
      { table: 'receipt_lines', column: 'item_id', label: 'บรรทัดใบรับเข้า' },
      { table: 'issue_lines', column: 'item_id', label: 'บรรทัดใบเบิก' },
      { table: 'stock_moves', column: 'item_id', label: 'รายการเดินสต็อก' },
    ],
    parse: (b, { isUpdate }) => ({
      ...(isUpdate && b.sku === undefined ? {} : { sku: str(b.sku, 'รหัสอุปกรณ์ (SKU)', { max: 60 }) }),
      ...(isUpdate && b.name === undefined ? {} : { name: str(b.name, 'ชื่ออุปกรณ์', { max: 200 }) }),
      ...(isUpdate && b.category_id === undefined ? {} : { category_id: int(b.category_id, 'หมวดหมู่') }),
      ...(isUpdate && b.brand === undefined ? {} : { brand: str(b.brand, 'ยี่ห้อ', { required: false, max: 80 }) }),
      ...(isUpdate && b.model === undefined ? {} : { model: str(b.model, 'รุ่น', { required: false, max: 120 }) }),
      ...(isUpdate && b.unit === undefined ? {} : { unit: str(b.unit, 'หน่วยนับ', { required: false, max: 20 }) || 'EA' }),
      ...(isUpdate && b.track_serial === undefined ? {} : { track_serial: bool(b.track_serial, false) ? 1 : 0 }),
      ...(isUpdate && b.min_qty === undefined ? {} : { min_qty: int(b.min_qty, 'จุดสั่งซื้อขั้นต่ำ', { required: false, def: 0, min: 0 }) }),
      ...(isUpdate && b.unit_cost === undefined ? {} : { unit_cost: num(b.unit_cost, 'ราคาต่อหน่วย', { required: false, def: 0, min: 0 }) }),
      ...(isUpdate && b.location === undefined ? {} : { location: str(b.location, 'ที่จัดเก็บ', { required: false, max: 120 }) }),
      ...(isUpdate && b.note === undefined ? {} : { note: str(b.note, 'หมายเหตุ', { required: false, max: 500 }) }),
      ...activeField(b, isUpdate),
      ...(isUpdate ? { updated_at: new Date().toISOString().slice(0, 19).replace('T', ' ') } : {}),
    }),
  });

  // Serial ทั้งหมดของอุปกรณ์หนึ่งรายการ
  itemsRouter.get('/:id/serials', wrap((req, res) => {
    const id = int(req.params.id, 'id');
    const status = req.query.status;
    const rows = db.prepare(`
      SELECT s.*, e.name AS holder_name, e.emp_code AS holder_code, d.name AS holder_dept
      FROM serials s
      LEFT JOIN employees e ON e.id = s.holder_id
      LEFT JOIN departments d ON d.id = e.department_id
      WHERE s.item_id = @item_id ${status ? 'AND s.status = @status' : ''}
      ORDER BY s.serial_no COLLATE NOCASE
    `).all(status ? { item_id: id, status } : { item_id: id });
    res.json({ data: rows });
  }));

  router.use('/items', itemsRouter);

  /* ---------------- Serial (ค้นหา / ไทม์ไลน์) ---------------- */
  const serials = Router();

  serials.get('/', wrap((req, res) => {
    const where = [];
    const params = {};
    if (req.query.q) { where.push('(s.serial_no LIKE @q OR i.name LIKE @q OR i.sku LIKE @q OR e.name LIKE @q)'); params.q = `%${req.query.q}%`; }
    if (req.query.status) { where.push('s.status = @status'); params.status = req.query.status; }
    if (req.query.item_id) { where.push('s.item_id = @item_id'); params.item_id = Number(req.query.item_id); }
    if (req.query.holder_id) { where.push('s.holder_id = @holder_id'); params.holder_id = Number(req.query.holder_id); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const base = `
      FROM serials s
      JOIN items i ON i.id = s.item_id
      LEFT JOIN employees e ON e.id = s.holder_id
      LEFT JOIN departments d ON d.id = e.department_id
      ${clause}`;
    const total = db.prepare(`SELECT COUNT(*) AS n ${base}`).get(params).n;
    const perPage = int(req.query.per_page, 'per_page', { required: false, def: 100, min: 1, max: 1000 });
    const page = int(req.query.page, 'page', { required: false, def: 1, min: 1 });
    const data = db.prepare(`
      SELECT s.*, i.sku, i.name AS item_name, i.unit,
             e.name AS holder_name, e.emp_code AS holder_code, d.name AS holder_dept
      ${base}
      ORDER BY s.status, s.serial_no COLLATE NOCASE
      LIMIT @limit OFFSET @offset
    `).all({ ...params, limit: perPage, offset: (page - 1) * perPage });
    res.json({ data, total, page, per_page: perPage });
  }));

  serials.get('/:id', wrap((req, res) => {
    const id = int(req.params.id, 'id');
    const row = db.prepare(`
      SELECT s.*, i.sku, i.name AS item_name, e.name AS holder_name, e.emp_code AS holder_code
      FROM serials s JOIN items i ON i.id = s.item_id
      LEFT JOIN employees e ON e.id = s.holder_id
      WHERE s.id = ?
    `).get(id);
    if (!row) throw notFound('ไม่พบ Serial ที่ระบุ');
    res.json({ ...row, timeline: serialTimeline(db, id) });
  }));

  // แก้ไขหมายเหตุ / ตัดจำหน่าย Serial ที่อยู่ในคลัง
  serials.put('/:id', requireRole('officer'), wrap((req, res) => {
    const id = int(req.params.id, 'id');
    const row = db.prepare('SELECT * FROM serials WHERE id = ?').get(id);
    if (!row) throw notFound('ไม่พบ Serial ที่ระบุ');
    const note = req.body.note === undefined ? row.note : str(req.body.note, 'หมายเหตุ', { required: false, max: 500 });
    db.prepare("UPDATE serials SET note = ?, updated_at = datetime('now') WHERE id = ?").run(note, id);
    res.json(db.prepare('SELECT * FROM serials WHERE id = ?').get(id));
  }));

  router.use('/serials', serials);

  return router;
}
