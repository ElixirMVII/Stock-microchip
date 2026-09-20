import { Router } from 'express';
import { date, int, oneOf } from '../lib/validate.js';
import { wrap } from '../lib/http.js';
import { toCsv } from '../lib/csv.js';

/** ระบบเช็คข้อมูลคลัง: ยอดคงเหลือ ของใกล้หมด และประวัติการเคลื่อนไหว */
export function stockRoutes(db) {
  const router = Router();

  /* ---------- ยอดคงเหลือทั้งคลัง ---------- */
  const balanceQuery = (req) => {
    const where = ['1 = 1'];
    const params = {};
    if (req.query.q) {
      where.push('(sku LIKE @q OR name LIKE @q OR brand LIKE @q OR model LIKE @q OR category_name LIKE @q)');
      params.q = `%${req.query.q}%`;
    }
    if (req.query.category_id) { where.push('category_id = @category_id'); params.category_id = Number(req.query.category_id); }
    if (req.query.active === '0' || req.query.active === '1') { where.push('active = @active'); params.active = Number(req.query.active); }
    if (req.query.only_low === '1') where.push('balance <= min_qty AND min_qty > 0');
    if (req.query.only_zero === '1') where.push('balance <= 0');
    if (req.query.in_stock === '1') where.push('balance > 0');

    const sortMap = {
      name: 'name COLLATE NOCASE',
      sku: 'sku COLLATE NOCASE',
      balance: 'balance DESC',
      value: 'stock_value DESC',
      category: 'category_name COLLATE NOCASE, name COLLATE NOCASE',
    };
    const order = sortMap[req.query.sort] || sortMap.name;
    return { clause: `WHERE ${where.join(' AND ')}`, params, order };
  };

  router.get('/balance', wrap((req, res) => {
    const { clause, params, order } = balanceQuery(req);
    const total = db.prepare(`SELECT COUNT(*) AS n FROM v_stock_balance ${clause}`).get(params).n;
    const summary = db.prepare(`
      SELECT COALESCE(SUM(balance), 0) AS total_qty,
             COALESCE(SUM(stock_value), 0) AS total_value,
             SUM(CASE WHEN min_qty > 0 AND balance <= min_qty THEN 1 ELSE 0 END) AS low_items
      FROM v_stock_balance ${clause}
    `).get(params);
    const limit = int(req.query.per_page, 'per_page', { required: false, def: 100, min: 1, max: 2000 });
    const page = int(req.query.page, 'page', { required: false, def: 1, min: 1 });
    const data = db.prepare(`
      SELECT *,
             (SELECT COUNT(*) FROM serials s WHERE s.item_id = v_stock_balance.item_id AND s.status = 'in_stock') AS serial_in_stock,
             (SELECT COUNT(*) FROM serials s WHERE s.item_id = v_stock_balance.item_id AND s.status = 'issued')   AS serial_issued
      FROM v_stock_balance ${clause} ORDER BY ${order} LIMIT @limit OFFSET @offset
    `).all({ ...params, limit, offset: (page - 1) * limit });
    res.json({ data, total, page, per_page: limit, summary });
  }));

  router.get('/balance.csv', wrap((req, res) => {
    const { clause, params, order } = balanceQuery(req);
    const rows = db.prepare(`SELECT * FROM v_stock_balance ${clause} ORDER BY ${order}`).all(params);
    res.type('text/csv; charset=utf-8').attachment('stock-balance.csv').send(toCsv(rows, {
      sku: 'รหัสอุปกรณ์', name: 'ชื่ออุปกรณ์', category_name: 'หมวดหมู่', brand: 'ยี่ห้อ', model: 'รุ่น',
      unit: 'หน่วย', total_in: 'รับเข้า', total_out: 'จ่ายออก', balance: 'คงเหลือ',
      min_qty: 'ขั้นต่ำ', unit_cost: 'ราคา/หน่วย', stock_value: 'มูลค่า', location: 'ที่เก็บ',
    }));
  }));

  /* ---------- อุปกรณ์ใกล้หมด / หมด ---------- */
  router.get('/low', wrap((req, res) => {
    const data = db.prepare(`
      SELECT * FROM v_stock_balance
      WHERE active = 1 AND min_qty > 0 AND balance <= min_qty
      ORDER BY (balance - min_qty), name COLLATE NOCASE
    `).all();
    res.json({ data, total: data.length });
  }));

  /* ---------- ประวัติการเคลื่อนไหว (ledger) ---------- */
  const movesQuery = (req) => {
    const where = ['1 = 1'];
    const params = {};
    if (req.query.item_id) { where.push('m.item_id = @item_id'); params.item_id = Number(req.query.item_id); }
    if (req.query.from) { where.push('m.moved_at >= @from'); params.from = date(req.query.from, 'ตั้งแต่วันที่'); }
    if (req.query.to) { where.push('m.moved_at <= @to'); params.to = date(req.query.to, 'ถึงวันที่'); }
    if (req.query.move_type) {
      where.push('m.move_type = @move_type');
      params.move_type = oneOf(req.query.move_type, 'ประเภท', ['IN', 'OUT', 'RETURN', 'ADJUST', 'VOID']);
    }
    if (req.query.doc_type) {
      where.push('m.doc_type = @doc_type');
      params.doc_type = oneOf(req.query.doc_type, 'ชนิดเอกสาร', ['receipt', 'issue', 'return', 'adjustment']);
    }
    if (req.query.q) {
      where.push('(m.doc_no LIKE @q OR m.serial_no LIKE @q OR i.name LIKE @q OR i.sku LIKE @q OR m.note LIKE @q)');
      params.q = `%${req.query.q}%`;
    }
    return { clause: `WHERE ${where.join(' AND ')}`, params };
  };

  const MOVES_SELECT = `
    SELECT m.*, i.sku, i.name AS item_name, i.unit, c.name AS category_name, u.full_name AS created_by_name
    FROM stock_moves m
    JOIN items i ON i.id = m.item_id
    JOIN categories c ON c.id = i.category_id
    LEFT JOIN users u ON u.id = m.created_by`;

  router.get('/moves', wrap((req, res) => {
    const { clause, params } = movesQuery(req);
    const total = db.prepare(`SELECT COUNT(*) AS n FROM stock_moves m JOIN items i ON i.id = m.item_id ${clause}`).get(params).n;
    const limit = int(req.query.per_page, 'per_page', { required: false, def: 100, min: 1, max: 1000 });
    const page = int(req.query.page, 'page', { required: false, def: 1, min: 1 });
    const data = db.prepare(`${MOVES_SELECT} ${clause} ORDER BY m.moved_at DESC, m.id DESC LIMIT @limit OFFSET @offset`)
      .all({ ...params, limit, offset: (page - 1) * limit });
    res.json({ data, total, page, per_page: limit });
  }));

  router.get('/moves.csv', wrap((req, res) => {
    const { clause, params } = movesQuery(req);
    const rows = db.prepare(`${MOVES_SELECT} ${clause} ORDER BY m.moved_at DESC, m.id DESC`).all(params);
    res.type('text/csv; charset=utf-8').attachment('stock-moves.csv').send(toCsv(rows, {
      moved_at: 'วันที่', doc_no: 'เลขที่เอกสาร', move_type: 'ประเภท', sku: 'รหัสอุปกรณ์',
      item_name: 'ชื่ออุปกรณ์', serial_no: 'Serial', qty: 'จำนวน', note: 'หมายเหตุ', created_by_name: 'ผู้บันทึก',
    }));
  }));

  /* ---------- การ์ดสต็อกรายอุปกรณ์ (running balance) ---------- */
  router.get('/card/:itemId', wrap((req, res) => {
    const itemId = int(req.params.itemId, 'itemId');
    const item = db.prepare('SELECT * FROM v_stock_balance WHERE item_id = ?').get(itemId);
    const moves = db.prepare(`${MOVES_SELECT} WHERE m.item_id = @item_id ORDER BY m.moved_at, m.id`).all({ item_id: itemId });
    let running = 0;
    const rows = moves.map((m) => { running += m.qty; return { ...m, running_balance: running }; });
    res.json({ item, data: rows.reverse() });
  }));

  return router;
}
