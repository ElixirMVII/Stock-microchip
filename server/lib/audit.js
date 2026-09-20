/** บันทึกการกระทำของผู้ใช้ลง audit log (ไม่ให้ error จากส่วนนี้กระทบงานหลัก) */
export async function logAudit(db, req, action, entity, entityId, detail) {
  try {
    await db.run(`
      INSERT INTO audit_logs (user_id, username, action, entity, entity_id, detail)
      VALUES (@uid, @uname, @action, @entity, @eid, @detail)
    `, {
      uid: req?.user?.id ?? null,
      uname: req?.user?.username ?? 'system',
      action,
      entity,
      eid: entityId ?? null,
      detail: detail ?? null,
    });
  } catch {
    /* ไม่ขัดจังหวะการทำงานหลักหาก log ล้มเหลว */
  }
}
