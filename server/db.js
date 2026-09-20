import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { load } from './config.js';
import { runMigrations } from './migrations.js';

/* ============================================================
 *  ชั้นเชื่อมต่อฐานข้อมูล MySQL / MariaDB
 *  ใช้เซิร์ฟเวอร์ตัวเดียวกับโปรเจกต์อื่นในองค์กร ฐานข้อมูลชื่อ Stock-MC
 * ============================================================ */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');
const VIEWS_PATH = path.join(__dirname, 'views.sql');

/**
 * แปลงพารามิเตอร์แบบมีชื่อ (@name) ให้เป็น ? ตามลำดับที่ไดรเวอร์ต้องการ
 * ข้ามข้อความที่อยู่ในเครื่องหมายคำพูดและคอมเมนต์ เพื่อไม่ให้แก้ค่าผิดตำแหน่ง
 */
export function bindNamed(sql, params) {
  if (params === undefined || params === null) return { sql, values: [] };
  if (Array.isArray(params)) return { sql, values: params };
  // ค่าเดี่ยว (string/number/Date) ถือเป็นพารามิเตอร์ตำแหน่งเดียว เช่น db.get(sql, id)
  if (typeof params !== 'object' || params instanceof Date) return { sql, values: [params] };

  const values = [];
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];

    // ข้ามสตริงที่ครอบด้วย ' " หรือ `
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === '\\') { j += 2; continue; }
        if (sql[j] === quote) {
          // เครื่องหมายคำพูดซ้อนสองตัวหมายถึงอักขระนั้นเอง
          if (sql[j + 1] === quote) { j += 2; continue; }
          break;
        }
        j += 1;
      }
      out += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }

    // ข้ามคอมเมนต์ -- ถึงท้ายบรรทัด
    if (ch === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      const end = nl === -1 ? sql.length : nl;
      out += sql.slice(i, end);
      i = end;
      continue;
    }

    // พารามิเตอร์แบบมีชื่อ
    if (ch === '@') {
      const m = /^@([A-Za-z_][A-Za-z0-9_]*)/.exec(sql.slice(i));
      if (m) {
        const key = m[1];
        if (!(key in params)) throw new Error(`ไม่ได้ส่งค่าพารามิเตอร์ "@${key}" ให้กับคำสั่ง SQL`);
        values.push(params[key]);
        out += '?';
        i += m[0].length;
        continue;
      }
    }

    out += ch;
    i += 1;
  }
  return { sql: out, values };
}

/** แปลงค่า undefined เป็น null เพราะไดรเวอร์ MySQL ไม่รับ undefined */
const clean = (values) => values.map((v) => (v === undefined ? null : v));

/** ห่อ connection ให้มีเมธอดสั้น ๆ ที่ใช้ทั่วทั้งโปรเจกต์ */
function wrap(conn) {
  const exec = async (sql, params) => {
    const bound = bindNamed(sql, params);
    // ใช้ query() แทน execute() เพราะ prepared statement ของ MySQL
    // ไม่รองรับพารามิเตอร์ในบางตำแหน่ง เช่น LIMIT/OFFSET บนเซิร์ฟเวอร์เก่า
    return conn.query(bound.sql, clean(bound.values));
  };

  return {
    raw: conn,
    /** คืนทุกแถวเป็น array ของ object */
    async all(sql, params) {
      const [rows] = await exec(sql, params);
      return Array.isArray(rows) ? rows : [];
    },
    /** คืนแถวแรก หรือ undefined ถ้าไม่พบ */
    async get(sql, params) {
      const [rows] = await exec(sql, params);
      return Array.isArray(rows) ? rows[0] : undefined;
    },
    /** คำสั่งเขียนข้อมูล คืนจำนวนแถวที่เปลี่ยนและ id ที่เพิ่งสร้าง */
    async run(sql, params) {
      const [res] = await exec(sql, params);
      return { changes: res.affectedRows ?? 0, lastInsertRowid: res.insertId ?? 0 };
    },
    /** ค่าเดียวจากคอลัมน์แรกของแถวแรก */
    async scalar(sql, params, def = null) {
      const row = await this.get(sql, params);
      if (!row) return def;
      const v = Object.values(row)[0];
      return v === undefined ? def : v;
    },
    /** รันสคริปต์หลายคำสั่งที่คั่นด้วย ; (ใช้ตอนสร้างตาราง) */
    async exec(script) {
      for (const stmt of splitStatements(script)) {
        await conn.query(stmt);
      }
    },
  };
}

/** ตัดสคริปต์ SQL เป็นคำสั่งย่อย โดยไม่ตัดกลางสตริงหรือคอมเมนต์ */
export function splitStatements(script) {
  const out = [];
  let buf = '';
  let i = 0;
  while (i < script.length) {
    const ch = script[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      let j = i + 1;
      while (j < script.length) {
        if (script[j] === '\\') { j += 2; continue; }
        if (script[j] === quote) { if (script[j + 1] === quote) { j += 2; continue; } break; }
        j += 1;
      }
      buf += script.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === '-' && script[i + 1] === '-') {
      const nl = script.indexOf('\n', i);
      i = nl === -1 ? script.length : nl;
      continue;
    }
    if (ch === ';') {
      if (buf.trim()) out.push(buf.trim());
      buf = '';
      i += 1;
      continue;
    }
    buf += ch;
    i += 1;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

/* ------------------------------------------------------------
 *  จุดเข้าใช้งานหลัก
 * ------------------------------------------------------------ */

let pool = null;

/** สร้างฐานข้อมูลถ้ายังไม่มี (ชื่อมีขีดกลางจึงต้องครอบด้วย backtick เสมอ) */
export async function ensureDatabase(cfg = load().db) {
  const admin = await mysql.createConnection({
    host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password,
    connectTimeout: cfg.connectTimeout * 1000, multipleStatements: false,
  });
  try {
    await admin.query(
      `CREATE DATABASE IF NOT EXISTS \`${cfg.name.replace(/`/g, '``')}\`
       CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
  } finally {
    await admin.end();
  }
}

/**
 * เปิดการเชื่อมต่อ สร้างตารางตาม schema แล้วปรับโครงสร้างเดิมให้ทันสมัย
 * @param {object} [dbCfg] ใช้ทับค่าจาก config.ini (สำหรับการทดสอบ)
 */
export async function openDatabase(dbCfg) {
  const cfg = dbCfg || load().db;
  pool = mysql.createPool({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.name,
    charset: 'utf8mb4',
    connectionLimit: cfg.poolSize,
    connectTimeout: cfg.connectTimeout * 1000,
    waitForConnections: true,
    namedPlaceholders: false,
    dateStrings: true,          // คืนวันที่เป็นข้อความ YYYY-MM-DD ตรงกับที่ระบบใช้
    decimalNumbers: true,       // DECIMAL คืนเป็นตัวเลข ไม่ใช่ string
    multipleStatements: false,  // ปิดไว้เพื่อความปลอดภัย
  });

  const db = makeDb(pool);
  await db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  await runMigrations(db);
  await db.exec(fs.readFileSync(VIEWS_PATH, 'utf8'));
  return db;
}

/** สร้าง handle ของฐานข้อมูลจาก pool พร้อมเมธอด transaction */
export function makeDb(p) {
  const base = wrap(p);
  return {
    ...base,
    pool: p,
    /**
     * รันหลายคำสั่งในทรานแซกชันเดียว
     * ฟังก์ชันที่ส่งเข้ามาจะได้รับ handle ที่ผูกกับ connection เดียวกัน
     */
    async tx(fn) {
      const conn = await p.getConnection();
      const t = wrap(conn);
      try {
        await conn.beginTransaction();
        const result = await fn(t);
        await conn.commit();
        return result;
      } catch (err) {
        try { await conn.rollback(); } catch { /* connection อาจหลุดไปแล้ว */ }
        throw err;
      } finally {
        conn.release();
      }
    },
    /**
     * เหมือน tx() แต่ลองใหม่เมื่อชนกับเลขที่เอกสารซ้ำ
     *
     * เลขที่เอกสารสร้างจาก MAX(doc_no) + 1 ถ้ามีผู้ใช้บันทึกพร้อมกัน
     * ทั้งสองทรานแซกชันอาจอ่านค่าเดิมแล้วได้เลขเดียวกัน คีย์ UNIQUE
     * กันไม่ให้ข้อมูลซ้ำอยู่แล้ว ตรงนี้จึงเพียงลองใหม่ให้ผู้ใช้ไม่เห็น error
     * (ตอนใช้ SQLite ปัญหานี้ไม่เกิดเพราะเขียนได้ทีละรายเท่านั้น)
     */
    async txRetry(fn, retries = 5) {
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await this.tx(fn);
        } catch (err) {
          const isDocNoClash = err?.code === 'ER_DUP_ENTRY' && /_doc'?$|doc_no/i.test(err?.message || '');
          const isDeadlock = err?.code === 'ER_LOCK_DEADLOCK';
          if ((!isDocNoClash && !isDeadlock) || attempt >= retries) throw err;
          // หน่วงสั้น ๆ แบบสุ่ม เพื่อลดโอกาสชนซ้ำรอบถัดไป
          await new Promise((r) => setTimeout(r, 10 + Math.random() * 40 * (attempt + 1)));
        }
      }
    },
    async close() {
      await p.end();
    },
  };
}

/** ปิดการเชื่อมต่อทั้งหมด (ใช้ตอนปิดเซิร์ฟเวอร์และในเทสต์) */
export async function closeDatabase() {
  if (pool) { await pool.end(); pool = null; }
}
