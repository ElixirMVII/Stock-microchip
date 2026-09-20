import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

/**
 * เปิดการเชื่อมต่อฐานข้อมูลและสร้างตารางตาม schema.sql ให้อัตโนมัติ
 * @param {string} file เส้นทางไฟล์ฐานข้อมูล หรือ ':memory:' สำหรับการทดสอบ
 */
export function openDatabase(file = process.env.DB_FILE || './data/stock.db') {
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  }
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  return db;
}

/** ห่อฟังก์ชันให้ทำงานภายใน transaction เดียว */
export function tx(db, fn) {
  return db.transaction(fn);
}
