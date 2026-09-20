import { openDatabase } from './db.js';
import { createApp } from './app.js';
import { ensureSeed } from './seed.js';

const port = Number(process.env.PORT || 3000);
const db = openDatabase();

// สร้างข้อมูลตั้งต้น (ผู้ดูแลระบบ + หมวดหมู่พื้นฐาน) ถ้าฐานข้อมูลยังว่าง
ensureSeed(db);

const app = createApp(db);
const server = app.listen(port, () => {
  console.log(`ระบบจัดการสต็อกอุปกรณ์ไอที พร้อมใช้งานที่  http://localhost:${port}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => { db.close(); process.exit(0); });
  });
}
