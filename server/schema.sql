-- ============================================================
--  ระบบจัดการสต็อกอุปกรณ์ไอที (Hardware Stock Management)
--  โครงสร้างฐานข้อมูล SQLite
-- ============================================================

PRAGMA foreign_keys = ON;

-- ------------------------------------------------------------
-- ผู้ใช้งานระบบ
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT    NOT NULL,
  full_name     TEXT    NOT NULL,
  role          TEXT    NOT NULL DEFAULT 'viewer'
                        CHECK (role IN ('admin', 'officer', 'viewer')),
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ------------------------------------------------------------
-- ข้อมูลหลัก (Master data)
-- ------------------------------------------------------------
-- ------------------------------------------------------------
-- คลังสินค้า (รองรับหลายคลัง เช่น MMT และ MTHAI)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS warehouses (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code       TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  name       TEXT    NOT NULL,
  location   TEXT,
  note       TEXT,
  sort_order INTEGER NOT NULL DEFAULT 100,
  active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS categories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code       TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  name       TEXT    NOT NULL,
  -- ใช้จัดกลุ่มคอลัมน์ในรายงานรายเดือน: desktop | laptop | accessory | other
  kind       TEXT    NOT NULL DEFAULT 'other'
                     CHECK (kind IN ('desktop', 'laptop', 'accessory', 'other')),
  sort_order INTEGER NOT NULL DEFAULT 100,
  active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS departments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code       TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  name       TEXT    NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- พนักงานผู้เบิกอุปกรณ์  เช่น "897500 - Tanakit W. / MFG Eng."
CREATE TABLE IF NOT EXISTS employees (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  emp_code      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT    NOT NULL,
  department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  position      TEXT,
  email         TEXT,
  phone         TEXT,
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_employees_dept ON employees(department_id);

-- เจ้าหน้าที่ IS ผู้จ่ายอุปกรณ์ (คอลัมน์ "IS" ในไฟล์เดิม)
CREATE TABLE IF NOT EXISTS is_staff (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  email      TEXT,
  active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS suppliers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code       TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  name       TEXT    NOT NULL,
  contact    TEXT,
  phone      TEXT,
  email      TEXT,
  active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- อุปกรณ์ / สินค้าในคลัง
CREATE TABLE IF NOT EXISTS items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  sku          TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  name         TEXT    NOT NULL,
  category_id  INTEGER NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
  brand        TEXT,
  model        TEXT,
  unit         TEXT    NOT NULL DEFAULT 'EA',
  -- 1 = ต้องระบุ Serial/Asset no. รายชิ้น, 0 = นับเป็นจำนวนรวม
  track_serial INTEGER NOT NULL DEFAULT 0 CHECK (track_serial IN (0, 1)),
  min_qty      INTEGER NOT NULL DEFAULT 0 CHECK (min_qty >= 0),
  unit_cost    REAL    NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  location     TEXT,
  note         TEXT,
  active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_items_category ON items(category_id);
CREATE INDEX IF NOT EXISTS idx_items_active   ON items(active);

-- ------------------------------------------------------------
-- Serial / Asset รายชิ้น
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS serials (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id        INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  serial_no      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  status         TEXT    NOT NULL DEFAULT 'in_stock'
                         CHECK (status IN ('in_stock', 'issued', 'scrapped')),
  holder_id      INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  warehouse_id   INTEGER NOT NULL DEFAULT 1 REFERENCES warehouses(id),
  receipt_id     INTEGER REFERENCES receipts(id) ON DELETE SET NULL,
  issued_at      TEXT,
  received_at    TEXT,
  note           TEXT,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_serials_item   ON serials(item_id);
CREATE INDEX IF NOT EXISTS idx_serials_status ON serials(status);
CREATE INDEX IF NOT EXISTS idx_serials_holder ON serials(holder_id);

-- ประวัติเหตุการณ์ของ Serial รายชิ้น
-- ใช้ทั้งแสดงไทม์ไลน์ของทรัพย์สิน และย้อนสถานะกลับเมื่อยกเลิกเอกสาร
CREATE TABLE IF NOT EXISTS serial_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  serial_id     INTEGER NOT NULL REFERENCES serials(id) ON DELETE CASCADE,
  doc_type      TEXT    NOT NULL CHECK (doc_type IN ('receipt', 'issue', 'return', 'adjustment', 'transfer')),
  doc_id        INTEGER NOT NULL,
  doc_no        TEXT    NOT NULL,
  line_id       INTEGER,
  event         TEXT    NOT NULL CHECK (event IN ('receive', 'issue', 'return', 'scrap', 'transfer')),
  status_before TEXT,
  status_after  TEXT    NOT NULL,
  holder_before INTEGER,
  holder_after  INTEGER,
  wh_before     INTEGER,
  wh_after      INTEGER,
  event_date    TEXT    NOT NULL,
  reversed      INTEGER NOT NULL DEFAULT 0 CHECK (reversed IN (0, 1)),
  note          TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_serial_events_serial ON serial_events(serial_id);
CREATE INDEX IF NOT EXISTS idx_serial_events_doc    ON serial_events(doc_type, doc_id);

-- ------------------------------------------------------------
-- เอกสารรับเข้า (IN)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS receipts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_no       TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  warehouse_id INTEGER NOT NULL DEFAULT 1 REFERENCES warehouses(id),
  receive_date TEXT    NOT NULL,
  po_no        TEXT,
  supplier_id  INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
  note         TEXT,
  status       TEXT    NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'void')),
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  voided_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  voided_at    TEXT,
  void_reason  TEXT
);
CREATE INDEX IF NOT EXISTS idx_receipts_date ON receipts(receive_date);
CREATE INDEX IF NOT EXISTS idx_receipts_po   ON receipts(po_no);

CREATE TABLE IF NOT EXISTS receipt_lines (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_id INTEGER NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
  item_id    INTEGER NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
  qty        INTEGER NOT NULL CHECK (qty > 0),
  unit_cost  REAL    NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  note       TEXT
);
CREATE INDEX IF NOT EXISTS idx_receipt_lines_receipt ON receipt_lines(receipt_id);

-- ------------------------------------------------------------
-- เอกสารเบิกออก (OUT)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS issues (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_no      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  warehouse_id INTEGER NOT NULL DEFAULT 1 REFERENCES warehouses(id),
  issue_date  TEXT    NOT NULL,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  is_staff_id INTEGER REFERENCES is_staff(id) ON DELETE SET NULL,
  -- คอลัมน์ Charge (Y/N) ในไฟล์เดิม
  charge      INTEGER NOT NULL DEFAULT 1 CHECK (charge IN (0, 1)),
  remark      TEXT,
  status      TEXT    NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'void')),
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  voided_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  voided_at   TEXT,
  void_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_issues_date ON issues(issue_date);
CREATE INDEX IF NOT EXISTS idx_issues_emp  ON issues(employee_id);

CREATE TABLE IF NOT EXISTS issue_lines (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  item_id  INTEGER NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
  qty      INTEGER NOT NULL CHECK (qty > 0),
  note     TEXT
);
CREATE INDEX IF NOT EXISTS idx_issue_lines_issue ON issue_lines(issue_id);

-- ------------------------------------------------------------
-- เอกสารรับคืน (RETURN)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS returns (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_no      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  warehouse_id INTEGER NOT NULL DEFAULT 1 REFERENCES warehouses(id),
  return_date TEXT    NOT NULL,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  is_staff_id INTEGER REFERENCES is_staff(id) ON DELETE SET NULL,
  note        TEXT,
  status      TEXT    NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'void')),
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  voided_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  voided_at   TEXT,
  void_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_returns_date ON returns(return_date);

CREATE TABLE IF NOT EXISTS return_lines (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  return_id  INTEGER NOT NULL REFERENCES returns(id) ON DELETE CASCADE,
  item_id    INTEGER NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
  qty        INTEGER NOT NULL CHECK (qty > 0),
  -- good = คืนเข้าคลังใช้ได้, scrap = ชำรุด ตัดออกจากคลัง
  condition  TEXT    NOT NULL DEFAULT 'good' CHECK (condition IN ('good', 'scrap')),
  note       TEXT
);
CREATE INDEX IF NOT EXISTS idx_return_lines_return ON return_lines(return_id);

-- ------------------------------------------------------------
-- เอกสารปรับปรุงสต็อก (ADJUST) เช่น ผลการตรวจนับ
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS adjustments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_no      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  warehouse_id INTEGER NOT NULL DEFAULT 1 REFERENCES warehouses(id),
  adjust_date TEXT    NOT NULL,
  reason      TEXT    NOT NULL DEFAULT 'count'
                      CHECK (reason IN ('count', 'damaged', 'lost', 'found', 'other')),
  note        TEXT,
  status      TEXT    NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'void')),
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  voided_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  voided_at   TEXT,
  void_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_adjustments_date ON adjustments(adjust_date);

CREATE TABLE IF NOT EXISTS adjustment_lines (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  adjustment_id INTEGER NOT NULL REFERENCES adjustments(id) ON DELETE CASCADE,
  item_id       INTEGER NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
  -- จำนวนที่ปรับ (+ เพิ่ม / - ลด) ห้ามเป็น 0
  qty_diff      INTEGER NOT NULL CHECK (qty_diff <> 0),
  note          TEXT
);
CREATE INDEX IF NOT EXISTS idx_adjustment_lines_adj ON adjustment_lines(adjustment_id);

-- ------------------------------------------------------------
-- เอกสารโอนย้ายระหว่างคลัง (TRANSFER)
-- ตัดออกจากคลังต้นทาง และเพิ่มเข้าคลังปลายทางในเอกสารเดียว
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS transfers (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_no            TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  transfer_date     TEXT    NOT NULL,
  from_warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  to_warehouse_id   INTEGER NOT NULL REFERENCES warehouses(id),
  note              TEXT,
  status            TEXT    NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'void')),
  created_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  voided_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  voided_at         TEXT,
  void_reason       TEXT,
  CHECK (from_warehouse_id <> to_warehouse_id)
);
CREATE INDEX IF NOT EXISTS idx_transfers_date ON transfers(transfer_date);

CREATE TABLE IF NOT EXISTS transfer_lines (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  transfer_id INTEGER NOT NULL REFERENCES transfers(id) ON DELETE CASCADE,
  item_id     INTEGER NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
  qty         INTEGER NOT NULL CHECK (qty > 0),
  note        TEXT
);
CREATE INDEX IF NOT EXISTS idx_transfer_lines_transfer ON transfer_lines(transfer_id);

-- ------------------------------------------------------------
-- บัญชีเดินสต็อก (ledger) - เป็นแหล่งข้อมูลจริงของยอดคงเหลือ
-- qty เป็นค่าบวก/ลบ  ยอดคงเหลือ = SUM(qty) ต่อ item
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stock_moves (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id    INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  warehouse_id INTEGER NOT NULL DEFAULT 1 REFERENCES warehouses(id),
  serial_id  INTEGER REFERENCES serials(id) ON DELETE SET NULL,
  serial_no  TEXT,
  move_type  TEXT    NOT NULL
                     CHECK (move_type IN ('IN', 'OUT', 'RETURN', 'ADJUST', 'TRANSFER', 'VOID')),
  qty        INTEGER NOT NULL CHECK (qty <> 0),
  doc_type   TEXT    NOT NULL CHECK (doc_type IN ('receipt', 'issue', 'return', 'adjustment', 'transfer')),
  doc_id     INTEGER NOT NULL,
  doc_no     TEXT    NOT NULL,
  line_id    INTEGER,
  moved_at   TEXT    NOT NULL,
  note       TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_moves_item   ON stock_moves(item_id);
CREATE INDEX IF NOT EXISTS idx_moves_serial ON stock_moves(serial_id);
CREATE INDEX IF NOT EXISTS idx_moves_doc    ON stock_moves(doc_type, doc_id);
CREATE INDEX IF NOT EXISTS idx_moves_date   ON stock_moves(moved_at);

-- ------------------------------------------------------------
-- บันทึกการใช้งานระบบ (audit log)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  username    TEXT,
  action      TEXT NOT NULL,
  entity      TEXT NOT NULL,
  entity_id   INTEGER,
  detail      TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);

-- ------------------------------------------------------------
-- มุมมองยอดคงเหลือ
-- ------------------------------------------------------------
