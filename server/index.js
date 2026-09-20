import { openDatabase, ensureDatabase } from './db.js';
import { createApp } from './app.js';
import { ensureSeed } from './seed.js';
import { load } from './config.js';

const cfg = load();

async function main() {
  // สร้างฐานข้อมูลถ้ายังไม่มี แล้วจึงเปิดใช้งานและสร้างตาราง
  await ensureDatabase();
  const db = await openDatabase();

  // สร้างข้อมูลตั้งต้น (ผู้ดูแลระบบ + หมวดหมู่พื้นฐาน) ถ้าฐานข้อมูลยังว่าง
  await ensureSeed(db);

  const app = createApp(db);
  const server = app.listen(cfg.server.port, cfg.server.host, () => {
    console.log(`ระบบจัดการสต็อกอุปกรณ์ไอที พร้อมใช้งานที่  http://localhost:${cfg.server.port}`);
    console.log(`ฐานข้อมูล: ${cfg.db.name} ที่ ${cfg.db.host}:${cfg.db.port}`);
  });

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      server.close(async () => {
        await db.close().catch(() => {});
        process.exit(0);
      });
    });
  }
}

main().catch((err) => {
  console.error('เริ่มระบบไม่สำเร็จ:', err.message);
  if (err.code === 'ECONNREFUSED') {
    console.error('  ตรวจสอบว่าเซิร์ฟเวอร์ MySQL ทำงานอยู่ และค่าใน config.ini ถูกต้อง');
  }
  if (err.code === 'ER_ACCESS_DENIED_ERROR') {
    console.error('  ชื่อผู้ใช้หรือรหัสผ่านฐานข้อมูลไม่ถูกต้อง (ดูหัวข้อ [database] ใน config.ini)');
  }
  process.exit(1);
});
