-- ============================================================
--  มุมมองยอดคงเหลือ
--  แยกไว้คนละไฟล์กับตาราง เพราะต้องสร้างหลังการ migrate เสร็จแล้ว
--  (view อ้างถึงคอลัมน์ที่ migration เป็นคนเพิ่มให้ฐานข้อมูลเก่า)
-- ============================================================

DROP VIEW IF EXISTS v_stock_balance;
DROP VIEW IF EXISTS v_stock_balance_wh;

-- ยอดคงเหลือ "แยกรายคลัง" — ทุกคู่ (อุปกรณ์ × คลัง) แม้ยังไม่เคยมีของ
CREATE VIEW v_stock_balance_wh AS
SELECT
  i.id                                  AS item_id,
  w.id                                  AS warehouse_id,
  w.code                                AS warehouse_code,
  w.name                                AS warehouse_name,
  i.sku, i.name, i.brand, i.model, i.unit,
  i.track_serial, i.min_qty, i.unit_cost, i.location, i.active,
  c.id                                  AS category_id,
  c.name                                AS category_name,
  c.kind                                AS category_kind,
  COALESCE(m.qty_in,  0)                AS total_in,
  COALESCE(m.qty_out, 0)                AS total_out,
  COALESCE(m.balance, 0)                AS balance,
  COALESCE(m.balance, 0) * i.unit_cost  AS stock_value
FROM items i
JOIN categories c ON c.id = i.category_id
JOIN warehouses w ON w.active = 1
LEFT JOIN (
  SELECT item_id, warehouse_id,
         SUM(CASE WHEN qty > 0 THEN qty ELSE 0 END)  AS qty_in,
         SUM(CASE WHEN qty < 0 THEN -qty ELSE 0 END) AS qty_out,
         SUM(qty)                                    AS balance
  FROM stock_moves
  GROUP BY item_id, warehouse_id
) m ON m.item_id = i.id AND m.warehouse_id = w.id;

-- ยอดคงเหลือ "รวมทุกคลัง"
CREATE VIEW v_stock_balance AS
SELECT
  i.id                                            AS id,
  i.id                                            AS item_id,
  i.sku, i.name, i.brand, i.model, i.unit,
  i.track_serial, i.min_qty, i.unit_cost, i.location, i.active,
  c.id                                            AS category_id,
  c.name                                          AS category_name,
  c.kind                                          AS category_kind,
  COALESCE(m.qty_in,  0)                          AS total_in,
  COALESCE(m.qty_out, 0)                          AS total_out,
  COALESCE(m.balance, 0)                          AS balance,
  COALESCE(m.balance, 0) * i.unit_cost            AS stock_value
FROM items i
JOIN categories c ON c.id = i.category_id
LEFT JOIN (
  SELECT item_id,
         SUM(CASE WHEN qty > 0 THEN qty ELSE 0 END)  AS qty_in,
         SUM(CASE WHEN qty < 0 THEN -qty ELSE 0 END) AS qty_out,
         SUM(qty)                                    AS balance
  FROM stock_moves
  GROUP BY item_id
) m ON m.item_id = i.id;
