import { badRequest } from './http.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function str(value, field, { required = true, max = 255, min = 1, trim = true } = {}) {
  let v = value == null ? '' : String(value);
  if (trim) v = v.trim();
  if (!v) {
    if (required) throw badRequest(`กรุณาระบุ "${field}"`);
    return null;
  }
  if (v.length < min) throw badRequest(`"${field}" ต้องมีอย่างน้อย ${min} ตัวอักษร`);
  if (v.length > max) throw badRequest(`"${field}" ต้องไม่เกิน ${max} ตัวอักษร`);
  return v;
}

export function int(value, field, { required = true, min = null, max = null, def = null } = {}) {
  if (value === '' || value == null) {
    if (required) throw badRequest(`กรุณาระบุ "${field}"`);
    return def;
  }
  const n = Number(value);
  if (!Number.isInteger(n)) throw badRequest(`"${field}" ต้องเป็นจำนวนเต็ม`);
  if (min != null && n < min) throw badRequest(`"${field}" ต้องไม่น้อยกว่า ${min}`);
  if (max != null && n > max) throw badRequest(`"${field}" ต้องไม่เกิน ${max}`);
  return n;
}

export function num(value, field, { required = true, min = null, def = 0 } = {}) {
  if (value === '' || value == null) {
    if (required) throw badRequest(`กรุณาระบุ "${field}"`);
    return def;
  }
  const n = Number(value);
  if (!Number.isFinite(n)) throw badRequest(`"${field}" ต้องเป็นตัวเลข`);
  if (min != null && n < min) throw badRequest(`"${field}" ต้องไม่น้อยกว่า ${min}`);
  return n;
}

export function bool(value, def = false) {
  if (value == null || value === '') return def;
  if (typeof value === 'boolean') return value;
  const v = String(value).toLowerCase();
  return v === '1' || v === 'true' || v === 'y' || v === 'yes' || v === 'on';
}

/** รับวันที่รูปแบบ YYYY-MM-DD เท่านั้น และตรวจว่าเป็นวันที่ที่มีอยู่จริง */
export function date(value, field, { required = true } = {}) {
  const v = str(value, field, { required, max: 10 });
  if (v == null) return null;
  if (!DATE_RE.test(v)) throw badRequest(`"${field}" ต้องอยู่ในรูปแบบ YYYY-MM-DD`);
  const [y, m, d] = v.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    throw badRequest(`"${field}" ไม่ใช่วันที่ที่ถูกต้อง`);
  }
  return v;
}

export function oneOf(value, field, allowed, { required = true, def = null } = {}) {
  if (value == null || value === '') {
    if (required) throw badRequest(`กรุณาระบุ "${field}"`);
    return def;
  }
  const v = String(value);
  if (!allowed.includes(v)) {
    throw badRequest(`"${field}" ต้องเป็นค่าใดค่าหนึ่งใน: ${allowed.join(', ')}`);
  }
  return v;
}

export function arr(value, field, { min = 1 } = {}) {
  if (!Array.isArray(value)) throw badRequest(`"${field}" ต้องเป็นรายการ (array)`);
  if (value.length < min) throw badRequest(`กรุณาระบุ "${field}" อย่างน้อย ${min} รายการ`);
  return value;
}

export const today = () => new Date().toISOString().slice(0, 10);
export const nowIso = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
