/** ตัวเรียก API พร้อมจัดการข้อผิดพลาดให้เป็นข้อความภาษาไทย */

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function request(method, path, body) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาตรวจสอบการเชื่อมต่อ');
  }

  if (res.status === 204) return null;
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }

  if (!res.ok) {
    if (res.status === 401) window.dispatchEvent(new CustomEvent('auth:expired'));
    throw new ApiError(res.status, data?.error || `เกิดข้อผิดพลาด (${res.status})`);
  }
  return data;
}

export const api = {
  get: (p) => request('GET', p),
  post: (p, b) => request('POST', p, b ?? {}),
  put: (p, b) => request('PUT', p, b ?? {}),
  del: (p) => request('DELETE', p),
  /** ประกอบ query string โดยตัดค่าว่างทิ้ง */
  qs(params) {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) {
      if (v !== '' && v != null) u.set(k, v);
    }
    const s = u.toString();
    return s ? `?${s}` : '';
  },
};
