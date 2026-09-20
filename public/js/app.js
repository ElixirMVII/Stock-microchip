import { api, ApiError } from './api.js';
import { esc, toast, formData, modal } from './ui.js';
import { routes } from './routes.js';

/* ============================================================
 *  โครงหลักของหน้าเว็บ: ตรวจสิทธิ์ สร้างเมนู และสลับหน้าตาม hash
 * ============================================================ */

export const state = {
  user: null,
  /** ข้อมูลหลักที่ใช้ซ้ำหลายหน้า (โหลดครั้งเดียวแล้ว cache) */
  cache: {},
  /** คลังที่กำลังดูอยู่ — null = ดูรวมทุกคลัง */
  warehouseId: null,
  warehouses: [],
};

/** พารามิเตอร์คลังสำหรับต่อท้าย query ของ API (ว่าง = รวมทุกคลัง) */
export const whParam = () => (state.warehouseId ? { warehouse_id: state.warehouseId } : {});

/** ชื่อคลังที่กำลังดู ใช้แสดงบนหัวข้อ */
export const whLabel = () => {
  const w = state.warehouses.find((x) => String(x.id) === String(state.warehouseId));
  return w ? `คลัง ${w.code}` : 'ทุกคลังรวมกัน';
};

/** โหลดข้อมูลหลักแบบใช้ซ้ำ (บังคับโหลดใหม่ด้วย refresh = true) */
export async function lookup(name, refresh = false) {
  const paths = {
    categories: '/categories?active=1&per_page=500',
    departments: '/departments?active=1&per_page=500',
    employees: '/employees?active=1&per_page=1000',
    isStaff: '/is-staff?active=1&per_page=500',
    warehouses: '/warehouses?active=1&per_page=200',
    suppliers: '/suppliers?active=1&per_page=500',
    items: '/items?active=1&per_page=1000',
  };
  if (refresh || !state.cache[name]) {
    state.cache[name] = (await api.get(paths[name])).data;
  }
  return state.cache[name];
}

export const clearLookups = () => { state.cache = {}; };

export const can = (role) => {
  const rank = { viewer: 1, officer: 2, admin: 3 };
  return (rank[state.user?.role] || 0) >= (rank[role] || 0);
};

/* ---------------- เมนูนำทาง ---------------- */

const NAV = [
  { group: 'ภาพรวม', items: [
    { hash: '#/', icon: '📊', label: 'แดชบอร์ด' },
  ] },
  { group: 'งานประจำวัน', items: [
    { hash: '#/receipts', icon: '📥', label: 'รับอุปกรณ์เข้า' },
    { hash: '#/issues', icon: '📤', label: 'เบิกอุปกรณ์ออก' },
    { hash: '#/returns', icon: '↩️', label: 'รับคืนอุปกรณ์' },
    { hash: '#/transfers', icon: '🔁', label: 'โอนย้ายระหว่างคลัง' },
    { hash: '#/adjustments', icon: '⚖️', label: 'ปรับปรุงสต็อก' },
  ] },
  { group: 'คลังสินค้า', items: [
    { hash: '#/stock', icon: '🏬', label: 'ยอดคงเหลือ', badge: 'low' },
    { hash: '#/serials', icon: '🔖', label: 'ทรัพย์สิน / Serial' },
    { hash: '#/moves', icon: '🧾', label: 'ประวัติเคลื่อนไหว' },
  ] },
  { group: 'รายงาน', items: [
    { hash: '#/reports', icon: '📈', label: 'รายงาน' },
  ] },
  { group: 'ตั้งค่า', items: [
    { hash: '#/master', icon: '🗂️', label: 'ข้อมูลหลัก' },
    { hash: '#/users', icon: '👥', label: 'ผู้ใช้งาน', role: 'admin' },
  ] },
];

let lowCount = 0;

function shell() {
  const initials = (state.user.full_name || state.user.username).trim().slice(0, 1).toUpperCase();
  const roleLabel = { admin: 'ผู้ดูแลระบบ', officer: 'เจ้าหน้าที่', viewer: 'ผู้ดูข้อมูล' }[state.user.role];
  const nav = NAV.map((g) => {
    const items = g.items.filter((i) => !i.role || can(i.role));
    if (!items.length) return '';
    return `<div class="nav-group"><div class="nav-label">${esc(g.group)}</div>${items.map((i) => `
      <a href="${i.hash}" data-nav="${i.hash}"><span class="ico">${i.icon}</span>${esc(i.label)}
        ${i.badge === 'low' ? '<span class="badge-count" data-low hidden></span>' : ''}</a>`).join('')}</div>`;
  }).join('');

  return `
  <div class="app">
    <aside class="sidebar" id="sidebar">
      <div class="brand">
        <div class="logo">📦</div>
        <div><div class="title">สต็อกอุปกรณ์ไอที</div><div class="subtitle">Hardware Stock System</div></div>
      </div>
      <nav class="nav">${nav}</nav>
      <div style="padding:10px 14px;border-top:1px solid var(--border)">
        <button class="btn btn-ghost btn-sm" id="theme-btn" style="width:100%">🌓 สลับธีม</button>
      </div>
    </aside>
    <div class="main">
      <header class="topbar">
        <button class="menu-toggle" id="menu-btn" aria-label="เมนู">☰</button>
        <div class="page-title" id="page-title">แดชบอร์ด</div>
        <div class="spacer"></div>
        <label class="wh-switch" title="เลือกคลังที่ต้องการดู">
          <span class="wh-ico">🏬</span>
          <select id="wh-filter">
            <option value="">ทุกคลัง (รวม)</option>
            ${state.warehouses.map((w) => `<option value="${w.id}" ${String(w.id) === String(state.warehouseId) ? 'selected' : ''}>คลัง ${esc(w.code)}</option>`).join('')}
          </select>
        </label>
        <div class="user-chip">
          <span class="avatar">${esc(initials)}</span>
          <span class="who"><b>${esc(state.user.full_name)}</b> <span class="muted small">· ${esc(roleLabel)}</span></span>
        </div>
        <button class="btn btn-sm" id="pw-btn" title="เปลี่ยนรหัสผ่าน">🔑</button>
        <button class="btn btn-sm" id="logout-btn" title="ออกจากระบบ">
          <span class="btn-label">ออกจากระบบ</span><span class="btn-icon-only">⎋</span></button>
      </header>
      <main class="content" id="view"></main>
    </div>
  </div>`;
}

/* ---------------- หน้าเข้าสู่ระบบ ---------------- */

function renderLogin(message) {
  document.getElementById('root').innerHTML = `
    <div class="login-wrap">
      <form class="login-card" id="login-form">
        <div style="font-size:34px;text-align:center;margin-bottom:8px">📦</div>
        <h1 style="text-align:center">ระบบจัดการสต็อกอุปกรณ์ไอที</h1>
        <div class="sub" style="text-align:center">Hardware Stock Management System</div>
        ${message ? `<div class="badge tone-danger" style="display:block;text-align:center;padding:8px;margin-bottom:14px">${esc(message)}</div>` : ''}
        <div class="field">
          <label for="u">ชื่อผู้ใช้</label>
          <input id="u" name="username" autocomplete="username" required autofocus>
        </div>
        <div class="field">
          <label for="p">รหัสผ่าน</label>
          <input id="p" name="password" type="password" autocomplete="current-password" required>
        </div>
        <button class="btn btn-primary" style="width:100%;margin-top:6px" type="submit">เข้าสู่ระบบ</button>
        <div class="login-hint">ค่าเริ่มต้นสำหรับติดตั้งใหม่ — ผู้ใช้ <b>admin</b> / รหัสผ่าน <b>admin1234</b> (กรุณาเปลี่ยนทันทีหลังเข้าใช้งาน)</div>
      </form>
    </div>`;

  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    btn.disabled = true; btn.textContent = 'กำลังเข้าสู่ระบบ…';
    try {
      const { user } = await api.post('/auth/login', formData(e.target));
      state.user = user;
      clearLookups();
      await boot();
    } catch (err) {
      renderLogin(err.message);
    } finally {
      btn.disabled = false;
    }
  });
}

/* ---------------- ตัวจัดเส้นทาง ---------------- */

async function renderRoute() {
  const hash = location.hash || '#/';
  const [path] = hash.split('?');
  const route = routes[path] || routes['#/'];

  document.querySelectorAll('[data-nav]').forEach((a) => {
    a.classList.toggle('active', a.dataset.nav === path);
  });
  document.getElementById('page-title').textContent = route.title;
  document.title = `${route.title} · สต็อกอุปกรณ์ไอที`;
  document.getElementById('sidebar')?.classList.remove('open');

  // สร้าง element ใหม่ทุกครั้ง เพื่อให้ event listener ของหน้าเดิมถูกทิ้งไปพร้อมกัน
  const old = document.getElementById('view');
  const view = document.createElement('main');
  view.className = 'content';
  view.id = 'view';
  view.innerHTML = '<div class="loading"><div class="spinner"></div>กำลังโหลด…</div>';
  old.replaceWith(view);
  try {
    await route.render(view);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return;
    view.innerHTML = `<div class="card"><div class="card-body">
      <h3 style="color:var(--danger)">เปิดหน้านี้ไม่สำเร็จ</h3>
      <p class="muted">${esc(err.message)}</p>
      <button class="btn" onclick="location.reload()">โหลดหน้าใหม่</button></div></div>`;
  }
  refreshLowBadge();
}

/** ป้ายจำนวนอุปกรณ์ใกล้หมดบนเมนู */
export async function refreshLowBadge() {
  try {
    const { total } = await api.get('/stock/low'); // คิดจากยอดรวมทุกคลังเสมอ
    lowCount = total;
    document.querySelectorAll('[data-low]').forEach((b) => {
      b.textContent = total;
      b.hidden = total === 0;
    });
  } catch { /* ไม่สำคัญพอจะรบกวนผู้ใช้ */ }
}

/* ---------------- เริ่มระบบ ---------------- */

function changePasswordDialog() {
  modal({
    title: 'เปลี่ยนรหัสผ่าน',
    body: `
      <div class="field"><label>รหัสผ่านปัจจุบัน <span class="req">*</span></label>
        <input name="current_password" type="password" required autocomplete="current-password"></div>
      <div class="field"><label>รหัสผ่านใหม่ <span class="req">*</span></label>
        <input name="new_password" type="password" required minlength="8" autocomplete="new-password">
        <div class="help">อย่างน้อย 8 ตัวอักษร</div></div>`,
    footer: `<button type="button" class="btn" data-close>ยกเลิก</button>
             <button type="submit" class="btn btn-primary">บันทึก</button>`,
    onSubmit: async (data, { close }) => {
      await api.post('/auth/change-password', data);
      close();
      toast('เปลี่ยนรหัสผ่านเรียบร้อยแล้ว');
    },
  });
}

async function boot() {
  // โหลดรายชื่อคลังก่อน เพราะตัวเลือกคลังอยู่บนแถบบนของทุกหน้า
  try {
    state.warehouses = await lookup('warehouses');
    const saved = localStorage.getItem('hwstock-warehouse');
    if (saved && state.warehouses.some((w) => String(w.id) === saved)) state.warehouseId = saved;
  } catch { state.warehouses = []; }

  document.getElementById('root').innerHTML = shell();

  document.getElementById('logout-btn').addEventListener('click', async () => {
    await api.post('/auth/logout');
    state.user = null;
    clearLookups();
    renderLogin();
  });
  document.getElementById('pw-btn').addEventListener('click', changePasswordDialog);
  document.getElementById('menu-btn').addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('open');
  });
  document.getElementById('wh-filter').addEventListener('change', (e) => {
    state.warehouseId = e.target.value || null;
    try { localStorage.setItem('hwstock-warehouse', state.warehouseId ?? ''); } catch { /* โหมดส่วนตัว */ }
    renderRoute();
  });
  document.getElementById('theme-btn').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('hwstock-theme', next); } catch { /* โหมดส่วนตัว */ }
  });

  await renderRoute();
}

window.addEventListener('hashchange', () => { if (state.user) renderRoute(); });
window.addEventListener('auth:expired', () => {
  if (state.user) {
    state.user = null;
    renderLogin('เซสชันหมดอายุ กรุณาเข้าสู่ระบบอีกครั้ง');
  }
});

(async function start() {
  try {
    const saved = localStorage.getItem('hwstock-theme');
    if (saved) document.documentElement.dataset.theme = saved;
  } catch { /* โหมดส่วนตัว */ }

  try {
    const { user } = await api.get('/auth/me');
    if (user) { state.user = user; await boot(); }
    else renderLogin();
  } catch {
    renderLogin();
  }
})();
