import crypto from 'node:crypto';
import { forbidden, unauthorized } from './http.js';
import { load } from '../config.js';

const COOKIE = 'hwstock_session';
const MAX_AGE_SEC = 60 * 60 * 12; // เซสชันมีอายุ 12 ชั่วโมง

const secret = () => load().session.secret;

/* ---------------- รหัสผ่าน ---------------- */

export function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(plain), salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(plain, stored) {
  if (typeof stored !== 'string') return false;
  const [algo, salt, hash] = stored.split('$');
  if (algo !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = crypto.scryptSync(String(plain), salt, expected.length);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

/* ---------------- เซสชันแบบ signed cookie ---------------- */

const sign = (payload) => crypto.createHmac('sha256', secret()).update(payload).digest('base64url');

export function makeToken(userId) {
  const exp = Math.floor(Date.now() / 1000) + MAX_AGE_SEC;
  const payload = `${userId}.${exp}`;
  return `${payload}.${sign(payload)}`;
}

export function readToken(token) {
  if (!token) return null;
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  const [id, exp, sig] = parts;
  const expected = sign(`${id}.${exp}`);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (Number(exp) * 1000 < Date.now()) return null;
  return Number(id);
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function setSessionCookie(res, token) {
  const secure = load().server.https ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${MAX_AGE_SEC}${secure}`);
}

export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
}

/* ---------------- Middleware ---------------- */

/** อ่านผู้ใช้จากคุกกี้ใส่ไว้ใน req.user (ไม่บังคับเข้าสู่ระบบ) */
export function attachUser(db) {
  return async (req, _res, next) => {
    try {
      const token = parseCookies(req.headers.cookie).hwstock_session;
      const id = readToken(token);
      req.user = id
        ? (await db.get(
          'SELECT id, username, full_name, role, active FROM users WHERE id = @id AND active = 1', { id },
        )) || null
        : null;
      next();
    } catch (err) {
      next(err);
    }
  };
}

const RANK = { viewer: 1, officer: 2, admin: 3 };

/** บังคับให้เข้าสู่ระบบ และมีสิทธิ์ไม่ต่ำกว่าระดับที่กำหนด */
export function requireRole(minRole = 'viewer') {
  return (req, _res, next) => {
    if (!req.user) return next(unauthorized());
    if ((RANK[req.user.role] || 0) < (RANK[minRole] || 0)) {
      return next(forbidden(`ต้องมีสิทธิ์ระดับ "${minRole}" ขึ้นไปจึงจะใช้งานส่วนนี้ได้`));
    }
    next();
  };
}

export const AUTH_COOKIE = COOKIE;
