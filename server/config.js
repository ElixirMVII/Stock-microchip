import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* ============================================================
 *  การตั้งค่าระบบ
 *  อ่านจาก config.ini ที่อยู่ข้าง package.json (รูปแบบเดียวกับโปรเจกต์อื่น
 *  ในองค์กร) และให้ environment variable มีสิทธิ์ทับค่าในไฟล์ได้
 *  ไฟล์ config.ini ไม่ถูก track ใน git เพราะมีรหัสผ่าน
 * ============================================================ */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const BASE_DIR = path.join(__dirname, '..');
export const CONFIG_PATH = process.env.CONFIG_FILE || path.join(BASE_DIR, 'config.ini');

/** อ่านไฟล์ .ini แบบง่าย ๆ (รองรับ section, key=value และคอมเมนต์ # หรือ ;) */
export function parseIni(text) {
  const out = {};
  let section = '';
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const sec = line.match(/^\[(.+)\]$/);
    if (sec) { section = sec[1].trim().toLowerCase(); out[section] ??= {}; continue; }
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    let value = line.slice(eq + 1).trim();
    // รองรับค่าที่ครอบด้วยเครื่องหมายคำพูด เผื่อรหัสผ่านมีช่องว่างนำหน้า/ตามหลัง
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    (out[section] ??= {})[key] = value;
  }
  return out;
}

function readIni() {
  try {
    return parseIni(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {}; // ไม่มีไฟล์ก็ใช้ค่าเริ่มต้นและ environment variable แทน
  }
}

const str = (ini, section, key, env, def) => process.env[env] ?? ini[section]?.[key] ?? def;
const int = (ini, section, key, env, def) => {
  const v = str(ini, section, key, env, undefined);
  const n = Number(v);
  return Number.isFinite(n) && v !== undefined && v !== '' ? Math.trunc(n) : def;
};
const bool = (ini, section, key, env, def) => {
  const v = str(ini, section, key, env, undefined);
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
};

let cached = null;

/** โหลดการตั้งค่าทั้งหมด (แคชไว้ เรียก reload() เพื่ออ่านไฟล์ใหม่) */
export function load() {
  if (cached) return cached;
  const ini = readIni();
  cached = {
    db: {
      host: str(ini, 'database', 'host', 'DB_HOST', '127.0.0.1'),
      port: int(ini, 'database', 'port', 'DB_PORT', 3306),
      user: str(ini, 'database', 'user', 'DB_USER', 'stock_app'),
      password: str(ini, 'database', 'password', 'DB_PASSWORD', ''),
      // ชื่อฐานข้อมูลของระบบนี้
      name: str(ini, 'database', 'name', 'DB_NAME', 'Stock-MC'),
      poolSize: Math.max(1, Math.min(int(ini, 'database', 'pool_size', 'DB_POOL_SIZE', 8), 64)),
      connectTimeout: Math.max(1, int(ini, 'database', 'connect_timeout', 'DB_CONNECT_TIMEOUT', 10)),
    },
    server: {
      host: str(ini, 'server', 'host', 'HOST', '0.0.0.0'),
      port: int(ini, 'server', 'port', 'PORT', 3000),
      https: bool(ini, 'server', 'https', 'HTTPS', process.env.NODE_ENV === 'production'),
    },
    session: {
      secret: str(ini, 'session', 'secret', 'SESSION_SECRET', 'dev-insecure-secret-change-me'),
    },
    adminPassword: str(ini, 'setup', 'admin_password', 'ADMIN_PASSWORD', 'admin1234'),
  };
  return cached;
}

export function reload() {
  cached = null;
  return load();
}

/** ใช้ในเทสต์เพื่อกำหนดค่าเฉพาะกิจ */
export function override(patch) {
  const base = load();
  cached = {
    ...base,
    ...patch,
    db: { ...base.db, ...(patch.db || {}) },
    server: { ...base.server, ...(patch.server || {}) },
    session: { ...base.session, ...(patch.session || {}) },
  };
  return cached;
}
