import { api } from '../api.js';
import { esc, fmtInt, fmtMoney, fmtDate, table, loading, MONTH_FULL } from '../ui.js';
import { whParam, whLabel } from '../app.js';

/* ============================================================
 *  รายงาน — รวมถึงมุมมองรายเดือนแบบเดียวกับไฟล์ Excel เดิม
 * ============================================================ */

const TABS = [
  { id: 'monthly', label: '📅 รายเดือน (รูปแบบเดิม)' },
  { id: 'department', label: '🏢 สรุปตามแผนก' },
  { id: 'category', label: '🗂️ สรุปตามหมวดหมู่' },
  { id: 'top', label: '🔥 อุปกรณ์ที่เบิกบ่อย' },
  { id: 'assets', label: '🔖 ทรัพย์สินที่ถือครอง' },
  { id: 'charge', label: '💵 สรุปค่าใช้จ่าย' },
  { id: 'audit', label: '📜 บันทึกการใช้งาน' },
];

export async function renderReports(view) {
  const now = new Date();
  const s = { tab: 'monthly', year: now.getFullYear(), month: now.getMonth() + 1 };

  const years = [];
  for (let y = now.getFullYear() + 1; y >= now.getFullYear() - 5; y--) years.push(y);

  view.innerHTML = `
    <div class="toolbar">
      ${TABS.map((t) => `<button class="btn btn-sm" data-tab="${t.id}">${esc(t.label)}</button>`).join('')}
    </div>
    <div class="toolbar" id="period">
      <div class="fixed"><label class="small muted">ปี</label>
        <select id="year">${years.map((y) => `<option value="${y}" ${y === s.year ? 'selected' : ''}>${y} (พ.ศ. ${y + 543})</option>`).join('')}</select></div>
      <div class="fixed"><label class="small muted">เดือน</label>
        <select id="month">${MONTH_FULL.map((m, i) => `<option value="${i + 1}" ${i + 1 === s.month ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select></div>
      <div class="spacer"></div>
      <span class="badge tone-primary">ขอบเขต: ${esc(whLabel())}</span>
      <a class="btn btn-sm" id="csv">⬇️ ส่งออก CSV</a>
      <button class="btn btn-sm" id="print">🖨️ พิมพ์</button>
    </div>
    <div id="body">${loading()}</div>`;

  const setTab = (id) => {
    s.tab = id;
    view.querySelectorAll('[data-tab]').forEach((b) => {
      b.classList.toggle('btn-primary', b.dataset.tab === id);
    });
    view.querySelector('#period').style.display = ['assets', 'audit'].includes(id) ? 'none' : '';
    load();
  };

  const load = async () => {
    const box = view.querySelector('#body');
    box.innerHTML = loading();
    const period = api.qs({ year: s.year, month: s.month, ...whParam() });
    const csv = view.querySelector('#csv');
    csv.style.display = '';

    try {
      if (s.tab === 'monthly') {
        csv.href = `/api/reports/monthly.csv${period}`;
        box.innerHTML = monthlyView(await api.get(`/reports/monthly${period}`), s);
      } else if (s.tab === 'department') {
        csv.style.display = 'none';
        box.innerHTML = departmentView(await api.get(`/reports/by-department${period}`));
      } else if (s.tab === 'category') {
        csv.style.display = 'none';
        box.innerHTML = categoryView(await api.get(`/reports/by-category${period}`));
      } else if (s.tab === 'top') {
        csv.style.display = 'none';
        box.innerHTML = topView(await api.get(`/reports/top-items${period}`));
      } else if (s.tab === 'assets') {
        csv.href = '/api/reports/assets-by-holder.csv';
        box.innerHTML = assetsView(await api.get('/reports/assets-by-holder'));
      } else if (s.tab === 'charge') {
        csv.style.display = 'none';
        box.innerHTML = chargeView(await api.get(`/reports/charge-summary${period}`));
      } else if (s.tab === 'audit') {
        csv.style.display = 'none';
        box.innerHTML = auditView(await api.get('/reports/audit'));
      }
    } catch (err) {
      box.innerHTML = `<div class="card"><div class="card-body"><p style="color:var(--danger)">${esc(err.message)}</p></div></div>`;
    }
  };

  view.addEventListener('click', (e) => {
    const t = e.target.closest('[data-tab]');
    if (t) setTab(t.dataset.tab);
  });
  view.querySelector('#year').addEventListener('change', (e) => { s.year = Number(e.target.value); load(); });
  view.querySelector('#month').addEventListener('change', (e) => { s.month = Number(e.target.value); load(); });
  view.querySelector('#print').addEventListener('click', () => window.print());

  setTab('monthly');
}

/* ---------------- รายเดือนแบบไฟล์เดิม ---------------- */

const cellList = (arr) => arr.length
  ? arr.map((x) => `<div>${esc(x)}</div>`).join('')
  : '<span class="muted">—</span>';

function monthlyView(d, s) {
  const sum = d.summary;
  return `
    <div class="grid cols-4" style="margin-bottom:16px">
      <div class="stat"><div class="icon tone-success">📥</div><div>
        <div class="label">รับเข้ารวม</div><div class="value">${fmtInt(sum.in_qty)}</div>
        <div class="hint">${fmtInt(sum.in_lines)} บรรทัด</div></div></div>
      <div class="stat"><div class="icon tone-warn">📤</div><div>
        <div class="label">ใบเบิก</div><div class="value">${fmtInt(sum.out_docs)}</div>
        <div class="hint">${fmtInt(sum.out_items)} ชิ้น</div></div></div>
      <div class="stat"><div class="icon tone-primary">✅</div><div>
        <div class="label">Charge = Y</div><div class="value">${fmtInt(sum.charged)}</div></div></div>
      <div class="stat"><div class="icon tone-info">🆓</div><div>
        <div class="label">Charge = N</div><div class="value">${fmtInt(sum.not_charged)}</div></div></div>
    </div>

    <div class="card">
      <div class="card-head"><h3>IN — รับอุปกรณ์เข้า (${esc(MONTH_FULL[s.month - 1])} ${s.year})</h3></div>
      <div class="card-body tight">
        ${table(d.inbound, [
          { key: 'date', label: 'Receive Date', className: 'nowrap', render: (r) => fmtDate(r.date) },
          { key: 'warehouse_code', label: 'คลัง', render: (r) => `<span class="badge tone-info">${esc(r.warehouse_code)}</span>` },
          { key: 'po_no', label: 'PO# No.', render: (r) => `<span class="mono">${esc(r.po_no || '—')}</span>` },
          { key: 'item_name', label: 'DESCRIPTION', render: (r) => `${esc(r.item_name)} <span class="muted small mono">${esc(r.sku)}</span>` },
          { key: 'qty', label: 'QTY', className: 'num', render: (r) => `<b>${fmtInt(r.qty)}</b> <span class="muted small">${esc(r.unit)}</span>` },
          { key: 'supplier_name', label: 'ผู้ขาย', render: (r) => esc(r.supplier_name || '—') },
          { key: 'doc_no', label: 'เอกสาร', render: (r) => `<span class="mono small">${esc(r.doc_no)}</span>` },
        ], { emptyText: 'ไม่มีการรับเข้าในเดือนนี้' })}
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3>OUT — เบิกอุปกรณ์ออก (${esc(MONTH_FULL[s.month - 1])} ${s.year})</h3></div>
      <div class="card-body tight">
        ${table(d.outbound, [
          { key: 'date', label: 'Date', className: 'nowrap', render: (r) => fmtDate(r.date) },
          { key: 'warehouse_code', label: 'คลัง', render: (r) => `<span class="badge tone-info">${esc(r.warehouse_code)}</span>` },
          { key: 'name_dept', label: 'Name - Dept.', render: (r) => `<b>${esc(r.name_dept)}</b>` },
          { key: 'desktop', label: 'Desktop', render: (r) => cellList(r.desktop) },
          { key: 'laptop', label: 'Laptop', render: (r) => cellList(r.laptop) },
          { key: 'accessories', label: 'Accessories', render: (r) => cellList(r.accessories) },
          { key: 'is_staff_name', label: 'IS', render: (r) => esc(r.is_staff_name || '—') },
          { key: 'charge_label', label: 'Charge', className: 'center', render: (r) =>
            `<span class="badge ${r.charge ? 'pill-y' : 'pill-n'}">${r.charge_label}</span>` },
          { key: 'remark', label: 'Remark', render: (r) => `<span class="small">${esc(r.remark || '')}</span>` },
        ], { emptyText: 'ไม่มีการเบิกออกในเดือนนี้' })}
      </div>
    </div>`;
}

/* ---------------- รายงานอื่น ๆ ---------------- */

const barCell = (v, max) =>
  `<div class="bar-track"><div class="bar-fill" style="width:${max ? (v / max) * 100 : 0}%"></div></div>`;

function departmentView(d) {
  const max = Math.max(...d.data.map((r) => r.total_qty), 1);
  return card(`สรุปการเบิกตามแผนก (${fmtDate(d.from)} – ${fmtDate(d.to)})`, table(d.data, [
    { key: 'department_name', label: 'แผนก', render: (r) => `<b>${esc(r.department_name)}</b>` },
    { key: 'doc_count', label: 'จำนวนใบเบิก', className: 'num', render: (r) => fmtInt(r.doc_count) },
    { key: 'total_qty', label: 'จำนวนชิ้น', className: 'num', render: (r) => `<b>${fmtInt(r.total_qty)}</b>` },
    { key: 'charged_qty', label: 'Charge Y', className: 'num', render: (r) => fmtInt(r.charged_qty) },
    { key: 'free_qty', label: 'Charge N', className: 'num', render: (r) => fmtInt(r.free_qty) },
    { key: 'total_value', label: 'มูลค่า', className: 'num', render: (r) => `฿${fmtMoney(r.total_value)}` },
    { key: 'bar', label: '', render: (r) => barCell(r.total_qty, max) },
  ], { emptyText: 'ไม่มีการเบิกในช่วงเวลานี้' }));
}

function categoryView(d) {
  const max = Math.max(...d.data.map((r) => r.balance), 1);
  return card(`สรุปตามหมวดหมู่ (${fmtDate(d.from)} – ${fmtDate(d.to)})`, table(d.data, [
    { key: 'category_name', label: 'หมวดหมู่', render: (r) => `<b>${esc(r.category_name)}</b>` },
    { key: 'qty_in', label: 'รับเข้าในช่วง', className: 'num', render: (r) => fmtInt(r.qty_in) },
    { key: 'qty_out', label: 'จ่ายออกในช่วง', className: 'num', render: (r) => fmtInt(r.qty_out) },
    { key: 'balance', label: 'คงเหลือปัจจุบัน', className: 'num', render: (r) => `<b>${fmtInt(r.balance)}</b>` },
    { key: 'value', label: 'มูลค่าคงเหลือ', className: 'num', render: (r) => `฿${fmtMoney(r.value)}` },
    { key: 'bar', label: '', render: (r) => barCell(r.balance, max) },
  ], { emptyText: 'ยังไม่มีข้อมูล' }));
}

function topView(d) {
  const max = Math.max(...d.data.map((r) => r.total_qty), 1);
  return card(`อุปกรณ์ที่ถูกเบิกมากที่สุด (${fmtDate(d.from)} – ${fmtDate(d.to)})`, table(d.data, [
    { key: 'rank', label: '#', className: 'num', render: (r) => `${d.data.indexOf(r) + 1}` },
    { key: 'name', label: 'อุปกรณ์', render: (r) => `<b>${esc(r.name)}</b><div class="muted small mono">${esc(r.sku)}</div>` },
    { key: 'category_name', label: 'หมวดหมู่' },
    { key: 'doc_count', label: 'ครั้งที่เบิก', className: 'num', render: (r) => fmtInt(r.doc_count) },
    { key: 'total_qty', label: 'จำนวนรวม', className: 'num', render: (r) => `<b>${fmtInt(r.total_qty)}</b> <span class="muted small">${esc(r.unit)}</span>` },
    { key: 'total_value', label: 'มูลค่า', className: 'num', render: (r) => `฿${fmtMoney(r.total_value)}` },
    { key: 'bar', label: '', render: (r) => barCell(r.total_qty, max) },
  ], { emptyText: 'ไม่มีการเบิกในช่วงเวลานี้' }));
}

function assetsView(d) {
  return card('ทรัพย์สินที่พนักงานถือครองอยู่ในปัจจุบัน', table(d.data, [
    { key: 'emp_code', label: 'รหัสพนักงาน', render: (r) => `<span class="mono">${esc(r.emp_code)}</span>` },
    { key: 'employee_name', label: 'ชื่อพนักงาน', render: (r) => `<b>${esc(r.employee_name)}</b>` },
    { key: 'department_name', label: 'แผนก', render: (r) => esc(r.department_name || '—') },
    { key: 'asset_count', label: 'จำนวน', className: 'num', render: (r) => `<span class="badge tone-primary">${fmtInt(r.asset_count)}</span>` },
    { key: 'assets', label: 'รายการทรัพย์สิน', render: (r) =>
      (r.assets || '').split(' | ').map((a) => `<div class="small">${esc(a)}</div>`).join('') },
  ], { emptyText: 'ยังไม่มีทรัพย์สินที่ถูกเบิกออกไป' }));
}

function chargeView(d) {
  const totalCharge = d.data.reduce((a, r) => a + r.charge_value, 0);
  const totalFree = d.data.reduce((a, r) => a + r.free_value, 0);
  return `
    <div class="grid cols-2" style="margin-bottom:16px">
      <div class="stat"><div class="icon tone-success">💵</div><div>
        <div class="label">มูลค่าที่ต้องเรียกเก็บ (Charge = Y)</div>
        <div class="value">฿${fmtMoney(totalCharge)}</div></div></div>
      <div class="stat"><div class="icon tone-info">🆓</div><div>
        <div class="label">มูลค่าที่ไม่เรียกเก็บ (Charge = N)</div>
        <div class="value">฿${fmtMoney(totalFree)}</div></div></div>
    </div>
    ${card(`สรุปค่าใช้จ่ายตามแผนก (${fmtDate(d.from)} – ${fmtDate(d.to)})`, table(d.data, [
      { key: 'department_name', label: 'แผนก', render: (r) => `<b>${esc(r.department_name)}</b>` },
      { key: 'charge_qty', label: 'ชิ้น (Y)', className: 'num', render: (r) => fmtInt(r.charge_qty) },
      { key: 'charge_value', label: 'มูลค่าที่เรียกเก็บ', className: 'num', render: (r) => `<b>฿${fmtMoney(r.charge_value)}</b>` },
      { key: 'free_qty', label: 'ชิ้น (N)', className: 'num', render: (r) => fmtInt(r.free_qty) },
      { key: 'free_value', label: 'มูลค่าที่ไม่เรียกเก็บ', className: 'num', render: (r) => `฿${fmtMoney(r.free_value)}` },
    ], { emptyText: 'ไม่มีข้อมูลในช่วงเวลานี้' }))}`;
}

const ACTION_LABEL = { create: 'เพิ่มข้อมูล', update: 'แก้ไข', delete: 'ลบ', post: 'บันทึกเอกสาร', void: 'ยกเลิกเอกสาร', login: 'เข้าสู่ระบบ', 'change-password': 'เปลี่ยนรหัสผ่าน' };

function auditView(d) {
  return card('บันทึกการใช้งานระบบ', table(d.data, [
    { key: 'created_at', label: 'เวลา', className: 'nowrap', render: (r) => `<span class="small">${esc(String(r.created_at).replace('T', ' '))}</span>` },
    { key: 'username', label: 'ผู้ใช้', render: (r) => `<b>${esc(r.username || '—')}</b>` },
    { key: 'action', label: 'การกระทำ', render: (r) => `<span class="badge badge-gray">${esc(ACTION_LABEL[r.action] || r.action)}</span>` },
    { key: 'entity', label: 'ส่วนงาน', render: (r) => `<span class="mono small">${esc(r.entity)}${r.entity_id ? `#${r.entity_id}` : ''}</span>` },
    { key: 'detail', label: 'รายละเอียด', render: (r) => esc(r.detail || '') },
  ], { emptyText: 'ยังไม่มีบันทึกการใช้งาน' }));
}

const card = (title, body) =>
  `<div class="card"><div class="card-head"><h3>${esc(title)}</h3></div><div class="card-body tight">${body}</div></div>`;
