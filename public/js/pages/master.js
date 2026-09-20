import { api } from '../api.js';
import { lookup, can, clearLookups } from '../app.js';
import { esc, fmtInt, fmtMoney, table, pager, options, modal, toast, confirmDialog, loading } from '../ui.js';

/* ============================================================
 *  ข้อมูลหลัก — อุปกรณ์ หมวดหมู่ แผนก พนักงาน เจ้าหน้าที่ IS ผู้ขาย
 * ============================================================ */

const activeBadge = (a) => a
  ? '<span class="badge tone-success">ใช้งาน</span>'
  : '<span class="badge badge-gray">ปิดใช้งาน</span>';

const field = (label, input, { required = false, help = '' } = {}) => `
  <div class="field">
    <label>${esc(label)} ${required ? '<span class="req">*</span>' : ''}</label>
    ${input}
    ${help ? `<div class="help">${esc(help)}</div>` : ''}
  </div>`;

const text = (name, value = '', attrs = '') =>
  `<input name="${name}" value="${esc(value ?? '')}" ${attrs}>`;

const checkbox = (name, checked, label) =>
  `<label class="check-row"><input type="checkbox" name="${name}" ${checked ? 'checked' : ''}> ${esc(label)}</label>`;

/** นิยามของแต่ละแท็บข้อมูลหลัก */
function tabDefs(ctx) {
  return {
    items: {
      label: '📦 อุปกรณ์',
      path: '/items',
      entity: 'อุปกรณ์',
      searchPlaceholder: 'ค้นหารหัส ชื่อ ยี่ห้อ หรือรุ่น',
      columns: [
        { key: 'sku', label: 'รหัส', render: (r) => `<b class="mono">${esc(r.sku)}</b>` },
        { key: 'name', label: 'ชื่ออุปกรณ์', render: (r) => `<b>${esc(r.name)}</b>${r.model ? `<div class="muted small">${esc(r.brand || '')} ${esc(r.model)}</div>` : ''}` },
        { key: 'category_name', label: 'หมวดหมู่', render: (r) => `<span class="badge badge-gray">${esc(r.category_name)}</span>` },
        { key: 'unit', label: 'หน่วย' },
        { key: 'track_serial', label: 'Serial', className: 'center', render: (r) => r.track_serial
          ? '<span class="badge tone-info">ติดตามรายชิ้น</span>' : '<span class="muted small">นับจำนวน</span>' },
        { key: 'balance', label: 'คงเหลือ', className: 'num', render: (r) => `<b>${fmtInt(r.balance)}</b>` },
        { key: 'min_qty', label: 'ขั้นต่ำ', className: 'num', render: (r) => fmtInt(r.min_qty) },
        { key: 'unit_cost', label: 'ราคา/หน่วย', className: 'num', render: (r) => `฿${fmtMoney(r.unit_cost)}` },
        { key: 'active', label: 'สถานะ', render: (r) => activeBadge(r.active) },
      ],
      form: (r = {}) => `
        <div class="inline">
          ${field('รหัสอุปกรณ์ (SKU)', text('sku', r.sku, 'required placeholder="เช่น MON-E1715S"'), { required: true })}
          ${field('หมวดหมู่', `<select name="category_id" required>${options(ctx.categories, { selected: r.category_id })}</select>`, { required: true })}
        </div>
        ${field('ชื่ออุปกรณ์', text('name', r.name, 'required placeholder="เช่น Dell 17&quot; monitor E1715S"'), { required: true })}
        <div class="inline">
          ${field('ยี่ห้อ', text('brand', r.brand))}
          ${field('รุ่น', text('model', r.model))}
          ${field('หน่วยนับ', text('unit', r.unit || 'EA'))}
        </div>
        <div class="inline">
          ${field('จุดสั่งซื้อขั้นต่ำ', text('min_qty', r.min_qty ?? 0, 'type="number" min="0"'), { help: 'แจ้งเตือนเมื่อคงเหลือถึงระดับนี้' })}
          ${field('ราคาต่อหน่วย (บาท)', text('unit_cost', r.unit_cost ?? 0, 'type="number" min="0" step="0.01"'))}
          ${field('ที่จัดเก็บ', text('location', r.location, 'placeholder="เช่น ชั้น 2 ห้อง IT"'))}
        </div>
        ${field('หมายเหตุ', text('note', r.note))}
        <div class="inline">
          <div class="field">${checkbox('track_serial', r.track_serial, 'ติดตามด้วย Serial / Asset No. รายชิ้น')}
            <div class="help">เปิดสำหรับโน้ตบุ๊ก จอภาพ หรือของที่ต้องรู้ว่าใครถืออยู่</div></div>
          <div class="field">${checkbox('active', r.id ? r.active : true, 'เปิดใช้งาน')}</div>
        </div>`,
      lockedHint: (r) => r.total_in > 0 ? 'อุปกรณ์นี้มีความเคลื่อนไหวแล้ว ไม่ควรเปลี่ยนการติดตาม Serial' : '',
    },

    categories: {
      label: '🗂️ หมวดหมู่',
      path: '/categories',
      entity: 'หมวดหมู่',
      searchPlaceholder: 'ค้นหารหัสหรือชื่อหมวดหมู่',
      columns: [
        { key: 'code', label: 'รหัส', render: (r) => `<span class="mono">${esc(r.code)}</span>` },
        { key: 'name', label: 'ชื่อหมวดหมู่', render: (r) => `<b>${esc(r.name)}</b>` },
        { key: 'kind', label: 'คอลัมน์ในรายงาน', render: (r) => {
          const m = { desktop: 'Desktop', laptop: 'Laptop', accessory: 'Accessories', other: 'อื่น ๆ' };
          return `<span class="badge badge-gray">${esc(m[r.kind] || r.kind)}</span>`;
        } },
        { key: 'sort_order', label: 'ลำดับ', className: 'num' },
        { key: 'active', label: 'สถานะ', render: (r) => activeBadge(r.active) },
      ],
      form: (r = {}) => `
        <div class="inline">
          ${field('รหัสหมวดหมู่', text('code', r.code, 'required placeholder="เช่น LAPTOP"'), { required: true })}
          ${field('ลำดับการแสดง', text('sort_order', r.sort_order ?? 100, 'type="number" min="0"'))}
        </div>
        ${field('ชื่อหมวดหมู่', text('name', r.name, 'required'), { required: true })}
        ${field('จัดอยู่ในคอลัมน์ใดของรายงานรายเดือน', `
          <select name="kind">
            <option value="desktop" ${r.kind === 'desktop' ? 'selected' : ''}>Desktop</option>
            <option value="laptop" ${r.kind === 'laptop' ? 'selected' : ''}>Laptop</option>
            <option value="accessory" ${r.kind === 'accessory' ? 'selected' : ''}>Accessories</option>
            <option value="other" ${!r.kind || r.kind === 'other' ? 'selected' : ''}>อื่น ๆ</option>
          </select>`, { help: 'ใช้จัดคอลัมน์ให้เหมือนไฟล์ Excel เดิม' })}
        <div class="field">${checkbox('active', r.id ? r.active : true, 'เปิดใช้งาน')}</div>`,
    },

    departments: {
      label: '🏢 แผนก',
      path: '/departments',
      entity: 'แผนก',
      searchPlaceholder: 'ค้นหารหัสหรือชื่อแผนก',
      columns: [
        { key: 'code', label: 'รหัส', render: (r) => `<span class="mono">${esc(r.code)}</span>` },
        { key: 'name', label: 'ชื่อแผนก', render: (r) => `<b>${esc(r.name)}</b>` },
        { key: 'active', label: 'สถานะ', render: (r) => activeBadge(r.active) },
      ],
      form: (r = {}) => `
        ${field('รหัสแผนก', text('code', r.code, 'required placeholder="เช่น MFG-ENG"'), { required: true })}
        ${field('ชื่อแผนก', text('name', r.name, 'required placeholder="เช่น MFG Eng."'), { required: true })}
        <div class="field">${checkbox('active', r.id ? r.active : true, 'เปิดใช้งาน')}</div>`,
    },

    employees: {
      label: '👤 พนักงาน',
      path: '/employees',
      entity: 'พนักงาน',
      searchPlaceholder: 'ค้นหารหัสพนักงาน ชื่อ หรือแผนก',
      columns: [
        { key: 'emp_code', label: 'รหัสพนักงาน', render: (r) => `<b class="mono">${esc(r.emp_code)}</b>` },
        { key: 'name', label: 'ชื่อ-นามสกุล', render: (r) => `<b>${esc(r.name)}</b>${r.position ? `<div class="muted small">${esc(r.position)}</div>` : ''}` },
        { key: 'department_name', label: 'แผนก', render: (r) => esc(r.department_name || '—') },
        { key: 'email', label: 'อีเมล', render: (r) => `<span class="small">${esc(r.email || '—')}</span>` },
        { key: 'phone', label: 'โทรศัพท์', render: (r) => `<span class="small">${esc(r.phone || '—')}</span>` },
        { key: 'active', label: 'สถานะ', render: (r) => activeBadge(r.active) },
      ],
      form: (r = {}) => `
        <div class="inline">
          ${field('รหัสพนักงาน', text('emp_code', r.emp_code, 'required placeholder="เช่น 897500"'), { required: true })}
          ${field('แผนก', `<select name="department_id">${options(ctx.departments, { empty: '— ไม่ระบุ —', selected: r.department_id })}</select>`)}
        </div>
        ${field('ชื่อ-นามสกุล', text('name', r.name, 'required placeholder="เช่น Tanakit W."'), { required: true })}
        ${field('ตำแหน่ง', text('position', r.position))}
        <div class="inline">
          ${field('อีเมล', text('email', r.email, 'type="email"'))}
          ${field('โทรศัพท์', text('phone', r.phone))}
        </div>
        <div class="field">${checkbox('active', r.id ? r.active : true, 'เปิดใช้งาน')}</div>`,
    },

    'is-staff': {
      label: '🧑‍💼 เจ้าหน้าที่ IS',
      path: '/is-staff',
      entity: 'เจ้าหน้าที่ IS',
      searchPlaceholder: 'ค้นหาชื่อเจ้าหน้าที่',
      columns: [
        { key: 'name', label: 'ชื่อเจ้าหน้าที่', render: (r) => `<b>${esc(r.name)}</b>` },
        { key: 'email', label: 'อีเมล', render: (r) => esc(r.email || '—') },
        { key: 'active', label: 'สถานะ', render: (r) => activeBadge(r.active) },
      ],
      form: (r = {}) => `
        ${field('ชื่อเจ้าหน้าที่', text('name', r.name, 'required placeholder="เช่น Suwan"'), { required: true, help: 'จะปรากฏในคอลัมน์ IS ของใบเบิก' })}
        ${field('อีเมล', text('email', r.email, 'type="email"'))}
        <div class="field">${checkbox('active', r.id ? r.active : true, 'เปิดใช้งาน')}</div>`,
    },

    suppliers: {
      label: '🚚 ผู้ขาย',
      path: '/suppliers',
      entity: 'ผู้ขาย',
      searchPlaceholder: 'ค้นหารหัส ชื่อ หรือผู้ติดต่อ',
      columns: [
        { key: 'code', label: 'รหัส', render: (r) => `<span class="mono">${esc(r.code)}</span>` },
        { key: 'name', label: 'ชื่อผู้ขาย', render: (r) => `<b>${esc(r.name)}</b>` },
        { key: 'contact', label: 'ผู้ติดต่อ', render: (r) => esc(r.contact || '—') },
        { key: 'phone', label: 'โทรศัพท์', render: (r) => esc(r.phone || '—') },
        { key: 'active', label: 'สถานะ', render: (r) => activeBadge(r.active) },
      ],
      form: (r = {}) => `
        <div class="inline">
          ${field('รหัสผู้ขาย', text('code', r.code, 'required'), { required: true })}
          ${field('ชื่อผู้ขาย', text('name', r.name, 'required'), { required: true })}
        </div>
        <div class="inline">
          ${field('ผู้ติดต่อ', text('contact', r.contact))}
          ${field('โทรศัพท์', text('phone', r.phone))}
          ${field('อีเมล', text('email', r.email, 'type="email"'))}
        </div>
        <div class="field">${checkbox('active', r.id ? r.active : true, 'เปิดใช้งาน')}</div>`,
    },
  };
}

export async function renderMaster(view) {
  const [categories, departments] = await Promise.all([lookup('categories'), lookup('departments')]);
  const defs = tabDefs({ categories, departments });
  const keys = Object.keys(defs);
  const q = { tab: keys[0], q: '', active: '', page: 1, per_page: 40 };

  view.innerHTML = `
    <div class="toolbar">
      ${keys.map((k) => `<button class="btn btn-sm" data-tab="${k}">${esc(defs[k].label)}</button>`).join('')}
    </div>
    <div class="toolbar">
      <input id="q" placeholder="🔍 ค้นหา" style="min-width:250px">
      <select id="active">
        <option value="">ทุกสถานะ</option>
        <option value="1">เฉพาะที่เปิดใช้งาน</option>
        <option value="0">เฉพาะที่ปิดใช้งาน</option>
      </select>
      <div class="spacer"></div>
      ${can('officer') ? '<button class="btn btn-primary" id="create">+ เพิ่มข้อมูล</button>' : ''}
    </div>
    <div class="card"><div class="card-body tight" id="list">${loading()}</div></div>`;

  const def = () => defs[q.tab];

  const load = async () => {
    const box = view.querySelector('#list');
    box.innerHTML = loading();
    const res = await api.get(`${def().path}${api.qs({ q: q.q, active: q.active, page: q.page, per_page: q.per_page })}`);
    const cols = [...def().columns];
    if (can('officer')) {
      cols.push({ key: 'act', label: '', className: 'nowrap', render: (r) => `
        <button class="btn btn-sm" data-edit="${r.id}">แก้ไข</button>
        ${can('admin') ? `<button class="btn btn-sm btn-ghost" data-del="${r.id}" title="ลบ">🗑</button>` : ''}` });
    }
    box.innerHTML = table(res.data, cols, { emptyText: `ยังไม่มีข้อมูล${def().entity}` }) + pager(res);
    box._rows = res.data;
  };

  const openForm = (row) => {
    const d = def();
    const isEdit = !!row;
    modal({
      title: `${isEdit ? 'แก้ไข' : 'เพิ่ม'}${d.entity}`,
      wide: q.tab === 'items',
      body: d.form(row || {}) + (isEdit && d.lockedHint?.(row) ? `<div class="help" style="color:var(--warn)">⚠️ ${esc(d.lockedHint(row))}</div>` : ''),
      footer: `<button type="button" class="btn" data-close>ยกเลิก</button>
               <button type="submit" class="btn btn-primary">บันทึก</button>`,
      onSubmit: async (data, { close }) => {
        if (isEdit) await api.put(`${d.path}/${row.id}`, data);
        else await api.post(d.path, data);
        close();
        toast(`บันทึก${d.entity}เรียบร้อยแล้ว`);
        clearLookups();
        await load();
      },
    });
  };

  const setTab = (k) => {
    q.tab = k; q.page = 1; q.q = '';
    view.querySelector('#q').value = '';
    view.querySelector('#q').placeholder = `🔍 ${defs[k].searchPlaceholder}`;
    view.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('btn-primary', b.dataset.tab === k));
    load();
  };

  let timer;
  view.querySelector('#q').addEventListener('input', (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => { q.q = e.target.value; q.page = 1; load(); }, 280);
  });
  view.querySelector('#active').addEventListener('change', (e) => { q.active = e.target.value; q.page = 1; load(); });
  view.querySelector('#create')?.addEventListener('click', () => openForm(null));

  view.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-tab]');
    if (t) return setTab(t.dataset.tab);

    const p = e.target.closest('[data-page]');
    if (p) { q.page = Number(p.dataset.page); return load(); }

    const ed = e.target.closest('[data-edit]');
    if (ed) {
      const row = view.querySelector('#list')._rows.find((r) => String(r.id) === ed.dataset.edit);
      return openForm(row);
    }

    const del = e.target.closest('[data-del]');
    if (del) {
      const row = view.querySelector('#list')._rows.find((r) => String(r.id) === del.dataset.del);
      const ok = await confirmDialog({
        title: `ลบ${def().entity}`,
        message: `ต้องการลบ "${row.name || row.sku}" ออกจากระบบหรือไม่? หากข้อมูลถูกใช้งานอยู่ ระบบจะแนะนำให้ปิดใช้งานแทน`,
        confirmText: 'ลบข้อมูล',
      });
      if (!ok) return;
      try {
        await api.del(`${def().path}/${row.id}`);
        toast('ลบข้อมูลเรียบร้อยแล้ว');
        clearLookups();
        await load();
      } catch (err) {
        toast(err.message, 'err');
      }
    }
  });

  setTab(keys[0]);
}

/* ---------------- ผู้ใช้งานระบบ ---------------- */

const ROLES = { admin: 'ผู้ดูแลระบบ', officer: 'เจ้าหน้าที่คลัง', viewer: 'ผู้ดูข้อมูล' };
const ROLE_HELP = {
  admin: 'จัดการได้ทุกอย่าง รวมถึงผู้ใช้งานและการลบข้อมูลหลัก',
  officer: 'บันทึกเอกสารรับเข้า/เบิกออก และเพิ่มแก้ไขข้อมูลหลักได้',
  viewer: 'ดูข้อมูลและรายงานได้อย่างเดียว',
};

export async function renderUsers(view) {
  view.innerHTML = `
    <div class="toolbar">
      <div class="muted">กำหนดสิทธิ์การเข้าถึงระบบของผู้ใช้แต่ละคน</div>
      <div class="spacer"></div>
      <button class="btn btn-primary" id="create">+ เพิ่มผู้ใช้งาน</button>
    </div>
    <div class="card"><div class="card-body tight" id="list">${loading()}</div></div>
    <div class="card"><div class="card-body">
      <h3 style="font-size:13px;margin-bottom:8px">คำอธิบายสิทธิ์การใช้งาน</h3>
      ${Object.entries(ROLE_HELP).map(([k, v]) =>
        `<div style="margin-bottom:5px"><span class="badge tone-primary">${esc(ROLES[k])}</span> <span class="muted small">${esc(v)}</span></div>`).join('')}
    </div></div>`;

  const load = async () => {
    const box = view.querySelector('#list');
    box.innerHTML = loading();
    const res = await api.get('/users');
    box.innerHTML = table(res.data, [
      { key: 'username', label: 'ชื่อผู้ใช้', render: (r) => `<b class="mono">${esc(r.username)}</b>` },
      { key: 'full_name', label: 'ชื่อ-นามสกุล', render: (r) => esc(r.full_name) },
      { key: 'role', label: 'สิทธิ์', render: (r) => `<span class="badge tone-primary">${esc(ROLES[r.role] || r.role)}</span>` },
      { key: 'active', label: 'สถานะ', render: (r) => activeBadge(r.active) },
      { key: 'created_at', label: 'สร้างเมื่อ', render: (r) => `<span class="muted small">${esc(String(r.created_at).replace('T', ' ').slice(0, 16))}</span>` },
      { key: 'act', label: '', className: 'nowrap', render: (r) => `
        <button class="btn btn-sm" data-edit="${r.id}">แก้ไข</button>
        <button class="btn btn-sm btn-ghost" data-del="${r.id}" title="ลบ">🗑</button>` },
    ], { emptyText: 'ยังไม่มีผู้ใช้งาน' });
    box._rows = res.data;
  };

  const openForm = (row) => {
    const isEdit = !!row;
    modal({
      title: isEdit ? `แก้ไขผู้ใช้ ${row.username}` : 'เพิ่มผู้ใช้งานใหม่',
      body: `
        ${isEdit ? '' : field('ชื่อผู้ใช้', text('username', '', 'required autocomplete="off" placeholder="เช่น somchai"'), { required: true })}
        ${field('ชื่อ-นามสกุล', text('full_name', row?.full_name, 'required'), { required: true })}
        ${field('สิทธิ์การใช้งาน', `<select name="role">${Object.entries(ROLES).map(([k, v]) =>
          `<option value="${k}" ${row?.role === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>`)}
        ${field(isEdit ? 'รหัสผ่านใหม่ (เว้นว่างหากไม่เปลี่ยน)' : 'รหัสผ่าน',
          `<input name="password" type="password" minlength="8" ${isEdit ? '' : 'required'} autocomplete="new-password">`,
          { required: !isEdit, help: 'อย่างน้อย 8 ตัวอักษร' })}
        <div class="field">${checkbox('active', isEdit ? row.active : true, 'เปิดใช้งานบัญชีนี้')}</div>`,
      footer: `<button type="button" class="btn" data-close>ยกเลิก</button>
               <button type="submit" class="btn btn-primary">บันทึก</button>`,
      onSubmit: async (data, { close }) => {
        if (isEdit && !data.password) delete data.password;
        if (isEdit) await api.put(`/users/${row.id}`, data);
        else await api.post('/users', data);
        close();
        toast('บันทึกผู้ใช้งานเรียบร้อยแล้ว');
        await load();
      },
    });
  };

  view.querySelector('#create').addEventListener('click', () => openForm(null));
  view.addEventListener('click', async (e) => {
    const ed = e.target.closest('[data-edit]');
    if (ed) return openForm(view.querySelector('#list')._rows.find((r) => String(r.id) === ed.dataset.edit));

    const del = e.target.closest('[data-del]');
    if (del) {
      const row = view.querySelector('#list')._rows.find((r) => String(r.id) === del.dataset.del);
      const ok = await confirmDialog({ title: 'ลบผู้ใช้งาน', message: `ต้องการลบบัญชี "${row.username}" หรือไม่?`, confirmText: 'ลบบัญชี' });
      if (!ok) return;
      try {
        await api.del(`/users/${row.id}`);
        toast('ลบผู้ใช้งานเรียบร้อยแล้ว');
        await load();
      } catch (err) {
        toast(err.message, 'err');
      }
    }
  });

  await load();
}
