import { Router } from 'express';
import { date, int } from '../lib/validate.js';
import { badRequest, wrap } from '../lib/http.js';
import { toCsv } from '../lib/csv.js';

const pad = (n) => String(n).padStart(2, '0');

/** คำนวณช่วงวันที่ของเดือน (YYYY-MM-01 ถึงวันสุดท้ายของเดือน) */
function monthRange(year, month) {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { from: `${year}-${pad(month)}-01`, to: `${year}-${pad(month)}-${pad(last)}` };
}

/** ช่วงวันที่จาก query: รับได้ทั้ง from/to หรือ year/month */
function rangeFrom(req) {
  if (req.query.from || req.query.to) {
    return {
      from: req.query.from ? date(req.query.from, 'ตั้งแต่วันที่') : '0000-01-01',
      to: req.query.to ? date(req.query.to, 'ถึงวันที่') : '9999-12-31',
    };
  }
  const now = new Date();
  const year = int(req.query.year, 'ปี', { required: false, def: now.getUTCFullYear(), min: 2000, max: 2999 });
  const month = int(req.query.month, 'เดือน', { required: false, def: now.getUTCMonth() + 1, min: 1, max: 12 });
  return { ...monthRange(year, month), year, month };
}

/** เงื่อนไขกรองคลัง ใช้ร่วมกันหลายรายงาน (ไม่ระบุ = รวมทุกคลัง) */
function whFilter(req, alias = 'd') {
  if (!req.query.warehouse_id) return { sql: '', params: {} };
  return {
    sql: ` AND ${alias}.warehouse_id = @warehouse_id`,
    params: { warehouse_id: int(req.query.warehouse_id, 'คลัง') },
  };
}

export function reportRoutes(db) {
  const router = Router();

  /* ==========================================================
   *  รายงานรายเดือน — รูปแบบเดียวกับไฟล์ Excel เดิม
   *  IN : Receive Date | PO# | Description | QTY
   *  OUT: Date | Name-Dept | Desktop | Laptop | Accessories | IS | Charge | Remark
   * ========================================================== */
  const monthlyData = (from, to, wh = { sql: '', params: {} }) => {
    const inbound = db.prepare(`
      SELECT d.receive_date AS date, d.doc_no, d.po_no, d.status,
             i.name AS item_name, i.sku, l.qty, i.unit, s.name AS supplier_name, l.note,
             w.code AS warehouse_code
      FROM receipt_lines l
      JOIN receipts d ON d.id = l.receipt_id
      JOIN items i ON i.id = l.item_id
      JOIN warehouses w ON w.id = d.warehouse_id
      LEFT JOIN suppliers s ON s.id = d.supplier_id
      WHERE d.receive_date BETWEEN @from AND @to AND d.status = 'posted'${wh.sql}
      ORDER BY d.receive_date, d.id, l.id
    `).all({ from, to, ...wh.params });

    const issues = db.prepare(`
      SELECT d.id, d.doc_no, d.issue_date AS date, d.charge, d.remark, d.status,
             e.emp_code, e.name AS employee_name, dp.name AS department_name,
             st.name AS is_staff_name, w.code AS warehouse_code
      FROM issues d
      JOIN employees e ON e.id = d.employee_id
      JOIN warehouses w ON w.id = d.warehouse_id
      LEFT JOIN departments dp ON dp.id = e.department_id
      LEFT JOIN is_staff st ON st.id = d.is_staff_id
      WHERE d.issue_date BETWEEN @from AND @to AND d.status = 'posted'${wh.sql}
      ORDER BY d.issue_date, d.id
    `).all({ from, to, ...wh.params });

    const lines = db.prepare(`
      SELECT l.issue_id, l.qty, l.note, i.name AS item_name, i.unit, c.kind,
             (SELECT GROUP_CONCAT(m.serial_no, ', ') FROM stock_moves m
               WHERE m.line_id = l.id AND m.doc_type = 'issue' AND m.doc_id = l.issue_id AND m.move_type = 'OUT') AS serials
      FROM issue_lines l
      JOIN items i ON i.id = l.item_id
      JOIN categories c ON c.id = i.category_id
      JOIN issues d ON d.id = l.issue_id
      WHERE d.issue_date BETWEEN @from AND @to AND d.status = 'posted'${wh.sql}
      ORDER BY l.id
    `).all({ from, to, ...wh.params });

    const byIssue = new Map();
    for (const l of lines) {
      if (!byIssue.has(l.issue_id)) byIssue.set(l.issue_id, []);
      // แสดงเป็น  ชื่ออุปกรณ์ - Serial  เหมือนไฟล์เดิม เช่น  Dell 17" monitor E1715S - ST:3X76N3
      const label = l.serials
        ? l.serials.split(', ').map((sn) => `${l.item_name} - ${sn}`)
        : [`${l.item_name}${l.qty > 1 ? ` x${l.qty}` : ''}`];
      byIssue.get(l.issue_id).push({ kind: l.kind, labels: label });
    }

    const outbound = issues.map((d) => {
      const group = { desktop: [], laptop: [], accessory: [], other: [] };
      for (const l of byIssue.get(d.id) || []) {
        (group[l.kind] || group.other).push(...l.labels);
      }
      return {
        ...d,
        charge_label: d.charge ? 'Y' : 'N',
        name_dept: `${d.emp_code} - ${d.employee_name}${d.department_name ? ` / ${d.department_name}` : ''}`,
        desktop: group.desktop,
        laptop: group.laptop,
        accessories: [...group.accessory, ...group.other],
      };
    });

    return { inbound, outbound };
  };

  router.get('/monthly', wrap((req, res) => {
    const { from, to, year, month } = rangeFrom(req);
    const { inbound, outbound } = monthlyData(from, to, whFilter(req));
    res.json({
      from, to, year, month,
      inbound,
      outbound,
      summary: {
        in_qty: inbound.reduce((a, r) => a + r.qty, 0),
        in_lines: inbound.length,
        out_docs: outbound.length,
        out_items: outbound.reduce((a, r) => a + r.desktop.length + r.laptop.length + r.accessories.length, 0),
        charged: outbound.filter((r) => r.charge).length,
        not_charged: outbound.filter((r) => !r.charge).length,
      },
    });
  }));

  router.get('/monthly.csv', wrap((req, res) => {
    const { from, to } = rangeFrom(req);
    const { outbound } = monthlyData(from, to, whFilter(req));
    const rows = outbound.map((r) => ({
      date: r.date,
      doc_no: r.doc_no,
      warehouse_code: r.warehouse_code,
      name_dept: r.name_dept,
      desktop: r.desktop.join(' | '),
      laptop: r.laptop.join(' | '),
      accessories: r.accessories.join(' | '),
      is_staff_name: r.is_staff_name || '',
      charge_label: r.charge_label,
      remark: r.remark || '',
    }));
    res.type('text/csv; charset=utf-8').attachment(`issue-report-${from}_${to}.csv`).send(toCsv(rows, {
      date: 'Date', doc_no: 'เลขที่เอกสาร', warehouse_code: 'คลัง', name_dept: 'Name - Dept.', desktop: 'Desktop',
      laptop: 'Laptop', accessories: 'Accessories', is_staff_name: 'IS', charge_label: 'Charge', remark: 'Remark',
    }));
  }));

  /* ---------- สรุปการเบิกตามแผนก ---------- */
  router.get('/by-department', wrap((req, res) => {
    const { from, to } = rangeFrom(req);
    const wh = whFilter(req);
    const data = db.prepare(`
      SELECT COALESCE(dp.name, '(ไม่ระบุแผนก)') AS department_name,
             COUNT(DISTINCT d.id) AS doc_count,
             COALESCE(SUM(l.qty), 0) AS total_qty,
             COALESCE(SUM(l.qty * i.unit_cost), 0) AS total_value,
             SUM(CASE WHEN d.charge = 1 THEN l.qty ELSE 0 END) AS charged_qty,
             SUM(CASE WHEN d.charge = 0 THEN l.qty ELSE 0 END) AS free_qty
      FROM issues d
      JOIN issue_lines l ON l.issue_id = d.id
      JOIN items i ON i.id = l.item_id
      JOIN employees e ON e.id = d.employee_id
      LEFT JOIN departments dp ON dp.id = e.department_id
      WHERE d.issue_date BETWEEN @from AND @to AND d.status = 'posted'${wh.sql}
      GROUP BY dp.id ORDER BY total_qty DESC
    `).all({ from, to, ...wh.params });
    res.json({ from, to, data });
  }));

  /* ---------- สรุปตามหมวดหมู่ ---------- */
  router.get('/by-category', wrap((req, res) => {
    const { from, to } = rangeFrom(req);
    const data = db.prepare(`
      SELECT c.name AS category_name, c.kind,
             COALESCE(SUM(CASE WHEN m.qty > 0 THEN m.qty ELSE 0 END), 0)  AS qty_in,
             COALESCE(SUM(CASE WHEN m.qty < 0 THEN -m.qty ELSE 0 END), 0) AS qty_out
      FROM categories c
      LEFT JOIN items i ON i.category_id = c.id
      LEFT JOIN stock_moves m ON m.item_id = i.id AND m.moved_at BETWEEN @from AND @to
      GROUP BY c.id ORDER BY c.sort_order, c.name
    `).all({ from, to });
    const stock = db.prepare(`
      SELECT category_name, COALESCE(SUM(balance), 0) AS balance, COALESCE(SUM(stock_value), 0) AS value
      FROM v_stock_balance GROUP BY category_id
    `).all();
    const byName = new Map(stock.map((s) => [s.category_name, s]));
    res.json({
      from, to,
      data: data.map((d) => ({ ...d, balance: byName.get(d.category_name)?.balance ?? 0, value: byName.get(d.category_name)?.value ?? 0 })),
    });
  }));

  /* ---------- สรุปการเบิกรายอุปกรณ์ (อุปกรณ์ที่เบิกบ่อย) ---------- */
  router.get('/top-items', wrap((req, res) => {
    const { from, to } = rangeFrom(req);
    const limit = int(req.query.limit, 'limit', { required: false, def: 20, min: 1, max: 200 });
    const wh = whFilter(req);
    const data = db.prepare(`
      SELECT i.id AS item_id, i.sku, i.name, c.name AS category_name, i.unit,
             SUM(l.qty) AS total_qty, COUNT(DISTINCT d.id) AS doc_count,
             SUM(l.qty * i.unit_cost) AS total_value
      FROM issue_lines l
      JOIN issues d ON d.id = l.issue_id
      JOIN items i ON i.id = l.item_id
      JOIN categories c ON c.id = i.category_id
      WHERE d.issue_date BETWEEN @from AND @to AND d.status = 'posted'${wh.sql}
      GROUP BY i.id ORDER BY total_qty DESC LIMIT @limit
    `).all({ from, to, limit, ...wh.params });
    res.json({ from, to, data });
  }));

  /* ---------- ทรัพย์สินที่พนักงานถือครองอยู่ ---------- */
  router.get('/assets-by-holder', wrap((req, res) => {
    const data = db.prepare(`
      SELECT e.id AS employee_id, e.emp_code, e.name AS employee_name, dp.name AS department_name,
             COUNT(s.id) AS asset_count,
             GROUP_CONCAT(i.name || ' - ' || s.serial_no || ' [' || w.code || ']', ' | ') AS assets
      FROM serials s
      JOIN items i ON i.id = s.item_id
      JOIN employees e ON e.id = s.holder_id
      JOIN warehouses w ON w.id = s.warehouse_id
      LEFT JOIN departments dp ON dp.id = e.department_id
      WHERE s.status = 'issued'
      GROUP BY e.id ORDER BY asset_count DESC, e.emp_code
    `).all();
    res.json({ data, total: data.length });
  }));

  router.get('/assets-by-holder.csv', wrap((req, res) => {
    const rows = db.prepare(`
      SELECT e.emp_code, e.name AS employee_name, dp.name AS department_name,
             i.sku, i.name AS item_name, s.serial_no, s.issued_at, w.code AS warehouse_code
      FROM serials s
      JOIN items i ON i.id = s.item_id
      JOIN employees e ON e.id = s.holder_id
      JOIN warehouses w ON w.id = s.warehouse_id
      LEFT JOIN departments dp ON dp.id = e.department_id
      WHERE s.status = 'issued'
      ORDER BY e.emp_code, i.name
    `).all();
    res.type('text/csv; charset=utf-8').attachment('assets-by-holder.csv').send(toCsv(rows, {
      emp_code: 'รหัสพนักงาน', employee_name: 'ชื่อพนักงาน', department_name: 'แผนก',
      sku: 'รหัสอุปกรณ์', item_name: 'ชื่ออุปกรณ์', serial_no: 'Serial', warehouse_code: 'คลังต้นสังกัด', issued_at: 'วันที่เบิก',
    }));
  }));

  /* ---------- สรุปค่าใช้จ่ายที่ต้อง Charge ---------- */
  router.get('/charge-summary', wrap((req, res) => {
    const { from, to } = rangeFrom(req);
    const wh = whFilter(req);
    const data = db.prepare(`
      SELECT COALESCE(dp.name, '(ไม่ระบุแผนก)') AS department_name,
             SUM(CASE WHEN d.charge = 1 THEN l.qty * i.unit_cost ELSE 0 END) AS charge_value,
             SUM(CASE WHEN d.charge = 0 THEN l.qty * i.unit_cost ELSE 0 END) AS free_value,
             SUM(CASE WHEN d.charge = 1 THEN l.qty ELSE 0 END) AS charge_qty,
             SUM(CASE WHEN d.charge = 0 THEN l.qty ELSE 0 END) AS free_qty
      FROM issues d
      JOIN issue_lines l ON l.issue_id = d.id
      JOIN items i ON i.id = l.item_id
      JOIN employees e ON e.id = d.employee_id
      LEFT JOIN departments dp ON dp.id = e.department_id
      WHERE d.issue_date BETWEEN @from AND @to AND d.status = 'posted'${wh.sql}
      GROUP BY dp.id ORDER BY charge_value DESC
    `).all({ from, to, ...wh.params });
    res.json({ from, to, data });
  }));

  /* ---------- รายงานความเคลื่อนไหวย้อนหลัง 12 เดือน ---------- */
  router.get('/trend', wrap((req, res) => {
    const months = int(req.query.months, 'จำนวนเดือน', { required: false, def: 12, min: 1, max: 36 });
    const data = db.prepare(`
      SELECT substr(moved_at, 1, 7) AS ym,
             SUM(CASE WHEN qty > 0 THEN qty ELSE 0 END)  AS qty_in,
             SUM(CASE WHEN qty < 0 THEN -qty ELSE 0 END) AS qty_out
      FROM stock_moves
      GROUP BY ym ORDER BY ym DESC LIMIT @months
    `).all({ months });
    res.json({ data: data.reverse() });
  }));

  /* ---------- บันทึกการใช้งานระบบ ---------- */
  router.get('/audit', wrap((req, res) => {
    const limit = int(req.query.per_page, 'per_page', { required: false, def: 100, min: 1, max: 500 });
    const page = int(req.query.page, 'page', { required: false, def: 1, min: 1 });
    const total = db.prepare('SELECT COUNT(*) AS n FROM audit_logs').get().n;
    const data = db.prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT @limit OFFSET @offset')
      .all({ limit, offset: (page - 1) * limit });
    res.json({ data, total, page, per_page: limit });
  }));

  return router;
}

export function dashboardRoutes(db) {
  const router = Router();

  router.get('/', wrap((req, res) => {
    const whId = req.query.warehouse_id ? int(req.query.warehouse_id, 'คลัง') : null;
    const whSql = whId ? 'AND warehouse_id = @warehouse_id' : '';
    const whParams = whId ? { warehouse_id: whId } : {};
    const source = whId ? 'v_stock_balance_wh' : 'v_stock_balance';

    const totals = db.prepare(`
      SELECT COUNT(*) AS item_count,
             COALESCE(SUM(balance), 0) AS total_qty,
             COALESCE(SUM(stock_value), 0) AS total_value,
             SUM(CASE WHEN min_qty > 0 AND balance <= min_qty THEN 1 ELSE 0 END) AS low_count,
             SUM(CASE WHEN balance <= 0 THEN 1 ELSE 0 END) AS out_count
      FROM ${source} WHERE active = 1 ${whSql}
    `).get(whParams);

    // สรุปแยกรายคลัง แสดงคู่กับยอดรวมเสมอ
    const warehouses = db.prepare(`
      SELECT w.id, w.code, w.name,
             COALESCE(SUM(b.balance), 0)     AS balance,
             COALESCE(SUM(b.stock_value), 0) AS value,
             SUM(CASE WHEN b.balance > 0 THEN 1 ELSE 0 END) AS item_count
      FROM warehouses w
      LEFT JOIN v_stock_balance_wh b ON b.warehouse_id = w.id AND b.active = 1
      WHERE w.active = 1
      GROUP BY w.id ORDER BY w.sort_order, w.id
    `).all();

    const now = new Date();
    const { from, to } = monthRange(now.getUTCFullYear(), now.getUTCMonth() + 1);
    const thisMonth = db.prepare(`
      SELECT COALESCE(SUM(CASE WHEN qty > 0 THEN qty ELSE 0 END), 0)  AS qty_in,
             COALESCE(SUM(CASE WHEN qty < 0 THEN -qty ELSE 0 END), 0) AS qty_out
      FROM stock_moves WHERE moved_at BETWEEN @from AND @to ${whSql}
    `).get({ from, to, ...whParams });

    const assets = db.prepare(`
      SELECT SUM(CASE WHEN status = 'in_stock' THEN 1 ELSE 0 END) AS in_stock,
             SUM(CASE WHEN status = 'issued'   THEN 1 ELSE 0 END) AS issued,
             SUM(CASE WHEN status = 'scrapped' THEN 1 ELSE 0 END) AS scrapped
      FROM serials WHERE 1 = 1 ${whSql}
    `).get(whParams);

    const lowItems = db.prepare(`
      SELECT item_id, sku, name, unit, balance, min_qty, category_name
      FROM ${source} WHERE active = 1 AND min_qty > 0 AND balance <= min_qty ${whSql}
      ORDER BY (balance - min_qty) LIMIT 10
    `).all(whParams);

    const recentMoves = db.prepare(`
      SELECT m.id, m.moved_at, m.doc_no, m.move_type, m.qty, m.serial_no,
             i.name AS item_name, i.sku, i.unit, w.code AS warehouse_code
      FROM stock_moves m
      JOIN items i ON i.id = m.item_id
      LEFT JOIN warehouses w ON w.id = m.warehouse_id
      WHERE 1 = 1 ${whId ? 'AND m.warehouse_id = @warehouse_id' : ''}
      ORDER BY m.id DESC LIMIT 12
    `).all(whParams);

    const byCategory = db.prepare(`
      SELECT category_name, COALESCE(SUM(balance), 0) AS balance, COALESCE(SUM(stock_value), 0) AS value
      FROM ${source} WHERE active = 1 ${whSql}
      GROUP BY category_id HAVING balance > 0 ORDER BY balance DESC
    `).all(whParams);

    const trend = db.prepare(`
      SELECT substr(moved_at, 1, 7) AS ym,
             SUM(CASE WHEN qty > 0 THEN qty ELSE 0 END)  AS qty_in,
             SUM(CASE WHEN qty < 0 THEN -qty ELSE 0 END) AS qty_out
      FROM stock_moves WHERE 1 = 1 ${whSql} GROUP BY ym ORDER BY ym DESC LIMIT 6
    `).all(whParams).reverse();

    const pending = db.prepare(`
      SELECT (SELECT COUNT(*) FROM receipts WHERE status = 'posted') AS receipts,
             (SELECT COUNT(*) FROM issues   WHERE status = 'posted') AS issues,
             (SELECT COUNT(*) FROM returns  WHERE status = 'posted') AS returns
    `).get();

    res.json({
      totals, warehouses, thisMonth, assets, lowItems, recentMoves, byCategory, trend,
      docCounts: pending, month: { from, to }, warehouse_id: whId,
    });
  }));

  return router;
}
