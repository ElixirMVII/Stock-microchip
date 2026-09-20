-- ============================================================
--  ระบบจัดการสต็อกอุปกรณ์ไอที (Hardware Stock Management)
--  โครงสร้างฐานข้อมูล MySQL / MariaDB  —  ฐานข้อมูล: Stock-MC
--
--  หมายเหตุสำหรับผู้แก้ไข
--  - ประกาศ index ไว้ใน CREATE TABLE เลย เพราะ MySQL 8 ไม่รองรับ
--    CREATE INDEX IF NOT EXISTS (MariaDB รองรับ แต่เขียนแบบนี้ใช้ได้ทั้งคู่)
--  - FOREIGN KEY ต้องประกาศเป็น constraint แยก เพราะ MySQL จะ "อ่านผ่าน"
--    REFERENCES ที่เขียนติดกับคอลัมน์โดยไม่บังคับใช้จริง
--  - collation utf8mb4_unicode_ci เทียบตัวอักษรแบบไม่สนตัวพิมพ์ใหญ่เล็กอยู่แล้ว
--    จึงไม่ต้องใช้ COLLATE NOCASE เหมือนเวอร์ชัน SQLite
-- ============================================================

-- ------------------------------------------------------------
-- ผู้ใช้งานระบบ
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  username      VARCHAR(60)  NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  full_name     VARCHAR(160) NOT NULL,
  role          VARCHAR(20)  NOT NULL DEFAULT 'viewer',
  active        TINYINT(1)   NOT NULL DEFAULT 1,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_username (username),
  CONSTRAINT ck_users_role CHECK (role IN ('admin', 'officer', 'viewer')),
  CONSTRAINT ck_users_active CHECK (active IN (0, 1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- คลังสินค้า (รองรับหลายคลัง เช่น MMT และ MTHAI)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS warehouses (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  code       VARCHAR(30)  NOT NULL,
  name       VARCHAR(120) NOT NULL,
  location   VARCHAR(200) NULL,
  note       TEXT         NULL,
  sort_order INT          NOT NULL DEFAULT 100,
  active     TINYINT(1)   NOT NULL DEFAULT 1,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_warehouses_code (code),
  CONSTRAINT ck_warehouses_active CHECK (active IN (0, 1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- ข้อมูลหลัก (Master data)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS categories (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  code       VARCHAR(30)  NOT NULL,
  name       VARCHAR(120) NOT NULL,
  -- ใช้จัดกลุ่มคอลัมน์ในรายงานรายเดือน: desktop | laptop | accessory | other
  kind       VARCHAR(20)  NOT NULL DEFAULT 'other',
  sort_order INT          NOT NULL DEFAULT 100,
  active     TINYINT(1)   NOT NULL DEFAULT 1,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_categories_code (code),
  CONSTRAINT ck_categories_kind CHECK (kind IN ('desktop', 'laptop', 'accessory', 'other')),
  CONSTRAINT ck_categories_active CHECK (active IN (0, 1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS departments (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  code       VARCHAR(30)  NOT NULL,
  name       VARCHAR(120) NOT NULL,
  active     TINYINT(1)   NOT NULL DEFAULT 1,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_departments_code (code),
  CONSTRAINT ck_departments_active CHECK (active IN (0, 1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- พนักงานผู้เบิกอุปกรณ์  เช่น "897500 - Tanakit W. / MFG Eng."
CREATE TABLE IF NOT EXISTS employees (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  emp_code      VARCHAR(40)  NOT NULL,
  name          VARCHAR(160) NOT NULL,
  department_id INT UNSIGNED NULL,
  position      VARCHAR(120) NULL,
  email         VARCHAR(160) NULL,
  phone         VARCHAR(60)  NULL,
  active        TINYINT(1)   NOT NULL DEFAULT 1,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_employees_code (emp_code),
  KEY idx_employees_dept (department_id),
  CONSTRAINT fk_employees_dept FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE SET NULL,
  CONSTRAINT ck_employees_active CHECK (active IN (0, 1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- เจ้าหน้าที่ IS ผู้จ่ายอุปกรณ์ (คอลัมน์ "IS" ในไฟล์เดิม)
CREATE TABLE IF NOT EXISTS is_staff (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name       VARCHAR(120) NOT NULL,
  email      VARCHAR(160) NULL,
  active     TINYINT(1)   NOT NULL DEFAULT 1,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_is_staff_name (name),
  CONSTRAINT ck_is_staff_active CHECK (active IN (0, 1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS suppliers (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  code       VARCHAR(40)  NOT NULL,
  name       VARCHAR(160) NOT NULL,
  contact    VARCHAR(160) NULL,
  phone      VARCHAR(60)  NULL,
  email      VARCHAR(160) NULL,
  active     TINYINT(1)   NOT NULL DEFAULT 1,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_suppliers_code (code),
  CONSTRAINT ck_suppliers_active CHECK (active IN (0, 1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- อุปกรณ์ / สินค้าในคลัง
CREATE TABLE IF NOT EXISTS items (
  id           INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  sku          VARCHAR(60)   NOT NULL,
  name         VARCHAR(200)  NOT NULL,
  category_id  INT UNSIGNED  NOT NULL,
  brand        VARCHAR(80)   NULL,
  model        VARCHAR(120)  NULL,
  unit         VARCHAR(20)   NOT NULL DEFAULT 'EA',
  -- 1 = ต้องระบุ Serial/Asset no. รายชิ้น, 0 = นับเป็นจำนวนรวม
  track_serial TINYINT(1)    NOT NULL DEFAULT 0,
  min_qty      INT           NOT NULL DEFAULT 0,
  unit_cost    DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  location     VARCHAR(120)  NULL,
  note         TEXT          NULL,
  active       TINYINT(1)    NOT NULL DEFAULT 1,
  created_at   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_items_sku (sku),
  KEY idx_items_category (category_id),
  KEY idx_items_active (active),
  CONSTRAINT fk_items_category FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE RESTRICT,
  CONSTRAINT ck_items_track CHECK (track_serial IN (0, 1)),
  CONSTRAINT ck_items_active CHECK (active IN (0, 1)),
  CONSTRAINT ck_items_min_qty CHECK (min_qty >= 0),
  CONSTRAINT ck_items_cost CHECK (unit_cost >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- เอกสารรับเข้า (IN)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS receipts (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  doc_no       VARCHAR(40)  NOT NULL,
  warehouse_id INT UNSIGNED NOT NULL DEFAULT 1,
  receive_date DATE         NOT NULL,
  po_no        VARCHAR(60)  NULL,
  supplier_id  INT UNSIGNED NULL,
  note         TEXT         NULL,
  status       VARCHAR(10)  NOT NULL DEFAULT 'posted',
  created_by   INT UNSIGNED NULL,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  voided_by    INT UNSIGNED NULL,
  voided_at    DATETIME     NULL,
  void_reason  VARCHAR(300) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_receipts_doc (doc_no),
  KEY idx_receipts_date (receive_date),
  KEY idx_receipts_po (po_no),
  KEY idx_receipts_wh (warehouse_id),
  KEY idx_receipts_supplier (supplier_id),
  KEY idx_receipts_created_by (created_by),
  KEY idx_receipts_voided_by (voided_by),
  CONSTRAINT fk_receipts_wh FOREIGN KEY (warehouse_id) REFERENCES warehouses(id),
  CONSTRAINT fk_receipts_supplier FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE SET NULL,
  CONSTRAINT fk_receipts_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_receipts_voided_by FOREIGN KEY (voided_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT ck_receipts_status CHECK (status IN ('posted', 'void'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS receipt_lines (
  id         INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  receipt_id INT UNSIGNED  NOT NULL,
  item_id    INT UNSIGNED  NOT NULL,
  qty        INT           NOT NULL,
  unit_cost  DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  note       TEXT          NULL,
  PRIMARY KEY (id),
  KEY idx_receipt_lines_receipt (receipt_id),
  KEY idx_receipt_lines_item (item_id),
  CONSTRAINT fk_receipt_lines_receipt FOREIGN KEY (receipt_id) REFERENCES receipts(id) ON DELETE CASCADE,
  CONSTRAINT fk_receipt_lines_item FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE RESTRICT,
  CONSTRAINT ck_receipt_lines_qty CHECK (qty > 0),
  CONSTRAINT ck_receipt_lines_cost CHECK (unit_cost >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- Serial / Asset รายชิ้น
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS serials (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  item_id      INT UNSIGNED NOT NULL,
  serial_no    VARCHAR(100) NOT NULL,
  status       VARCHAR(20)  NOT NULL DEFAULT 'in_stock',
  holder_id    INT UNSIGNED NULL,
  warehouse_id INT UNSIGNED NOT NULL DEFAULT 1,
  receipt_id   INT UNSIGNED NULL,
  issued_at    DATE         NULL,
  received_at  DATE         NULL,
  note         TEXT         NULL,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_serials_no (serial_no),
  KEY idx_serials_item (item_id),
  KEY idx_serials_status (status),
  KEY idx_serials_holder (holder_id),
  KEY idx_serials_wh (warehouse_id),
  KEY idx_serials_receipt (receipt_id),
  CONSTRAINT fk_serials_item FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE,
  CONSTRAINT fk_serials_holder FOREIGN KEY (holder_id) REFERENCES employees(id) ON DELETE SET NULL,
  CONSTRAINT fk_serials_wh FOREIGN KEY (warehouse_id) REFERENCES warehouses(id),
  CONSTRAINT fk_serials_receipt FOREIGN KEY (receipt_id) REFERENCES receipts(id) ON DELETE SET NULL,
  CONSTRAINT ck_serials_status CHECK (status IN ('in_stock', 'issued', 'scrapped'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ประวัติเหตุการณ์ของ Serial รายชิ้น
-- ใช้ทั้งแสดงไทม์ไลน์ของทรัพย์สิน และย้อนสถานะกลับเมื่อยกเลิกเอกสาร
CREATE TABLE IF NOT EXISTS serial_events (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  serial_id     INT UNSIGNED NOT NULL,
  doc_type      VARCHAR(20)  NOT NULL,
  doc_id        INT UNSIGNED NOT NULL,
  doc_no        VARCHAR(40)  NOT NULL,
  line_id       INT UNSIGNED NULL,
  event         VARCHAR(20)  NOT NULL,
  status_before VARCHAR(20)  NULL,
  status_after  VARCHAR(20)  NOT NULL,
  holder_before INT UNSIGNED NULL,
  holder_after  INT UNSIGNED NULL,
  wh_before     INT UNSIGNED NULL,
  wh_after      INT UNSIGNED NULL,
  event_date    DATE         NOT NULL,
  reversed      TINYINT(1)   NOT NULL DEFAULT 0,
  note          TEXT         NULL,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_serial_events_serial (serial_id),
  KEY idx_serial_events_doc (doc_type, doc_id),
  CONSTRAINT fk_serial_events_serial FOREIGN KEY (serial_id) REFERENCES serials(id) ON DELETE CASCADE,
  CONSTRAINT ck_serial_events_doc CHECK (doc_type IN ('receipt', 'issue', 'return', 'adjustment', 'transfer')),
  CONSTRAINT ck_serial_events_event CHECK (event IN ('receive', 'issue', 'return', 'scrap', 'transfer')),
  CONSTRAINT ck_serial_events_reversed CHECK (reversed IN (0, 1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- เอกสารเบิกออก (OUT)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS issues (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  doc_no       VARCHAR(40)  NOT NULL,
  warehouse_id INT UNSIGNED NOT NULL DEFAULT 1,
  issue_date   DATE         NOT NULL,
  employee_id  INT UNSIGNED NOT NULL,
  is_staff_id  INT UNSIGNED NULL,
  -- คอลัมน์ Charge (Y/N) ในไฟล์เดิม
  charge       TINYINT(1)   NOT NULL DEFAULT 1,
  remark       TEXT         NULL,
  status       VARCHAR(10)  NOT NULL DEFAULT 'posted',
  created_by   INT UNSIGNED NULL,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  voided_by    INT UNSIGNED NULL,
  voided_at    DATETIME     NULL,
  void_reason  VARCHAR(300) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_issues_doc (doc_no),
  KEY idx_issues_date (issue_date),
  KEY idx_issues_emp (employee_id),
  KEY idx_issues_wh (warehouse_id),
  KEY idx_issues_staff (is_staff_id),
  KEY idx_issues_created_by (created_by),
  KEY idx_issues_voided_by (voided_by),
  CONSTRAINT fk_issues_wh FOREIGN KEY (warehouse_id) REFERENCES warehouses(id),
  CONSTRAINT fk_issues_emp FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE RESTRICT,
  CONSTRAINT fk_issues_staff FOREIGN KEY (is_staff_id) REFERENCES is_staff(id) ON DELETE SET NULL,
  CONSTRAINT fk_issues_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_issues_voided_by FOREIGN KEY (voided_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT ck_issues_charge CHECK (charge IN (0, 1)),
  CONSTRAINT ck_issues_status CHECK (status IN ('posted', 'void'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS issue_lines (
  id       INT UNSIGNED NOT NULL AUTO_INCREMENT,
  issue_id INT UNSIGNED NOT NULL,
  item_id  INT UNSIGNED NOT NULL,
  qty      INT          NOT NULL,
  note     TEXT         NULL,
  PRIMARY KEY (id),
  KEY idx_issue_lines_issue (issue_id),
  KEY idx_issue_lines_item (item_id),
  CONSTRAINT fk_issue_lines_issue FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE,
  CONSTRAINT fk_issue_lines_item FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE RESTRICT,
  CONSTRAINT ck_issue_lines_qty CHECK (qty > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- เอกสารรับคืน (RETURN)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS returns (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  doc_no       VARCHAR(40)  NOT NULL,
  warehouse_id INT UNSIGNED NOT NULL DEFAULT 1,
  return_date  DATE         NOT NULL,
  employee_id  INT UNSIGNED NOT NULL,
  is_staff_id  INT UNSIGNED NULL,
  note         TEXT         NULL,
  status       VARCHAR(10)  NOT NULL DEFAULT 'posted',
  created_by   INT UNSIGNED NULL,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  voided_by    INT UNSIGNED NULL,
  voided_at    DATETIME     NULL,
  void_reason  VARCHAR(300) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_returns_doc (doc_no),
  KEY idx_returns_date (return_date),
  KEY idx_returns_wh (warehouse_id),
  KEY idx_returns_emp (employee_id),
  KEY idx_returns_staff (is_staff_id),
  KEY idx_returns_created_by (created_by),
  KEY idx_returns_voided_by (voided_by),
  CONSTRAINT fk_returns_wh FOREIGN KEY (warehouse_id) REFERENCES warehouses(id),
  CONSTRAINT fk_returns_emp FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE RESTRICT,
  CONSTRAINT fk_returns_staff FOREIGN KEY (is_staff_id) REFERENCES is_staff(id) ON DELETE SET NULL,
  CONSTRAINT fk_returns_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_returns_voided_by FOREIGN KEY (voided_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT ck_returns_status CHECK (status IN ('posted', 'void'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS return_lines (
  id        INT UNSIGNED NOT NULL AUTO_INCREMENT,
  return_id INT UNSIGNED NOT NULL,
  item_id   INT UNSIGNED NOT NULL,
  qty       INT          NOT NULL,
  -- good = คืนเข้าคลังใช้ได้, scrap = ชำรุด ตัดออกจากคลัง
  `condition` VARCHAR(10) NOT NULL DEFAULT 'good',
  note      TEXT         NULL,
  PRIMARY KEY (id),
  KEY idx_return_lines_return (return_id),
  KEY idx_return_lines_item (item_id),
  CONSTRAINT fk_return_lines_return FOREIGN KEY (return_id) REFERENCES returns(id) ON DELETE CASCADE,
  CONSTRAINT fk_return_lines_item FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE RESTRICT,
  CONSTRAINT ck_return_lines_qty CHECK (qty > 0),
  CONSTRAINT ck_return_lines_cond CHECK (`condition` IN ('good', 'scrap'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- เอกสารปรับปรุงสต็อก (ADJUST) เช่น ผลการตรวจนับ
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS adjustments (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  doc_no       VARCHAR(40)  NOT NULL,
  warehouse_id INT UNSIGNED NOT NULL DEFAULT 1,
  adjust_date  DATE         NOT NULL,
  reason       VARCHAR(20)  NOT NULL DEFAULT 'count',
  note         TEXT         NULL,
  status       VARCHAR(10)  NOT NULL DEFAULT 'posted',
  created_by   INT UNSIGNED NULL,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  voided_by    INT UNSIGNED NULL,
  voided_at    DATETIME     NULL,
  void_reason  VARCHAR(300) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_adjustments_doc (doc_no),
  KEY idx_adjustments_date (adjust_date),
  KEY idx_adjustments_wh (warehouse_id),
  KEY idx_adjustments_created_by (created_by),
  KEY idx_adjustments_voided_by (voided_by),
  CONSTRAINT fk_adjustments_wh FOREIGN KEY (warehouse_id) REFERENCES warehouses(id),
  CONSTRAINT fk_adjustments_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_adjustments_voided_by FOREIGN KEY (voided_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT ck_adjustments_reason CHECK (reason IN ('count', 'damaged', 'lost', 'found', 'other')),
  CONSTRAINT ck_adjustments_status CHECK (status IN ('posted', 'void'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS adjustment_lines (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  adjustment_id INT UNSIGNED NOT NULL,
  item_id       INT UNSIGNED NOT NULL,
  -- จำนวนที่ปรับ (+ เพิ่ม / - ลด) ห้ามเป็น 0
  qty_diff      INT          NOT NULL,
  note          TEXT         NULL,
  PRIMARY KEY (id),
  KEY idx_adjustment_lines_adj (adjustment_id),
  KEY idx_adjustment_lines_item (item_id),
  CONSTRAINT fk_adjustment_lines_adj FOREIGN KEY (adjustment_id) REFERENCES adjustments(id) ON DELETE CASCADE,
  CONSTRAINT fk_adjustment_lines_item FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE RESTRICT,
  CONSTRAINT ck_adjustment_lines_qty CHECK (qty_diff <> 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- เอกสารโอนย้ายระหว่างคลัง (TRANSFER)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS transfers (
  id                INT UNSIGNED NOT NULL AUTO_INCREMENT,
  doc_no            VARCHAR(40)  NOT NULL,
  transfer_date     DATE         NOT NULL,
  from_warehouse_id INT UNSIGNED NOT NULL,
  to_warehouse_id   INT UNSIGNED NOT NULL,
  note              TEXT         NULL,
  status            VARCHAR(10)  NOT NULL DEFAULT 'posted',
  created_by        INT UNSIGNED NULL,
  created_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  voided_by         INT UNSIGNED NULL,
  voided_at         DATETIME     NULL,
  void_reason       VARCHAR(300) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_transfers_doc (doc_no),
  KEY idx_transfers_date (transfer_date),
  KEY idx_transfers_from (from_warehouse_id),
  KEY idx_transfers_to (to_warehouse_id),
  KEY idx_transfers_created_by (created_by),
  KEY idx_transfers_voided_by (voided_by),
  CONSTRAINT fk_transfers_from FOREIGN KEY (from_warehouse_id) REFERENCES warehouses(id),
  CONSTRAINT fk_transfers_to FOREIGN KEY (to_warehouse_id) REFERENCES warehouses(id),
  CONSTRAINT fk_transfers_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_transfers_voided_by FOREIGN KEY (voided_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT ck_transfers_status CHECK (status IN ('posted', 'void')),
  CONSTRAINT ck_transfers_diff CHECK (from_warehouse_id <> to_warehouse_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS transfer_lines (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  transfer_id INT UNSIGNED NOT NULL,
  item_id     INT UNSIGNED NOT NULL,
  qty         INT          NOT NULL,
  note        TEXT         NULL,
  PRIMARY KEY (id),
  KEY idx_transfer_lines_transfer (transfer_id),
  KEY idx_transfer_lines_item (item_id),
  CONSTRAINT fk_transfer_lines_transfer FOREIGN KEY (transfer_id) REFERENCES transfers(id) ON DELETE CASCADE,
  CONSTRAINT fk_transfer_lines_item FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE RESTRICT,
  CONSTRAINT ck_transfer_lines_qty CHECK (qty > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- บัญชีเดินสต็อก (ledger) - เป็นแหล่งข้อมูลจริงของยอดคงเหลือ
-- qty เป็นค่าบวก/ลบ  ยอดคงเหลือ = SUM(qty) ต่อ item (และต่อคลัง)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stock_moves (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  item_id      INT UNSIGNED NOT NULL,
  warehouse_id INT UNSIGNED NOT NULL DEFAULT 1,
  serial_id    INT UNSIGNED NULL,
  serial_no    VARCHAR(100) NULL,
  move_type    VARCHAR(12)  NOT NULL,
  qty          INT          NOT NULL,
  doc_type     VARCHAR(20)  NOT NULL,
  doc_id       INT UNSIGNED NOT NULL,
  doc_no       VARCHAR(40)  NOT NULL,
  line_id      INT UNSIGNED NULL,
  moved_at     DATE         NOT NULL,
  note         TEXT         NULL,
  created_by   INT UNSIGNED NULL,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_moves_item (item_id),
  KEY idx_moves_serial (serial_id),
  KEY idx_moves_doc (doc_type, doc_id),
  KEY idx_moves_date (moved_at),
  KEY idx_moves_wh (warehouse_id),
  KEY idx_moves_item_wh (item_id, warehouse_id),
  KEY idx_moves_created_by (created_by),
  CONSTRAINT fk_moves_item FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE,
  CONSTRAINT fk_moves_wh FOREIGN KEY (warehouse_id) REFERENCES warehouses(id),
  CONSTRAINT fk_moves_serial FOREIGN KEY (serial_id) REFERENCES serials(id) ON DELETE SET NULL,
  CONSTRAINT fk_moves_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT ck_moves_type CHECK (move_type IN ('IN', 'OUT', 'RETURN', 'ADJUST', 'TRANSFER', 'VOID')),
  CONSTRAINT ck_moves_doc CHECK (doc_type IN ('receipt', 'issue', 'return', 'adjustment', 'transfer')),
  CONSTRAINT ck_moves_qty CHECK (qty <> 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- บันทึกการใช้งานระบบ (audit log)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_logs (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id    INT UNSIGNED NULL,
  username   VARCHAR(60)  NULL,
  action     VARCHAR(40)  NOT NULL,
  entity     VARCHAR(40)  NOT NULL,
  entity_id  INT UNSIGNED NULL,
  detail     VARCHAR(500) NULL,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_audit_created (created_at),
  KEY idx_audit_user (user_id),
  CONSTRAINT fk_audit_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
