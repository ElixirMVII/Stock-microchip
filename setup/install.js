#!/usr/bin/env node
/* ============================================================
 *  ตัวช่วยติดตั้งครั้งแรก
 *  - สร้างไฟล์ config.ini จากคำตอบที่กรอก
 *  - สร้างฐานข้อมูลและผู้ใช้ฐานข้อมูล (ถ้าให้รหัส root)
 *  - สร้างตารางและข้อมูลตั้งต้น
 *
 *  ใช้แนวทางเดียวกับ setup/install.py ของโปรเจกต์อื่นในองค์กร
 *  เรียกใช้:  node setup/install.js
 * ============================================================ */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import mysql from 'mysql2/promise';

const BASE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = path.join(BASE_DIR, 'config.ini');

const rl = readline.createInterface({ input: stdin, output: stdout });
const ask = async (q, def = '') => {
  const a = (await rl.question(def ? `${q} [${def}]: ` : `${q}: `)).trim();
  return a || def;
};

/** ครอบชื่อฐานข้อมูลด้วย backtick — จำเป็นเพราะชื่อมีขีดกลาง */
const quoteIdent = (name) => `\`${String(name).replace(/`/g, '``')}\``;

async function main() {
  console.log('=== ติดตั้งระบบจัดการสต็อกอุปกรณ์ไอที ===\n');

  if (fs.existsSync(CONFIG_PATH)) {
    const ow = await ask('มีไฟล์ config.ini อยู่แล้ว ต้องการเขียนทับหรือไม่ (y/N)', 'N');
    if (ow.toLowerCase() !== 'y') {
      console.log('ยกเลิกการติดตั้ง');
      rl.close();
      return;
    }
  }

  const host = await ask('MySQL host', '127.0.0.1');
  const port = Number(await ask('MySQL port', '3306'));
  const dbName = await ask('ชื่อฐานข้อมูล', 'Stock-MC');
  const appUser = await ask('ผู้ใช้ฐานข้อมูลของแอป', 'stock_app');
  const appPass = await ask('รหัสผ่านของผู้ใช้แอป');

  const makeDb = (await ask('ให้สคริปต์สร้างฐานข้อมูลและผู้ใช้ให้เลยไหม (ต้องใช้บัญชี root) (y/N)', 'N'))
    .toLowerCase() === 'y';

  if (makeDb) {
    const rootUser = await ask('ผู้ใช้ที่มีสิทธิ์สร้างฐานข้อมูล', 'root');
    const rootPass = await ask('รหัสผ่านของผู้ใช้นั้น');
    const admin = await mysql.createConnection({ host, port, user: rootUser, password: rootPass });
    try {
      await admin.query(
        `CREATE DATABASE IF NOT EXISTS ${quoteIdent(dbName)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
      );
      for (const h of ['localhost', '%']) {
        await admin.query('CREATE USER IF NOT EXISTS ?@? IDENTIFIED BY ?', [appUser, h, appPass]);
        // CREATE USER IF NOT EXISTS จะไม่แตะรหัสผ่านของบัญชีที่มีอยู่แล้ว
        // จึงต้อง ALTER ซ้ำ เพื่อให้รหัสตรงกับที่เขียนลง config.ini เสมอ
        // (สำคัญตอนรัน setup ซ้ำเพราะพิมพ์ผิดรอบแรก)
        await admin.query('ALTER USER ?@? IDENTIFIED BY ?', [appUser, h, appPass]);
        await admin.query(`GRANT ALL PRIVILEGES ON ${quoteIdent(dbName)}.* TO ?@?`, [appUser, h]);
      }
      await admin.query('FLUSH PRIVILEGES');
      console.log(`  สร้างฐานข้อมูล ${dbName} และผู้ใช้ ${appUser} เรียบร้อย`);
    } finally {
      await admin.end();
    }
  }

  const serverPort = await ask('พอร์ตของเว็บเซิร์ฟเวอร์', '3000');
  const adminPass = await ask('รหัสผ่านผู้ดูแลระบบ (บัญชี admin) ครั้งแรก', 'admin1234');
  const secret = crypto.randomBytes(32).toString('hex');

  const ini = `; สร้างโดย setup/install.js เมื่อ ${new Date().toISOString().slice(0, 19).replace('T', ' ')}
; ไฟล์นี้มีรหัสผ่าน จึงไม่ถูก track ใน git

[database]
host = ${host}
port = ${port}
user = ${appUser}
password = ${appPass}
name = ${dbName}
pool_size = 8
connect_timeout = 10

[server]
host = 0.0.0.0
port = ${serverPort}
https = false

[session]
secret = ${secret}

[setup]
admin_password = ${adminPass}
`;
  fs.writeFileSync(CONFIG_PATH, ini, { mode: 0o600 });
  console.log(`  เขียนไฟล์ ${CONFIG_PATH} เรียบร้อย (สร้าง session secret แบบสุ่มให้แล้ว)`);

  rl.close();

  // สร้างตารางและข้อมูลตั้งต้น
  const { openDatabase, ensureDatabase } = await import('../server/db.js');
  const { reload } = await import('../server/config.js');
  const { ensureSeed } = await import('../server/seed.js');
  reload();
  await ensureDatabase();
  const db = await openDatabase();
  await ensureSeed(db);
  await db.close();

  console.log('\nติดตั้งเสร็จเรียบร้อย');
  console.log('  เริ่มระบบด้วย:  npm start');
  console.log(`  เข้าใช้งานที่:   http://localhost:${serverPort}`);
  console.log('  บัญชีเริ่มต้น:   admin (เปลี่ยนรหัสผ่านทันทีหลังเข้าใช้งาน)');
}

main().catch((err) => {
  console.error('ติดตั้งไม่สำเร็จ:', err.message);
  rl.close();
  process.exit(1);
});
