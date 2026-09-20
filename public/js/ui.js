/** ชุดเครื่องมือสร้างหน้าจอ: escape, จัดรูปแบบข้อมูล, toast, modal, ตาราง */

/* ---------------- ความปลอดภัยและการจัดรูปแบบ ---------------- */

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** แปลงข้อความให้ปลอดภัยก่อนใส่ลง HTML */
export const esc = (v) => (v == null ? '' : String(v).replace(/[&<>"']/g, (c) => ESC[c]));

export const fmtInt = (n) => Number(n || 0).toLocaleString('th-TH');
export const fmtMoney = (n) => Number(n || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const TH_MONTH = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
export const MONTH_FULL = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];

/** แสดงวันที่แบบไทย เช่น 11 ส.ค. 2569 */
export function fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return iso;
  return `${d} ${TH_MONTH[m - 1]} ${y + 543}`;
}

export function fmtDateTime(v) {
  if (!v) return '';
  const s = String(v).replace('T', ' ');
  return `${fmtDate(s.slice(0, 10))} ${s.slice(11, 16)}`;
}

export const today = () => new Date().toISOString().slice(0, 10);

/* ---------------- Toast ---------------- */

let toastBox;
export function toast(message, type = 'ok', title) {
  if (!toastBox) {
    toastBox = document.createElement('div');
    toastBox.className = 'toasts';
    document.body.appendChild(toastBox);
  }
  const titles = { ok: 'สำเร็จ', err: 'ไม่สำเร็จ', warn: 'คำเตือน', info: 'แจ้งเตือน' };
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  node.innerHTML = `<div class="t-title">${esc(title || titles[type] || '')}</div><div class="t-msg">${esc(message)}</div>`;
  toastBox.appendChild(node);
  setTimeout(() => {
    node.style.transition = 'opacity .2s';
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 220);
  }, type === 'err' ? 6000 : 3200);
}

/* ---------------- Modal ---------------- */

/**
 * เปิดกล่องโต้ตอบ
 * @returns {{close: Function, root: HTMLElement}}
 */
export function modal({ title, body, footer = '', wide = false, onMount, onSubmit }) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
      <div class="modal-head">
        <h3>${esc(title)}</h3>
        <button class="btn btn-ghost btn-icon" data-close aria-label="ปิด">✕</button>
      </div>
      <form data-form><div class="modal-body">${body}</div>
        <div class="modal-foot">${footer}</div>
      </form>
    </div>`;
  document.body.appendChild(backdrop);
  document.body.style.overflow = 'hidden';

  const close = () => {
    backdrop.remove();
    document.body.style.overflow = '';
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);

  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop || e.target.closest('[data-close]')) close();
  });

  const form = backdrop.querySelector('[data-form]');
  if (onSubmit) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('[type="submit"]');
      if (btn) { btn.disabled = true; btn.dataset.label = btn.textContent; btn.textContent = 'กำลังบันทึก…'; }
      try {
        await onSubmit(formData(form), { close, root: backdrop });
      } catch (err) {
        toast(err.message || 'บันทึกไม่สำเร็จ', 'err');
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = btn.dataset.label; }
      }
    });
  }
  onMount?.(backdrop, close);
  backdrop.querySelector('input, select, textarea')?.focus();
  return { close, root: backdrop };
}

/** ยืนยันการทำรายการ */
export function confirmDialog({ title = 'ยืนยันการทำรายการ', message, confirmText = 'ยืนยัน', danger = true, needReason = false }) {
  return new Promise((resolve) => {
    let done = false;
    const m = modal({
      title,
      body: `<p style="margin:0 0 6px">${esc(message)}</p>${
        needReason ? '<div class="field" style="margin-top:12px"><label>เหตุผล</label><input name="reason" placeholder="ระบุเหตุผล (ไม่บังคับ)" autocomplete="off"></div>' : ''}`,
      footer: `<button type="button" class="btn" data-close>ยกเลิก</button>
               <button type="submit" class="btn ${danger ? 'btn-danger' : 'btn-primary'}">${esc(confirmText)}</button>`,
      onSubmit: (data, { close }) => { done = true; close(); resolve(needReason ? (data.reason || '') : true); },
    });
    m.root.addEventListener('click', (e) => {
      if ((e.target === m.root || e.target.closest('[data-close]')) && !done) resolve(null);
    });
  });
}

/* ---------------- ฟอร์ม ---------------- */

/** อ่านค่าจากฟอร์มเป็น object (checkbox -> boolean) */
export function formData(form) {
  const out = {};
  for (const el of form.querySelectorAll('input[name], select[name], textarea[name]')) {
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else out[el.name] = el.value;
  }
  return out;
}

/** สร้าง <option> จากรายการข้อมูล */
export function options(rows, { value = 'id', label = 'name', selected = null, empty = null } = {}) {
  const head = empty ? `<option value="">${esc(empty)}</option>` : '';
  return head + rows.map((r) => {
    const v = r[value];
    const text = typeof label === 'function' ? label(r) : r[label];
    return `<option value="${esc(v)}" ${String(v) === String(selected) ? 'selected' : ''}>${esc(text)}</option>`;
  }).join('');
}

/* ---------------- ตาราง ---------------- */

/**
 * สร้างตารางข้อมูล
 * @param {Array} rows ข้อมูล
 * @param {Array} columns [{ key, label, className, render(row) }]
 */
export function table(rows, columns, { emptyText = 'ยังไม่มีข้อมูล', rowClass, rowAttrs } = {}) {
  if (!rows?.length) {
    return `<div class="empty"><span class="big">📭</span>${esc(emptyText)}</div>`;
  }
  const head = columns.map((c) => `<th class="${c.className || ''}">${esc(c.label)}</th>`).join('');
  const body = rows.map((r) => {
    const cells = columns.map((c) => {
      const v = c.render ? c.render(r) : esc(r[c.key]);
      return `<td class="${c.className || ''}">${v ?? ''}</td>`;
    }).join('');
    return `<tr class="${rowClass ? rowClass(r) : ''}" ${rowAttrs ? rowAttrs(r) : ''}>${cells}</tr>`;
  }).join('');
  return `<div class="table-wrap"><table class="data"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

/** แถบแบ่งหน้า */
export function pager({ page, per_page, total }) {
  const pages = Math.max(1, Math.ceil(total / per_page));
  if (total === 0) return '';
  return `<div class="pager">
    <span class="muted">ทั้งหมด ${fmtInt(total)} รายการ · หน้า ${page}/${pages}</span>
    <button class="btn btn-sm" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}>← ก่อนหน้า</button>
    <button class="btn btn-sm" data-page="${page + 1}" ${page >= pages ? 'disabled' : ''}>ถัดไป →</button>
  </div>`;
}

export const loading = (text = 'กำลังโหลดข้อมูล…') =>
  `<div class="loading"><div class="spinner"></div>${esc(text)}</div>`;

export const statusBadge = (status) => status === 'void'
  ? '<span class="badge tone-danger">ยกเลิกแล้ว</span>'
  : '<span class="badge tone-success">บันทึกแล้ว</span>';

export const SERIAL_STATUS = {
  in_stock: ['อยู่ในคลัง', 'tone-success'],
  issued: ['ถูกเบิกออก', 'tone-warn'],
  scrapped: ['ตัดจำหน่าย', 'tone-danger'],
};
export const serialBadge = (s) => {
  const [label, tone] = SERIAL_STATUS[s] || [s, 'badge-gray'];
  return `<span class="badge ${tone}">${esc(label)}</span>`;
};

export const MOVE_LABEL = { IN: 'รับเข้า', OUT: 'เบิกออก', RETURN: 'รับคืน', ADJUST: 'ปรับปรุง', VOID: 'ยกเลิก' };
export const moveBadge = (t) => {
  const tone = { IN: 'tone-success', OUT: 'tone-warn', RETURN: 'tone-info', ADJUST: 'tone-primary', VOID: 'tone-danger' }[t] || 'badge-gray';
  return `<span class="badge ${tone}">${esc(MOVE_LABEL[t] || t)}</span>`;
};

/** แปลง object เป็นรายการ key/value สำหรับหน้ารายละเอียด */
export const kv = (pairs) => `<dl class="kv">${pairs
  .filter(([, v]) => v !== undefined && v !== null && v !== '')
  .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;
