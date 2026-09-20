/* ============================================================
 *  ปรับปรุงโครงสร้างฐานข้อมูลเดิมให้รองรับหลายคลัง
 *  ฐานข้อมูลที่สร้างใหม่จะได้โครงสร้างครบจาก schema.sql อยู่แล้ว
 *  ไฟล์นี้จึงทำงานเฉพาะกับฐานข้อมูลเก่าที่ยังไม่มีคอลัมน์ warehouse_id
 * ============================================================ */

const hasColumn = (db, table, column) =>
  db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);

const tableExists = (db, table) =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);

/** ตารางที่ต้องมี warehouse_id และค่าเริ่มต้นชี้ไปยังคลังแรก */
const NEEDS_WAREHOUSE = ['stock_moves', 'serials', 'receipts', 'issues', 'returns', 'adjustments'];

export function runMigrations(db) {
  const applied = [];

  // ---- คลังเริ่มต้น ต้องมีอย่างน้อยหนึ่งแห่งก่อน backfill ----
  if (db.prepare('SELECT COUNT(*) AS n FROM warehouses').get().n === 0) {
    db.prepare("INSERT INTO warehouses (id, code, name, sort_order) VALUES (1, 'MMT', 'คลัง MMT', 10)").run();
    db.prepare("INSERT INTO warehouses (code, name, sort_order) VALUES ('MTHAI', 'คลัง MTHAI', 20)").run();
    applied.push('สร้างคลังเริ่มต้น MMT และ MTHAI');
  }
  const defaultWh = db.prepare('SELECT id FROM warehouses ORDER BY sort_order, id LIMIT 1').get().id;

  // ---- เพิ่มคอลัมน์ warehouse_id ให้ตารางเดิม แล้วโอนข้อมูลเก่าเข้าคลังแรก ----
  const missing = NEEDS_WAREHOUSE.filter((t) => tableExists(db, t) && !hasColumn(db, t, 'warehouse_id'));
  if (missing.length) {
    // SQLite ไม่ยอมให้เพิ่มคอลัมน์ที่มี REFERENCES พร้อมค่า default ขณะเปิด foreign key
    db.pragma('foreign_keys = OFF');
    db.transaction(() => {
      for (const t of missing) {
        db.exec(`ALTER TABLE ${t} ADD COLUMN warehouse_id INTEGER NOT NULL DEFAULT ${defaultWh} REFERENCES warehouses(id)`);
      }
    })();
    db.pragma('foreign_keys = ON');
    applied.push(`เพิ่มคอลัมน์ warehouse_id ให้ ${missing.join(', ')} (ข้อมูลเดิมเข้าคลังแรก)`);
  }

  // ---- คอลัมน์ติดตามคลังในประวัติ Serial ----
  if (tableExists(db, 'serial_events')) {
    for (const col of ['wh_before', 'wh_after']) {
      if (!hasColumn(db, 'serial_events', col)) {
        db.exec(`ALTER TABLE serial_events ADD COLUMN ${col} INTEGER`);
        applied.push(`เพิ่มคอลัมน์ ${col} ให้ serial_events`);
      }
    }
  }

  // ---- ข้อมูลเก่าที่คอลัมน์ว่างอยู่ (เผื่อกรณีเพิ่มคอลัมน์ไว้แล้วแต่ยังไม่ backfill) ----
  for (const t of NEEDS_WAREHOUSE) {
    if (tableExists(db, t) && hasColumn(db, t, 'warehouse_id')) {
      const n = db.prepare(`UPDATE ${t} SET warehouse_id = ? WHERE warehouse_id IS NULL`).run(defaultWh).changes;
      if (n) applied.push(`กำหนดคลังให้ข้อมูลเดิมในตาราง ${t} จำนวน ${n} แถว`);
    }
  }

  // ---- ดัชนีของคอลัมน์คลัง สร้างหลังคอลัมน์พร้อมแล้วเท่านั้น ----
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_serials_wh      ON serials(warehouse_id);
    CREATE INDEX IF NOT EXISTS idx_moves_wh        ON stock_moves(warehouse_id);
    CREATE INDEX IF NOT EXISTS idx_moves_item_wh   ON stock_moves(item_id, warehouse_id);
  `);

  if (applied.length) {
    console.log('ปรับปรุงฐานข้อมูล:');
    applied.forEach((a) => console.log('  -', a));
  }
  return applied;
}
