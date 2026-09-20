/** ข้อผิดพลาดที่ต้องการส่งสถานะ HTTP เฉพาะกลับไปให้ผู้ใช้ */
export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.details = details;
  }
}

export const badRequest = (msg, details) => new HttpError(400, msg, details);
export const unauthorized = (msg = 'กรุณาเข้าสู่ระบบ') => new HttpError(401, msg);
export const forbidden = (msg = 'ไม่มีสิทธิ์ใช้งานส่วนนี้') => new HttpError(403, msg);
export const notFound = (msg = 'ไม่พบข้อมูลที่ต้องการ') => new HttpError(404, msg);
export const conflict = (msg, details) => new HttpError(409, msg, details);

/** ครอบ handler แบบ async เพื่อส่ง error เข้าสู่ error middleware */
export const wrap = (fn) => (req, res, next) => {
  try {
    const out = fn(req, res, next);
    if (out && typeof out.catch === 'function') out.catch(next);
  } catch (err) {
    next(err);
  }
};
