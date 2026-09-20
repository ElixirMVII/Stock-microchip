/** บันทึกการกระทำของผู้ใช้ลง audit log (ไม่ให้ error จากส่วนนี้กระทบงานหลัก) */
export function logAudit(db, req, action, entity, entityId, detail) {
  try {
    db.prepare(`
      INSERT INTO audit_logs (user_id, username, action, entity, entity_id, detail)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(req?.user?.id ?? null, req?.user?.username ?? 'system', action, entity, entityId ?? null, detail ?? null);
  } catch {
    /* ไม่ขัดจังหวะการทำงานหลักหาก log ล้มเหลว */
  }
}
