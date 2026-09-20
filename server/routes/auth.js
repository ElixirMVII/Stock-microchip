import { Router } from 'express';
import { badRequest, conflict, notFound, unauthorized, wrap } from '../lib/http.js';
import { clearSessionCookie, hashPassword, makeToken, requireRole, setSessionCookie, verifyPassword } from '../lib/auth.js';
import { bool, int, oneOf, str } from '../lib/validate.js';
import { logAudit } from '../lib/audit.js';

const publicUser = (u) => (u ? { id: u.id, username: u.username, full_name: u.full_name, role: u.role, active: u.active } : null);

export function authRoutes(db) {
  const router = Router();

  router.post('/login', wrap(async (req, res) => {
    const username = str(req.body.username, 'ชื่อผู้ใช้', { max: 60 });
    const password = str(req.body.password, 'รหัสผ่าน', { max: 200 });
    const user = await db.get('SELECT * FROM users WHERE username = ?', username);
    if (!user || !verifyPassword(password, user.password_hash)) {
      throw unauthorized('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
    }
    if (!user.active) throw unauthorized('บัญชีนี้ถูกปิดใช้งาน กรุณาติดต่อผู้ดูแลระบบ');
    setSessionCookie(res, makeToken(user.id));
    await logAudit(db, { user }, 'login', 'users', user.id, user.username);
    res.json({ user: publicUser(user) });
  }));

  router.post('/logout', wrap(async (req, res) => {
    clearSessionCookie(res);
    res.json({ ok: true });
  }));

  router.get('/me', wrap(async (req, res) => res.json({ user: publicUser(req.user) })));

  router.post('/change-password', wrap(async (req, res) => {
    if (!req.user) throw unauthorized();
    const current = str(req.body.current_password, 'รหัสผ่านปัจจุบัน', { max: 200 });
    const next = str(req.body.new_password, 'รหัสผ่านใหม่', { min: 8, max: 200 });
    const row = await db.get('SELECT * FROM users WHERE id = ?', req.user.id);
    if (!verifyPassword(current, row.password_hash)) throw badRequest('รหัสผ่านปัจจุบันไม่ถูกต้อง');
    await db.run("UPDATE users SET password_hash = ?, updated_at = NOW() WHERE id = ?", [hashPassword(next), req.user.id]);
    await logAudit(db, req, 'change-password', 'users', req.user.id, req.user.username);
    res.json({ ok: true });
  }));

  return router;
}

export function userRoutes(db) {
  const router = Router();
  router.use(requireRole('admin'));

  router.get('/', wrap(async (req, res) => {
    const data = await db.all('SELECT id, username, full_name, role, active, created_at FROM users ORDER BY username');
    res.json({ data, total: data.length });
  }));

  router.post('/', wrap(async (req, res) => {
    const username = str(req.body.username, 'ชื่อผู้ใช้', { max: 60 });
    if (await db.get('SELECT 1 FROM users WHERE username = ?', username)) {
      throw conflict(`ชื่อผู้ใช้ "${username}" ถูกใช้ไปแล้ว`);
    }
    const info = await db.run(`
      INSERT INTO users (username, password_hash, full_name, role, active) VALUES (?, ?, ?, ?, ?)
    `, [username, hashPassword(str(req.body.password, 'รหัสผ่าน', { min: 8, max: 200 })), str(req.body.full_name, 'ชื่อ-นามสกุล', { max: 160 }), oneOf(req.body.role, 'สิทธิ์การใช้งาน', ['admin', 'officer', 'viewer'], { required: false, def: 'viewer' }), bool(req.body.active, true) ? 1 : 0]);
    await logAudit(db, req, 'create', 'users', info.lastInsertRowid, username);
    res.status(201).json(publicUser(await db.get('SELECT * FROM users WHERE id = ?', info.lastInsertRowid)));
  }));

  router.put('/:id', wrap(async (req, res) => {
    const id = int(req.params.id, 'id');
    const user = await db.get('SELECT * FROM users WHERE id = ?', id);
    if (!user) throw notFound('ไม่พบผู้ใช้งาน');

    const fields = {};
    if (req.body.full_name !== undefined) fields.full_name = str(req.body.full_name, 'ชื่อ-นามสกุล', { max: 160 });
    if (req.body.role !== undefined) fields.role = oneOf(req.body.role, 'สิทธิ์การใช้งาน', ['admin', 'officer', 'viewer']);
    if (req.body.active !== undefined) fields.active = bool(req.body.active, true) ? 1 : 0;
    if (req.body.password) fields.password_hash = hashPassword(str(req.body.password, 'รหัสผ่าน', { min: 8, max: 200 }));

    // กันไม่ให้ระบบเหลือผู้ดูแลที่ใช้งานได้ศูนย์คน
    const losingAdmin = (fields.role && fields.role !== 'admin' && user.role === 'admin')
      || (fields.active === 0 && user.role === 'admin');
    if (losingAdmin) {
      const others = (await db.get("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1 AND id <> ?", id)).n;
      if (others === 0) throw conflict('ต้องมีผู้ดูแลระบบ (admin) ที่ใช้งานได้อย่างน้อย 1 บัญชี');
    }
    const cols = Object.keys(fields);
    if (cols.length) {
      await db.run(`UPDATE users SET ${cols.map((c) => `${c} = @${c}`).join(', ')}, updated_at = NOW() WHERE id = @id`, { ...fields, id });
    }
    await logAudit(db, req, 'update', 'users', id, user.username);
    res.json(publicUser(await db.get('SELECT * FROM users WHERE id = ?', id)));
  }));

  router.delete('/:id', wrap(async (req, res) => {
    const id = int(req.params.id, 'id');
    const user = await db.get('SELECT * FROM users WHERE id = ?', id);
    if (!user) throw notFound('ไม่พบผู้ใช้งาน');
    if (req.user.id === id) throw conflict('ลบบัญชีที่กำลังใช้งานอยู่ไม่ได้');
    if (user.role === 'admin') {
      const others = (await db.get("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1 AND id <> ?", id)).n;
      if (others === 0) throw conflict('ต้องมีผู้ดูแลระบบ (admin) ที่ใช้งานได้อย่างน้อย 1 บัญชี');
    }
    await db.run('DELETE FROM users WHERE id = ?', id);
    await logAudit(db, req, 'delete', 'users', id, user.username);
    res.json({ ok: true, deleted: id });
  }));

  return router;
}
