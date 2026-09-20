import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { attachUser, requireRole } from './lib/auth.js';
import { HttpError } from './lib/http.js';
import { authRoutes, userRoutes } from './routes/auth.js';
import { masterRoutes } from './routes/master.js';
import { documentRoutes } from './routes/documents.js';
import { stockRoutes } from './routes/stock.js';
import { dashboardRoutes, reportRoutes } from './routes/reports.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

export function createApp(db, { requireLogin = true } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));
  app.use(attachUser(db));

  // ป้องกัน API ทั้งหมดด้วยการเข้าสู่ระบบ ยกเว้น endpoint ของการยืนยันตัวตน
  const guard = requireLogin ? requireRole('viewer') : (_req, _res, next) => next();

  app.get('/api/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));
  app.use('/api/auth', authRoutes(db));
  app.use('/api/users', guard, userRoutes(db));
  app.use('/api', guard, masterRoutes(db));
  app.use('/api', guard, documentRoutes(db));
  app.use('/api/stock', guard, stockRoutes(db));
  app.use('/api/reports', guard, reportRoutes(db));
  app.use('/api/dashboard', guard, dashboardRoutes(db));

  app.use('/api', (_req, res) => res.status(404).json({ error: 'ไม่พบ API ที่เรียก' }));

  // หน้าเว็บ (SPA)
  app.use(express.static(PUBLIC_DIR, { index: 'index.html', extensions: ['html'] }));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

  // จัดการข้อผิดพลาดทั้งหมดให้เป็น JSON ภาษาไทย
  app.use((err, _req, res, _next) => {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.message, details: err.details });
    }
    // ข้อผิดพลาดจาก MySQL / MariaDB
    if (err?.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'ข้อมูลซ้ำกับที่มีอยู่ในระบบแล้ว (รหัสหรือชื่อต้องไม่ซ้ำ)' });
    }
    if (err?.code === 'ER_ROW_IS_REFERENCED_2' || err?.code === 'ER_NO_REFERENCED_ROW_2'
        || err?.code === 'ER_ROW_IS_REFERENCED' || err?.code === 'ER_NO_REFERENCED_ROW') {
      return res.status(409).json({ error: 'ข้อมูลนี้ถูกอ้างอิงอยู่ที่อื่น หรืออ้างอิงไปยังข้อมูลที่ไม่มีอยู่จริง' });
    }
    if (err?.code === 'ER_CHECK_CONSTRAINT_VIOLATED' || err?.code === 'ER_CONSTRAINT_FAILED'
        || err?.code === 'WARN_DATA_TRUNCATED' || err?.code === 'ER_DATA_TOO_LONG') {
      return res.status(400).json({ error: 'ข้อมูลไม่ผ่านเงื่อนไขของฐานข้อมูล กรุณาตรวจสอบค่าที่กรอก' });
    }
    if (err?.code === 'ECONNREFUSED' || err?.code === 'PROTOCOL_CONNECTION_LOST'
        || err?.code === 'ER_ACCESS_DENIED_ERROR' || err?.fatal) {
      console.error('[db]', err);
      return res.status(503).json({ error: 'เชื่อมต่อฐานข้อมูลไม่ได้ กรุณาลองใหม่อีกครั้งหรือติดต่อผู้ดูแลระบบ' });
    }
    if (err?.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'รูปแบบข้อมูล JSON ไม่ถูกต้อง' });
    }
    console.error('[error]', err);
    res.status(500).json({ error: 'เกิดข้อผิดพลาดภายในระบบ' });
  });

  return app;
}
