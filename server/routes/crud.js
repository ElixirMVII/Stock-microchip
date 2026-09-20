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
    orderBy = 'name COLLATE NOCASE',
    references = [],       // [{ table, column, label }] ใช้ตรวจก่อนลบ
    writeRole = 'officer',
    deleteRole = 'admin',
  } = cfg;

  const router = Router();
  const one = (id) => db.prepare(`SELECT * FROM (${selectSql}) t WHERE t.id = ?`).get(id);
  const mustExist = (id) => {
    const row = one(id);
    if (!row) throw notFound(`ไม่พบ${label}รหัส #${id}`);
    return row;
  };

  router.get('/', wrap((req, res) => {
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
    const total = db.prepare(`SELECT COUNT(*) AS n FROM (${selectSql}) t ${clause}`).get(params).n;

    const perPage = int(req.query.per_page, 'per_page', { required: false, def: 50, min: 1, max: 2000 });
    const page = int(req.query.page, 'page', { required: false, def: 1, min: 1 });
    const data = db.prepare(`SELECT * FROM (${selectSql}) t ${clause} ORDER BY ${orderBy} LIMIT @limit OFFSET @offset`)
      .all({ ...params, limit: perPage, offset: (page - 1) * perPage });

    res.json({ data, total, page, per_page: perPage });
  }));

  router.get('/:id', wrap((req, res) => res.json(mustExist(int(req.params.id, 'id')))));

  router.post('/', requireRole(writeRole), wrap((req, res) => {
    const fields = parse(req.body, { isUpdate: false, db });
    const cols = Object.keys(fields);
    const info = db.prepare(
      `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})`,
    ).run(fields);
    const row = one(info.lastInsertRowid);
    logAudit(db, req, 'create', table, row.id, label);
    res.status(201).json(row);
  }));

  router.put('/:id', requireRole(writeRole), wrap((req, res) => {
    const id = int(req.params.id, 'id');
    mustExist(id);
    const fields = parse(req.body, { isUpdate: true, db, id });
    const cols = Object.keys(fields);
    if (cols.length) {
      db.prepare(`UPDATE ${table} SET ${cols.map((c) => `${c} = @${c}`).join(', ')} WHERE id = @id`)
        .run({ ...fields, id });
    }
    const row = one(id);
    logAudit(db, req, 'update', table, id, label);
    res.json(row);
  }));

  router.delete('/:id', requireRole(deleteRole), wrap((req, res) => {
    const id = int(req.params.id, 'id');
    const row = mustExist(id);
    for (const ref of references) {
      const n = db.prepare(`SELECT COUNT(*) AS n FROM ${ref.table} WHERE ${ref.column} = ?`).get(id).n;
      if (n > 0) {
        throw conflict(
          `ลบ${label}นี้ไม่ได้ เพราะมี${ref.label}อ้างอิงอยู่ ${n} รายการ — แนะนำให้ "ปิดใช้งาน" แทนการลบ`,
        );
      }
    }
    db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
    logAudit(db, req, 'delete', table, id, `${label}: ${row.name ?? id}`);
    res.json({ ok: true, deleted: id });
  }));

  return router;
}

/** แปลงค่า active จาก body เป็น 0/1 (ใช้ร่วมกันหลายตาราง) */
export const activeField = (body, isUpdate) =>
  (isUpdate && body.active === undefined ? {} : { active: bool(body.active, true) ? 1 : 0 });
