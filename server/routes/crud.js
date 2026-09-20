import { Router } from 'express';
import { conflict, notFound, wrap } from '../lib/http.js';
import { requireRole } from '../lib/auth.js';
import { bool, int } from '../lib/validate.js';
import { logAudit } from '../lib/audit.js';

/**
 * ตัวช่วยสร้าง REST endpoint มาตรฐานสำหรับตารางข้อมูลหลัก
 * รองรับ list (ค้นหา + แบ่งหน้า), get, create, update, delete
 */
export function crudRouter(db, cfg) {
  const {
    table,
    label,
    searchCols = ['name'],
    parse,
    selectSql = `SELECT * FROM ${table}`,
    orderBy = 'name',
    references = [],       // [{ table, column, label }] ใช้ตรวจก่อนลบ
    writeRole = 'officer',
    deleteRole = 'admin',
  } = cfg;

  const router = Router();
  const one = (id) => db.get(`SELECT * FROM (${selectSql}) t WHERE t.id = @id`, { id });
  const mustExist = async (id) => {
    const row = await one(id);
    if (!row) throw notFound(`ไม่พบ${label}รหัส #${id}`);
    return row;
  };

  router.get('/', wrap(async (req, res) => {
    const where = [];
    const params = {};
    if (req.query.q) {
      where.push(`(${searchCols.map((c, i) => `t.${c} LIKE @q${i}`).join(' OR ')})`);
      searchCols.forEach((_, i) => { params[`q${i}`] = `%${req.query.q}%`; });
    }
    if (req.query.active === '0' || req.query.active === '1') {
      where.push('t.active = @active');
      params.active = Number(req.query.active);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (await db.get(`SELECT COUNT(*) AS n FROM (${selectSql}) t ${clause}`, params)).n;

    const perPage = int(req.query.per_page, 'per_page', { required: false, def: 50, min: 1, max: 2000 });
    const page = int(req.query.page, 'page', { required: false, def: 1, min: 1 });
    const data = await db.all(`SELECT * FROM (${selectSql}) t ${clause} ORDER BY ${orderBy} LIMIT @limit OFFSET @offset`, { ...params, limit: perPage, offset: (page - 1) * perPage });

    res.json({ data, total, page, per_page: perPage });
  }));

  router.get('/:id', wrap(async (req, res) => res.json(await mustExist(int(req.params.id, 'id')))));

  router.post('/', requireRole(writeRole), wrap(async (req, res) => {
    const fields = parse(req.body, { isUpdate: false, db });
    const cols = Object.keys(fields);
    const info = await db.run(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})`, fields);
    const row = await one(info.lastInsertRowid);
    await logAudit(db, req, 'create', table, row.id, label);
    res.status(201).json(row);
  }));

  router.put('/:id', requireRole(writeRole), wrap(async (req, res) => {
    const id = int(req.params.id, 'id');
    await mustExist(id);
    const fields = parse(req.body, { isUpdate: true, db, id });
    const cols = Object.keys(fields);
    if (cols.length) {
      await db.run(`UPDATE ${table} SET ${cols.map((c) => `${c} = @${c}`).join(', ')} WHERE id = @id`, { ...fields, id });
    }
    const row = await one(id);
    await logAudit(db, req, 'update', table, id, label);
    res.json(row);
  }));

  router.delete('/:id', requireRole(deleteRole), wrap(async (req, res) => {
    const id = int(req.params.id, 'id');
    const row = await mustExist(id);
    for (const ref of references) {
      const n = (await db.get(`SELECT COUNT(*) AS n FROM ${ref.table} WHERE ${ref.column} = ?`, id)).n;
      if (n > 0) {
        throw conflict(
          `ลบ${label}นี้ไม่ได้ เพราะมี${ref.label}อ้างอิงอยู่ ${n} รายการ — แนะนำให้ "ปิดใช้งาน" แทนการลบ`,
        );
      }
    }
    await db.run(`DELETE FROM ${table} WHERE id = ?`, id);
    await logAudit(db, req, 'delete', table, id, `${label}: ${row.name ?? id}`);
    res.json({ ok: true, deleted: id });
  }));

  return router;
}

/** แปลงค่า active จาก body เป็น 0/1 (ใช้ร่วมกันหลายตาราง) */
export const activeField = (body, isUpdate) =>
  (isUpdate && body.active === undefined ? {} : { active: bool(body.active, true) ? 1 : 0 });
