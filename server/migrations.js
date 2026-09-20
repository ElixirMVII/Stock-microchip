/* ============================================================
 *  ปรับปรุงโครงสร้างฐานข้อมูลให้ทันสมัย (MySQL / MariaDB)
 *  ฐานข้อมูลที่สร้างใหม่จะได้โครงสร้างครบจาก schema.sql อยู่แล้ว
 *  ไฟล์นี้จึงทำงานเฉพาะส่วนที่ schema.sql ทำแทนไม่ได้ เช่น
 *  การเติมคอลัมน์ให้ตารางเดิมที่มีข้อมูลอยู่แล้ว
 * ============================================================ */

const hasColumn = async (db, table, column) =>
  (await db.scalar(
    `SELECT COUNT(*) FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = @t AND COLUMN_NAME = @c`,
    { t: table, c: column },
  )) > 0;

const hasTable = async (db, table) =>
  (await db.scalar(
    `SELECT COUNT(*) FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = @t`,
    { t: table },
  )) > 0;

const hasIndex = async (db, table, index) =>
  (await db.scalar(
    `SELECT COUNT(*) FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = @t AND INDEX_NAME = @i`,
    { t: table, i: index },
  )) > 0;

/** ตารางที่ต้องมี warehouse_id และค่าเริ่มต้นชี้ไปยังคลังแรก */
const NEEDS_WAREHOUSE = ['stock_moves', 'serials', 'receipts', 'issues', 'returns', 'adjustments'];

export async function runMigrations(db) {
  const applied = [];

  // ---- คลังเริ่มต้น ต้องมีอย่างน้อยหนึ่งแห่งก่อน backfill ----
  if ((await db.scalar('SELECT COUNT(*) FROM warehouses')) === 0) {
    await db.run("INSERT INTO warehouses (id, code, name, sort_order) VALUES (1, 'MMT', 'คลัง MMT', 10)");
    await db.run("INSERT INTO warehouses (code, name, sort_order) VALUES ('MTHAI', 'คลัง MTHAI', 20)");
    applied.push('สร้างคลังเริ่มต้น MMT และ MTHAI');
  }
  const defaultWh = await db.scalar('SELECT id FROM warehouses ORDER BY sort_order, id LIMIT 1');

  // ---- เพิ่มคอลัมน์ warehouse_id ให้ตารางรุ่นเก่า แล้วโอนข้อมูลเดิมเข้าคลังแรก ----
  for (const table of NEEDS_WAREHOUSE) {
    if (!(await hasTable(db, table))) continue;
    if (await hasColumn(db, table, 'warehouse_id')) continue;
    await db.run(
      `ALTER TABLE ${table} ADD COLUMN warehouse_id INT UNSIGNED NOT NULL DEFAULT ${Number(defaultWh)}`,
    );
    await db.run(
      `ALTER TABLE ${table} ADD CONSTRAINT fk_${table}_wh FOREIGN KEY (warehouse_id) REFERENCES warehouses(id)`,
    );
    applied.push(`เพิ่มคอลัมน์ warehouse_id ให้ ${table} (ข้อมูลเดิมเข้าคลังแรก)`);
  }

  // ---- คอลัมน์ติดตามคลังในประวัติ Serial ----
  if (await hasTable(db, 'serial_events')) {
    for (const col of ['wh_before', 'wh_after']) {
      if (!(await hasColumn(db, 'serial_events', col))) {
        await db.run(`ALTER TABLE serial_events ADD COLUMN ${col} INT UNSIGNED NULL`);
        applied.push(`เพิ่มคอลัมน์ ${col} ให้ serial_events`);
      }
    }
  }

  // ---- ข้อมูลเก่าที่คอลัมน์ยังว่างอยู่ ----
  for (const table of NEEDS_WAREHOUSE) {
    if (!(await hasTable(db, table))) continue;
    if (!(await hasColumn(db, table, 'warehouse_id'))) continue;
    const { changes } = await db.run(
      `UPDATE ${table} SET warehouse_id = @wh WHERE warehouse_id IS NULL`,
      { wh: defaultWh },
    );
    if (changes) applied.push(`กำหนดคลังให้ข้อมูลเดิมในตาราง ${table} จำนวน ${changes} แถว`);
  }

  // ---- ดัชนีของคอลัมน์คลัง สร้างหลังคอลัมน์พร้อมแล้วเท่านั้น ----
  const lateIndexes = [
    ['serials', 'idx_serials_wh', 'warehouse_id'],
    ['stock_moves', 'idx_moves_wh', 'warehouse_id'],
    ['stock_moves', 'idx_moves_item_wh', 'item_id, warehouse_id'],
  ];
  for (const [table, index, cols] of lateIndexes) {
    if (!(await hasTable(db, table))) continue;
    if (await hasIndex(db, table, index)) continue;
    await db.run(`CREATE INDEX ${index} ON ${table} (${cols})`);
    applied.push(`สร้างดัชนี ${index}`);
  }

  if (applied.length) {
    console.log('ปรับปรุงฐานข้อมูล:');
    applied.forEach((a) => console.log('  -', a));
  }
  return applied;
}
