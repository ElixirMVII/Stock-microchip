import { openDatabase, ensureDatabase, closeDatabase } from './db.js';
import { hashPassword } from './lib/auth.js';
import { load } from './config.js';
import { postIssue, postReceipt, postTransfer } from './services/stock.js';

/* ============================================================
 *  ข้อมูลตั้งต้นของระบบ
 *  - ensureSeed(): สร้างผู้ดูแลระบบและข้อมูลพื้นฐานถ้ายังไม่มี (เรียกทุกครั้งที่เปิดเซิร์ฟเวอร์)
 *  - seedDemo():   ใส่ข้อมูลตัวอย่างตามไฟล์ Excel เดิม สำหรับทดลองใช้งาน
 * ============================================================ */

const WAREHOUSES = [
  { code: 'MMT', name: 'คลัง MMT', location: 'อาคาร MMT', sort_order: 10 },
  { code: 'MTHAI', name: 'คลัง MTHAI', location: 'อาคาร MTHAI', sort_order: 20 },
];

const CATEGORIES = [
  { code: 'DESKTOP', name: 'Desktop / คอมพิวเตอร์ตั้งโต๊ะ', kind: 'desktop', sort_order: 10 },
  { code: 'LAPTOP', name: 'Laptop / โน้ตบุ๊ก', kind: 'laptop', sort_order: 20 },
  { code: 'MONITOR', name: 'Monitor / จอภาพ', kind: 'accessory', sort_order: 30 },
  { code: 'ACC', name: 'Accessories / อุปกรณ์เสริม', kind: 'accessory', sort_order: 40 },
  { code: 'NETWORK', name: 'Network / อุปกรณ์เครือข่าย', kind: 'accessory', sort_order: 50 },
  { code: 'OTHER', name: 'อื่น ๆ', kind: 'other', sort_order: 90 },
];

export async function ensureSeed(db) {
  if ((await db.scalar('SELECT COUNT(*) FROM users')) === 0) {
    const password = load().adminPassword;
    await db.run(
      "INSERT INTO users (username, password_hash, full_name, role, active) VALUES ('admin', @h, 'ผู้ดูแลระบบ', 'admin', 1)",
      { h: hashPassword(password) },
    );
    console.log(`สร้างผู้ใช้เริ่มต้น  username: admin  password: ${password}`);
  }

  // คลังถูกสร้างโดย migration อยู่แล้ว ตรงนี้เติมรายละเอียดให้ครบ
  for (const w of WAREHOUSES) {
    await db.run(`
      INSERT INTO warehouses (code, name, location, sort_order) VALUES (@code, @name, @location, @sort_order)
      ON DUPLICATE KEY UPDATE name = VALUES(name), location = VALUES(location), sort_order = VALUES(sort_order)
    `, w);
  }

  if ((await db.scalar('SELECT COUNT(*) FROM categories')) === 0) {
    for (const c of CATEGORIES) {
      await db.run(
        'INSERT INTO categories (code, name, kind, sort_order) VALUES (@code, @name, @kind, @sort_order)', c,
      );
    }
  }
  return db;
}

/** ข้อมูลตัวอย่างอ้างอิงจากไฟล์ HARDWARE REQUEST 2026 */
export async function seedDemo(db) {
  const idOf = async (table, col, value) =>
    db.scalar(`SELECT id FROM ${table} WHERE ${col} = @v`, { v: value });

  const departments = [
    ['MFG-ENG', 'MFG Eng.'], ['WAREHOUSE', 'Warehouse'], ['QA', 'QA'],
    ['FINANCE', 'Finance'], ['HR', 'HR'], ['IT', 'IT'], ['PROD', 'Production'],
  ];
  for (const [code, name] of departments) {
    await db.run('INSERT IGNORE INTO departments (code, name) VALUES (@c, @n)', { c: code, n: name });
  }

  for (const name of ['Suwan', 'Kittisak', 'Tantkorn']) {
    await db.run('INSERT IGNORE INTO is_staff (name) VALUES (@n)', { n: name });
  }

  await db.run('INSERT IGNORE INTO suppliers (code, name, contact) VALUES (@c, @n, @ct)',
    { c: 'SUP-DELL', n: 'Dell Thailand', ct: 'ฝ่ายขายองค์กร' });
  await db.run('INSERT IGNORE INTO suppliers (code, name, contact) VALUES (@c, @n, @ct)',
    { c: 'SUP-LOCAL', n: 'ร้านอุปกรณ์ไอทีท้องถิ่น', ct: '-' });

  const employees = [
    ['897500', 'Tanakit W.', 'MFG-ENG'], ['893203', 'Somchai P.', 'WAREHOUSE'],
    ['897560', 'Suchada K.', 'QA'], ['891145', 'Nattapong S.', 'MFG-ENG'],
    ['895512', 'Warunee T.', 'FINANCE'], ['894477', 'Pichai R.', 'HR'],
    ['898820', 'Kanya M.', 'PROD'], ['890011', 'Thanarak W.', 'MFG-ENG'],
    ['896633', 'Irada P.', 'FINANCE'], ['892244', 'Wichai L.', 'IT'],
  ];
  for (const [code, name, dept] of employees) {
    await db.run('INSERT IGNORE INTO employees (emp_code, name, department_id) VALUES (@c, @n, @d)',
      { c: code, n: name, d: await idOf('departments', 'code', dept) });
  }

  const items = [
    ['MOUSE-ESD', 'ESD Mouse', 'ACC', 'Logitech', 'ESD-M100', 0, 5, 350],
    ['KB-USB', 'USB Keyboard', 'ACC', 'Logitech', 'K120', 0, 5, 450],
    ['HEADSET', 'Headset USB', 'ACC', 'Jabra', 'Evolve 20', 0, 3, 1800],
    ['CABLE-HDMI', 'สาย HDMI 1.8m', 'ACC', '-', '-', 0, 10, 250],
    ['MON-E1715S', 'Dell 17" monitor E1715S', 'MONITOR', 'Dell', 'E1715S', 1, 2, 4500],
    ['TOKEN-VPN', 'Token VPN', 'ACC', '-', 'SafeNet', 1, 5, 1200],
    ['LT-5440', 'Dell Latitude 5440', 'LAPTOP', 'Dell', 'Latitude 5440', 1, 1, 38000],
    ['LT-7490', 'Dell Latitude 7490', 'LAPTOP', 'Dell', 'Latitude 7490', 1, 1, 32000],
    ['PC-QC5250', 'Dell Pro Slim QC5250', 'DESKTOP', 'Dell', 'Pro Slim QC5250', 1, 1, 25000],
    ['SW-8P', 'Switch 8 Port', 'NETWORK', 'TP-Link', 'TL-SG108', 0, 2, 900],
  ];
  for (const [sku, name, cat, brand, model, ts, min, cost] of items) {
    await db.run(`
      INSERT IGNORE INTO items (sku, name, category_id, brand, model, track_serial, min_qty, unit_cost)
      VALUES (@sku, @name, @cat, @brand, @model, @ts, @min, @cost)
    `, { sku, name, cat: await idOf('categories', 'code', cat), brand, model, ts, min, cost });
  }

  const itemId = (sku) => idOf('items', 'sku', sku);
  const empId = (code) => idOf('employees', 'emp_code', code);
  const staffId = (name) => idOf('is_staff', 'name', name);
  const MMT = await idOf('warehouses', 'code', 'MMT');
  const MTHAI = await idOf('warehouses', 'code', 'MTHAI');
  const admin = await db.scalar("SELECT id FROM users WHERE username = 'admin'");

  if ((await db.scalar('SELECT COUNT(*) FROM receipts')) > 0) {
    console.log('มีข้อมูลเอกสารอยู่แล้ว ข้ามการสร้างตัวอย่างเอกสาร');
    return;
  }

  /* ----- ใบรับเข้า ----- */
  const receipts = [
    { warehouse_id: MMT, receive_date: '2026-07-20', po_no: '22001999', note: 'สั่งซื้อประจำไตรมาส', lines: [
      { item_id: await itemId('MOUSE-ESD'), qty: 17, unit_cost: 350 },
      { item_id: await itemId('KB-USB'), qty: 12, unit_cost: 450 },
      { item_id: await itemId('CABLE-HDMI'), qty: 20, unit_cost: 250 },
    ] },
    { warehouse_id: MMT, receive_date: '2026-07-25', po_no: '22002015', lines: [
      { item_id: await itemId('MON-E1715S'), qty: 8, unit_cost: 4500, serials: [
        'ST:3X76N3', 'ST:2KP76N3', 'ST:6FP76N3', 'ST:8TJ76N3',
        'ST:HP76N3', 'ST:HYC76N3', 'ST:83D76N3', 'ST:4FP76N3'] },
      { item_id: await itemId('MON-E1715S'), qty: 1, unit_cost: 4500, serials: ['ST:3RJ76N3'] },
    ] },
    { warehouse_id: MMT, receive_date: '2026-07-28', po_no: '22002020', lines: [
      { item_id: await itemId('TOKEN-VPN'), qty: 10, unit_cost: 1200, serials: [
        'SN:45-3143412-9', 'SN:45-3143411-2', 'SN:45-3143566-9', 'SN:45-3143570-6',
        'SN:45-3143569-0', 'SN:45-3143567-5', 'SN:45-3143568-3', 'SN:45-3143413-6',
        'SN:45-3143414-3', 'SN:45-3143415-0'] },
    ] },
    { warehouse_id: MMT, receive_date: '2026-08-01', po_no: '22002044', lines: [
      { item_id: await itemId('LT-5440'), qty: 2, unit_cost: 38000, serials: ['ST:6B5R034', 'ST:6B5R088'] },
      { item_id: await itemId('LT-7490'), qty: 1, unit_cost: 32000, serials: ['ST:GR4Z8Y2'] },
      { item_id: await itemId('PC-QC5250'), qty: 2, unit_cost: 25000, serials: ['SN:QC5250-001', 'SN:QC5250-002'] },
      { item_id: await itemId('HEADSET'), qty: 6, unit_cost: 1800 },
      { item_id: await itemId('SW-8P'), qty: 3, unit_cost: 900 },
    ] },
    // รับเข้าที่คลัง MTHAI เพื่อให้เห็นข้อมูลแยกสองคลังชัดเจน
    { warehouse_id: MTHAI, receive_date: '2026-07-22', po_no: '22001999', note: 'จัดสรรให้คลัง MTHAI', lines: [
      { item_id: await itemId('MOUSE-ESD'), qty: 10, unit_cost: 350 },
      { item_id: await itemId('KB-USB'), qty: 8, unit_cost: 450 },
      { item_id: await itemId('HEADSET'), qty: 4, unit_cost: 1800 },
    ] },
    { warehouse_id: MTHAI, receive_date: '2026-08-02', po_no: '22002051', lines: [
      { item_id: await itemId('MON-E1715S'), qty: 3, unit_cost: 4500, serials: ['ST:MT01N3', 'ST:MT02N3', 'ST:MT03N3'] },
      { item_id: await itemId('LT-5440'), qty: 1, unit_cost: 38000, serials: ['ST:MT5440A'] },
      { item_id: await itemId('CABLE-HDMI'), qty: 12, unit_cost: 250 },
    ] },
  ];
  for (const r of receipts) await db.txRetry((t) => postReceipt(t, r, admin));

  /* ----- ใบเบิกออก (ตามตัวอย่างในไฟล์เดิม) ----- */
  const issues = [
    { warehouse_id: MMT, issue_date: '2026-08-01', employee_id: await empId('897500'), is_staff_id: await staffId('Suwan'), charge: true,
      lines: [{ item_id: await itemId('MON-E1715S'), qty: 3, serials: ['ST:3X76N3', 'ST:2KP76N3', 'ST:6FP76N3'] }] },
    { warehouse_id: MMT, issue_date: '2026-08-05', employee_id: await empId('893203'), is_staff_id: await staffId('Suwan'), charge: true,
      lines: [{ item_id: await itemId('TOKEN-VPN'), qty: 1, serials: ['SN:45-3143412-9'] }] },
    { warehouse_id: MMT, issue_date: '2026-08-05', employee_id: await empId('897560'), is_staff_id: await staffId('Suwan'), charge: true,
      lines: [{ item_id: await itemId('TOKEN-VPN'), qty: 1, serials: ['SN:45-3143411-2'] }] },
    { warehouse_id: MMT, issue_date: '2026-08-05', employee_id: await empId('891145'), is_staff_id: await staffId('Suwan'), charge: true,
      lines: [{ item_id: await itemId('TOKEN-VPN'), qty: 1, serials: ['SN:45-3143566-9'] }] },
    { warehouse_id: MMT, issue_date: '2026-08-08', employee_id: await empId('890011'), is_staff_id: await staffId('Kittisak'), charge: false,
      remark: 'Use old laptop B78470 - Thanarak Wisassing / Eng. MFG',
      lines: [{ item_id: await itemId('LT-5440'), qty: 1, serials: ['ST:6B5R034'] }] },
    { warehouse_id: MMT, issue_date: '2026-08-10', employee_id: await empId('897500'), is_staff_id: await staffId('Kittisak'), charge: true,
      lines: [{ item_id: await itemId('MON-E1715S'), qty: 5, serials: ['ST:8TJ76N3', 'ST:HP76N3', 'ST:HYC76N3', 'ST:83D76N3', 'ST:4FP76N3'] }] },
    { warehouse_id: MMT, issue_date: '2026-08-11', employee_id: await empId('898820'), is_staff_id: await staffId('Tantkorn'), charge: true,
      lines: [{ item_id: await itemId('PC-QC5250'), qty: 1, serials: ['SN:QC5250-001'] }] },
    { warehouse_id: MMT, issue_date: '2026-08-17', employee_id: await empId('895512'), is_staff_id: await staffId('Suwan'), charge: true,
      lines: [{ item_id: await itemId('TOKEN-VPN'), qty: 1, serials: ['SN:45-3143570-6'] },
              { item_id: await itemId('MOUSE-ESD'), qty: 2 }] },
    { warehouse_id: MMT, issue_date: '2026-08-17', employee_id: await empId('894477'), is_staff_id: await staffId('Suwan'), charge: true,
      lines: [{ item_id: await itemId('TOKEN-VPN'), qty: 1, serials: ['SN:45-3143569-0'] }] },
    { warehouse_id: MMT, issue_date: '2026-08-28', employee_id: await empId('896633'), is_staff_id: await staffId('Kittisak'), charge: false,
      remark: 'Use old laptop B19686 - Irada P. / Finance',
      lines: [{ item_id: await itemId('LT-7490'), qty: 1, serials: ['ST:GR4Z8Y2'] }] },
    { warehouse_id: MTHAI, issue_date: '2026-09-02', employee_id: await empId('892244'), is_staff_id: await staffId('Suwan'), charge: true,
      lines: [{ item_id: await itemId('MOUSE-ESD'), qty: 3 }, { item_id: await itemId('KB-USB'), qty: 3 }] },
    { warehouse_id: MTHAI, issue_date: '2026-09-10', employee_id: await empId('898820'), is_staff_id: await staffId('Tantkorn'), charge: true,
      lines: [{ item_id: await itemId('HEADSET'), qty: 2 }, { item_id: await itemId('CABLE-HDMI'), qty: 4 }] },
  ];
  for (const i of issues) await db.txRetry((t) => postIssue(t, i, admin));

  // ตัวอย่างการโอนย้ายระหว่างคลัง (หาค่า id ให้ครบก่อน เพราะ callback ของ tx ไม่ใช่ async)
  const transferDoc = {
    transfer_date: '2026-09-12',
    from_warehouse_id: MMT,
    to_warehouse_id: MTHAI,
    note: 'เกลี่ยสต็อกให้คลัง MTHAI',
    lines: [
      { item_id: await itemId('MOUSE-ESD'), qty: 5 },
      { item_id: await itemId('SW-8P'), qty: 1 },
    ],
  };
  await db.txRetry((t) => postTransfer(t, transferDoc, admin));

  console.log('สร้างข้อมูลตัวอย่างเรียบร้อย');
}

/** ลบข้อมูลทุกตาราง (ใช้กับ --reset) โดยไม่ลบตัวฐานข้อมูล */
export async function truncateAll(db) {
  const tables = [
    'stock_moves', 'serial_events', 'serials',
    'receipt_lines', 'receipts', 'issue_lines', 'issues',
    'return_lines', 'returns', 'adjustment_lines', 'adjustments',
    'transfer_lines', 'transfers', 'audit_logs',
    'items', 'employees', 'is_staff', 'suppliers', 'departments', 'categories',
    'warehouses', 'users',
  ];
  await db.run('SET FOREIGN_KEY_CHECKS = 0');
  try {
    for (const t of tables) await db.run(`TRUNCATE TABLE ${t}`);
  } finally {
    await db.run('SET FOREIGN_KEY_CHECKS = 1');
  }
  console.log('ล้างข้อมูลทุกตารางแล้ว');
}

/* ---------------- เรียกใช้จากบรรทัดคำสั่ง ---------------- */
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  try {
    await ensureDatabase();
    const db = await openDatabase();
    if (args.includes('--reset')) {
      await truncateAll(db);
      // migration สร้างคลังเริ่มต้นตอนเปิดฐานข้อมูล แต่ TRUNCATE ลบไปแล้ว จึงต้องสร้างใหม่
      const { runMigrations } = await import('./migrations.js');
      await runMigrations(db);
    }
    await ensureSeed(db);
    if (args.includes('--demo')) await seedDemo(db);
    await db.close();
    console.log('เสร็จสิ้น');
  } catch (err) {
    console.error('ไม่สำเร็จ:', err.message);
    await closeDatabase().catch(() => {});
    process.exit(1);
  }
}
