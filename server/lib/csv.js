/** แปลงข้อมูลเป็น CSV (ใส่ BOM ให้ Excel อ่านภาษาไทยได้ถูกต้อง) */
export function toCsv(rows, columns) {
  const keys = Object.keys(columns);
  const esc = (v) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = keys.map((k) => esc(columns[k])).join(',');
  const body = rows.map((r) => keys.map((k) => esc(r[k])).join(',')).join('\r\n');
  return `﻿${head}\r\n${body}`;
}
