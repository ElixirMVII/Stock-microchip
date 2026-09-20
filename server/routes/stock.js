import { Router } from 'express';
import { date, int, oneOf } from '../lib/validate.js';
import { wrap } from '../lib/http.js';
import { toCsv } from '../lib/csv.js';

/** ระบบเช็คข้อมูลคลัง: ยอดคงเหลือ ของใกล้หมด และประวัติการเคลื่อนไหว */
export function stockRoutes(db) {
  const router = Router();

  /* ---------- ยอดคงเหลือ (รวมทุกคลัง หรือเจาะรายคลัง) ---------- */
  const balanceQuery = (req) => {
    const where = ['1 = 1'];
    const params = {};
    // ระบุ warehouse_id = ดูเฉพาะคลังนั้น, ไม่ระบุ = ยอดรวมทุกคลัง
    const whId = req.query.warehouse_id ? int(req.query.warehouse_id, 'คลัง') : null;
    const source = whId ? 'v_stock_balance_wh' : 'v_stock_balance';
    if (whId) { where.push('warehouse_id = @warehouse_id'); params.warehouse_id = whId; }
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
      name: 'name',
      sku: 'sku',
      balance: 'balance DESC',
      value: 'stock_value DESC',
      category: 'category_name, name',
    };
    const order = sortMap[req.query.sort] || sortMap.name;
    return { clause: `WHERE ${where.join(' AND ')}`, params, order, source, whId };
  };

  router.get('/balance', wrap(async (req, res) => {
    const { clause, params, order, source, whId } = balanceQuery(req);
    const total = (await db.get(`SELECT COUNT(*) AS n FROM ${source} ${clause}`, params)).n;
    const summary = await db.get(`
      SELECT COALESCE(SUM(balance), 0) AS total_qty,
             COALESCE(SUM(stock_value), 0) AS total_value,
             SUM(CASE WHEN min_qty > 0 AND balance <= min_qty THEN 1 ELSE 0 END) AS low_items
      FROM ${source} ${clause}
    `, params);
    const limit = int(req.query.per_page, 'per_page', { required: false, def: 100, min: 1, max: 2000 });
    const page = int(req.query.page, 'page', { required: false, def: 1, min: 1 });
    // นับ Serial ให้ตรงกับขอบเขตที่ดูอยู่ (รายคลัง หรือรวมทุกคลัง)
    // ชื่อคอลัมน์ใน clause/order ไม่ต้องเติม prefix เพราะ SQLite แปลงให้ชี้ตาราง b เอง
    const whFilter = whId ? 'AND s.warehouse_id = @warehouse_id' : '';
    const data = await db.all(`
      SELECT b.*,
             (SELECT COUNT(*) FROM serials s WHERE s.item_id = b.item_id AND s.status = 'in_stock' ${whFilter}) AS serial_in_stock,
             (SELECT COUNT(*) FROM serials s WHERE s.item_id = b.item_id AND s.status = 'issued'   ${whFilter}) AS serial_issued
      FROM ${source} b ${clause}
      ORDER BY ${order}
      LIMIT @limit OFFSET @offset
    `, { ...params, limit, offset: (page - 1) * limit });
    res.json({ data, total, page, per_page: limit, summary, warehouse_id: whId });
  }));

  router.get('/balance.csv', wrap(async (req, res) => {
    const { clause, params, order, source } = balanceQuery(req);
    const rows = await db.all(`SELECT * FROM ${source} ${clause} ORDER BY ${order}`, params);
    res.type('text/csv; charset=utf-8').attachment('stock-balance.csv').send(toCsv(rows, {
      warehouse_code: 'คลัง', sku: 'รหัสอุปกรณ์', name: 'ชื่ออุปกรณ์', category_name: 'หมวดหมู่', brand: 'ยี่ห้อ', model: 'รุ่น',
      unit: 'หน่วย', total_in: 'รับเข้า', total_out: 'จ่ายออก', balance: 'คงเหลือ',
      min_qty: 'ขั้นต่ำ', unit_cost: 'ราคา/หน่วย', stock_value: 'มูลค่า', location: 'ที่เก็บ',
    }));
  }));

  /* ---------- เปรียบเทียบยอดคงเหลือทุกคลังในตารางเดียว ----------
   * คืนค่าเป็น 1 แถวต่ออุปกรณ์ พร้อมยอดแยกรายคลัง (by_warehouse) และยอดรวม (total)
   * ใช้แสดงตารางแบบ: อุปกรณ์ | MMT | MTHAI | รวม
   */
  router.get('/by-warehouse', wrap(async (req, res) => {
    const warehouses = await db.all('SELECT id, code, name FROM warehouses WHERE active = 1 ORDER BY sort_order, id');

    const where = ['1 = 1'];
    const params = {};
    if (req.query.q) {
      where.push('(i.sku LIKE @q OR i.name LIKE @q OR i.brand LIKE @q OR i.model LIKE @q)');
      params.q = `%${req.query.q}%`;
    }
    if (req.query.category_id) { where.push('i.category_id = @category_id'); params.category_id = Number(req.query.category_id); }
    if (req.query.active === '0' || req.query.active === '1') { where.push('i.active = @active'); params.active = Number(req.query.active); }
    else where.push('i.active = 1');
    const clause = `WHERE ${where.join(' AND ')}`;

    const rows = await db.all(`
      SELECT i.id AS item_id, i.sku, i.name, i.unit, i.min_qty, i.unit_cost, i.track_serial,
             c.name AS category_name,
             m.warehouse_id, COALESCE(m.balance, 0) AS balance
      FROM items i
      JOIN categories c ON c.id = i.category_id
      LEFT JOIN (
        SELECT item_id, warehouse_id, SUM(qty) AS balance
        FROM stock_moves GROUP BY item_id, warehouse_id
      ) m ON m.item_id = i.id
      ${clause}
      ORDER BY i.name
    `, params);

    // ยุบหลายแถว (อุปกรณ์ × คลัง) ให้เหลือแถวเดียวต่ออุปกรณ์
    const byItem = new Map();
    for (const r of rows) {
      if (!byItem.has(r.item_id)) {
        byItem.set(r.item_id, {
          item_id: r.item_id, sku: r.sku, name: r.name, unit: r.unit,
          min_qty: r.min_qty, unit_cost: r.unit_cost, track_serial: r.track_serial,
          category_name: r.category_name,
          by_warehouse: Object.fromEntries(warehouses.map((w) => [w.id, 0])),
          total: 0, total_value: 0,
        });
      }
      const row = byItem.get(r.item_id);
      if (r.warehouse_id != null && r.warehouse_id in row.by_warehouse) {
        row.by_warehouse[r.warehouse_id] = r.balance;
        row.total += r.balance;
      }
    }
    const data = [...byItem.values()].map((r) => ({ ...r, total_value: r.total * r.unit_cost }));

    if (req.query.only_low === '1') {
      // "ใกล้หมด" ตัดสินจากยอดรวมทุกคลัง เพราะจุดสั่งซื้อกำหนดไว้ระดับอุปกรณ์
      const filtered = data.filter((r) => r.min_qty > 0 && r.total <= r.min_qty);
      return res.json({ warehouses, data: filtered, total: filtered.length, summary: summarize(filtered, warehouses) });
    }
    res.json({ warehouses, data, total: data.length, summary: summarize(data, warehouses) });
  }));

  const summarize = (rows, warehouses) => ({
    total_qty: rows.reduce((a, r) => a + r.total, 0),
    total_value: rows.reduce((a, r) => a + r.total_value, 0),
    by_warehouse: Object.fromEntries(warehouses.map((w) => [
      w.id,
      {
        qty: rows.reduce((a, r) => a + (r.by_warehouse[w.id] || 0), 0),
        value: rows.reduce((a, r) => a + (r.by_warehouse[w.id] || 0) * r.unit_cost, 0),
      },
    ])),
  });

  router.get('/by-warehouse.csv', wrap(async (req, res) => {
    const warehouses = await db.all('SELECT id, code FROM warehouses WHERE active = 1 ORDER BY sort_order, id');
    const payload = await db.all(`
      SELECT i.id AS item_id, i.sku, i.name, i.unit, c.name AS category_name, i.min_qty,
             m.warehouse_id, COALESCE(m.balance, 0) AS balance
      FROM items i
      JOIN categories c ON c.id = i.category_id
      LEFT JOIN (SELECT item_id, warehouse_id, SUM(qty) AS balance FROM stock_moves GROUP BY item_id, warehouse_id) m
        ON m.item_id = i.id
      WHERE i.active = 1
      ORDER BY i.name
    `);

    const map = new Map();
    for (const r of payload) {
      if (!map.has(r.item_id)) {
        map.set(r.item_id, { sku: r.sku, name: r.name, category_name: r.category_name, unit: r.unit, min_qty: r.min_qty, total: 0 });
        for (const w of warehouses) map.get(r.item_id)[`wh_${w.id}`] = 0;
      }
      const row = map.get(r.item_id);
      if (r.warehouse_id != null && `wh_${r.warehouse_id}` in row) {
        row[`wh_${r.warehouse_id}`] = r.balance;
        row.total += r.balance;
      }
    }
    const columns = { sku: 'รหัสอุปกรณ์', name: 'ชื่ออุปกรณ์', category_name: 'หมวดหมู่', unit: 'หน่วย' };
    for (const w of warehouses) columns[`wh_${w.id}`] = `คลัง ${w.code}`;
    columns.total = 'รวมทุกคลัง';
    columns.min_qty = 'ขั้นต่ำ';

    res.type('text/csv; charset=utf-8').attachment('stock-by-warehouse.csv').send(toCsv([...map.values()], columns));
  }));

  /* ---------- อุปกรณ์ใกล้หมด / หมด ---------- */
  router.get('/low', wrap(async (req, res) => {
    const data = await db.all(`
      SELECT * FROM v_stock_balance
      WHERE active = 1 AND min_qty > 0 AND balance <= min_qty
      ORDER BY (balance - min_qty), name
    `);
    res.json({ data, total: data.length });
  }));

  /* ---------- ประวัติการเคลื่อนไหว (ledger) ---------- */
  const movesQuery = (req) => {
    const where = ['1 = 1'];
    const params = {};
    if (req.query.item_id) { where.push('m.item_id = @item_id'); params.item_id = Number(req.query.item_id); }
    if (req.query.warehouse_id) { where.push('m.warehouse_id = @warehouse_id'); params.warehouse_id = int(req.query.warehouse_id, 'คลัง'); }
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
    SELECT m.*, i.sku, i.name AS item_name, i.unit, c.name AS category_name,
           u.full_name AS created_by_name, w.code AS warehouse_code, w.name AS warehouse_name
    FROM stock_moves m
    JOIN items i ON i.id = m.item_id
    JOIN categories c ON c.id = i.category_id
    LEFT JOIN warehouses w ON w.id = m.warehouse_id
    LEFT JOIN users u ON u.id = m.created_by`;

  router.get('/moves', wrap(async (req, res) => {
    const { clause, params } = movesQuery(req);
    const total = (await db.get(`SELECT COUNT(*) AS n FROM stock_moves m JOIN items i ON i.id = m.item_id ${clause}`, params)).n;
    const limit = int(req.query.per_page, 'per_page', { required: false, def: 100, min: 1, max: 1000 });
    const page = int(req.query.page, 'page', { required: false, def: 1, min: 1 });
    const data = await db.all(`${MOVES_SELECT} ${clause} ORDER BY m.moved_at DESC, m.id DESC LIMIT @limit OFFSET @offset`, { ...params, limit, offset: (page - 1) * limit });
    res.json({ data, total, page, per_page: limit });
  }));

  router.get('/moves.csv', wrap(async (req, res) => {
    const { clause, params } = movesQuery(req);
    const rows = await db.all(`${MOVES_SELECT} ${clause} ORDER BY m.moved_at DESC, m.id DESC`, params);
    res.type('text/csv; charset=utf-8').attachment('stock-moves.csv').send(toCsv(rows, {
      moved_at: 'วันที่', doc_no: 'เลขที่เอกสาร', move_type: 'ประเภท', warehouse_code: 'คลัง',
      sku: 'รหัสอุปกรณ์', item_name: 'ชื่ออุปกรณ์', serial_no: 'Serial', qty: 'จำนวน',
      note: 'หมายเหตุ', created_by_name: 'ผู้บันทึก',
    }));
  }));

  /* ---------- การ์ดสต็อกรายอุปกรณ์ (running balance) ---------- */
  router.get('/card/:itemId', wrap(async (req, res) => {
    const itemId = int(req.params.itemId, 'itemId');
    const whId = req.query.warehouse_id ? int(req.query.warehouse_id, 'คลัง') : null;
    const item = whId
      ? await db.get('SELECT * FROM v_stock_balance_wh WHERE item_id = ? AND warehouse_id = ?', [itemId, whId])
      : await db.get('SELECT * FROM v_stock_balance WHERE item_id = ?', itemId);
    const moves = await db.all(`${MOVES_SELECT} WHERE m.item_id = @item_id ${whId ? 'AND m.warehouse_id = @warehouse_id' : ''} ORDER BY m.moved_at, m.id`, whId ? { item_id: itemId, warehouse_id: whId } : { item_id: itemId });
    let running = 0;
    const rows = moves.map((m) => { running += m.qty; return { ...m, running_balance: running }; });
    res.json({ item, data: rows.reverse() });
  }));

  return router;
}
