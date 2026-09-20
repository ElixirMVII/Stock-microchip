import { api } from '../api.js';
import { lookup, can, refreshLowBadge, state, whParam, whLabel } from '../app.js';
import {
  esc, fmtInt, fmtMoney, fmtDate, fmtDateTime, table, pager, options, modal,
  toast, confirmDialog, kv, statusBadge, loading, today,
} from '../ui.js';
import { lineEditor } from './lines.js';

/* ============================================================
 *  หน้าจอเอกสารทั้ง 4 ประเภท
 * ============================================================ */

/** ช่องเลือกคลังในฟอร์มเอกสาร — ตั้งค่าเริ่มต้นเป็นคลังที่กำลังดูอยู่ */
function warehouseField(label = 'คลัง', name = 'warehouse_id') {
  const list = state.warehouses;
  const preset = state.warehouseId || (list.length === 1 ? list[0].id : '');
  return `
    <div class="field">
      <label>${esc(label)} <span class="req">*</span></label>
      <select name="${name}" required>
        ${options(list, { empty: '— เลือกคลัง —', selected: preset, label: (w) => `${w.code} — ${w.name}` })}
      </select>
    </div>`;
}

/** แถบค้นหา/กรองที่ใช้ร่วมกัน */
function toolbar({ searchPlaceholder, extra = '', createLabel }) {
  return `
    <div class="toolbar">
      <input id="q" placeholder="🔍 ${esc(searchPlaceholder)}" style="min-width:250px">
      <div class="fixed"><label class="small muted">ตั้งแต่</label><input type="date" id="from"></div>
      <div class="fixed"><label class="small muted">ถึง</label><input type="date" id="to"></div>
      <select id="status">
        <option value="posted">เฉพาะที่ใช้งาน</option>
        <option value="">รวมที่ยกเลิกแล้ว</option>
        <option value="void">เฉพาะที่ยกเลิก</option>
      </select>
      ${extra}
      <div class="spacer"></div>
      <span class="badge tone-primary">กำลังดู: ${esc(whLabel())}</span>
      ${can('officer') ? `<button class="btn btn-primary" id="create">+ ${esc(createLabel)}</button>` : ''}
    </div>
    <div class="card"><div class="card-body tight" id="list">${loading()}</div></div>`;
}

/** ผูก event ของแถบค้นหาเข้ากับฟังก์ชันโหลดข้อมูล */
function bindToolbar(view, q, load, onCreate) {
  let timer;
  view.querySelector('#q').addEventListener('input', (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => { q.q = e.target.value; q.page = 1; load(); }, 280);
  });
  for (const [id, key] of [['from', 'from'], ['to', 'to'], ['status', 'status']]) {
    view.querySelector(`#${id}`)?.addEventListener('change', (e) => { q[key] = e.target.value; q.page = 1; load(); });
  }
  view.querySelector('#create')?.addEventListener('click', onCreate);
  view.addEventListener('click', (e) => {
    const p = e.target.closest('[data-page]');
    if (p) { q.page = Number(p.dataset.page); load(); }
  });
}

/** ยกเลิกเอกสาร */
async function voidDoc(kind, id, docNo, reload) {
  const reason = await confirmDialog({
    title: `ยกเลิกเอกสาร ${docNo}`,
    message: 'ระบบจะกลับรายการเคลื่อนไหวสต็อกทั้งหมดของเอกสารนี้ และไม่สามารถย้อนคืนได้',
    confirmText: 'ยืนยันการยกเลิก',
    needReason: true,
  });
  if (reason === null) return;
  try {
    await api.post(`/${kind}/${id}/void`, { reason });
    toast(`ยกเลิกเอกสาร ${docNo} เรียบร้อยแล้ว`);
    await reload();
    refreshLowBadge();
  } catch (err) {
    toast(err.message, 'err');
  }
}

/* ---------------- 📥 รับอุปกรณ์เข้า ---------------- */

export async function renderReceipts(view) {
  const q = { q: '', from: '', to: '', status: 'posted', page: 1, per_page: 30 };

  view.innerHTML = toolbar({
    searchPlaceholder: 'ค้นหาเลขที่เอกสาร, เลข PO หรือผู้ขาย',
    createLabel: 'รับอุปกรณ์เข้า',
  });

  const load = async () => {
    const box = view.querySelector('#list');
    box.innerHTML = loading();
    const res = await api.get(`/receipts${api.qs({ ...q, ...whParam() })}`);
    box.innerHTML = table(res.data, [
      { key: 'doc_no', label: 'เลขที่เอกสาร', render: (r) => `<b class="mono">${esc(r.doc_no)}</b>` },
      { key: 'receive_date', label: 'วันที่รับ', className: 'nowrap', render: (r) => fmtDate(r.receive_date) },
      { key: 'warehouse_code', label: 'คลัง', render: (r) => `<span class="badge tone-info">${esc(r.warehouse_code)}</span>` },
      { key: 'po_no', label: 'เลขที่ PO', render: (r) => r.po_no ? `<span class="mono">${esc(r.po_no)}</span>` : '<span class="muted">—</span>' },
      { key: 'supplier_name', label: 'ผู้ขาย', render: (r) => esc(r.supplier_name || '—') },
      { key: 'line_count', label: 'รายการ', className: 'num', render: (r) => fmtInt(r.line_count) },
      { key: 'total_qty', label: 'จำนวนรวม', className: 'num', render: (r) => `<b>${fmtInt(r.total_qty)}</b>` },
      { key: 'total_cost', label: 'มูลค่า', className: 'num', render: (r) => `฿${fmtMoney(r.total_cost)}` },
      { key: 'status', label: 'สถานะ', render: (r) => statusBadge(r.status) },
      { key: 'act', label: '', className: 'nowrap', render: (r) => `<button class="btn btn-sm" data-view="${r.id}">ดู</button>` },
    ], { emptyText: 'ยังไม่มีเอกสารรับเข้า', rowClass: (r) => r.status === 'void' ? 'is-void' : '' }) + pager(res);
  };

  bindToolbar(view, q, load, () => receiptForm(load));
  view.addEventListener('click', (e) => {
    const v = e.target.closest('[data-view]');
    if (v) receiptDetail(Number(v.dataset.view), load);
  });
  await load();
}

async function receiptForm(reload) {
  const [items, suppliers] = await Promise.all([lookup('items'), lookup('suppliers')]);
  const editor = lineEditor('receipt', items);

  modal({
    title: '📥 รับอุปกรณ์เข้าคลัง',
    wide: true,
    body: `
      <div class="inline" style="margin-bottom:14px">
        ${warehouseField('คลังที่รับเข้า')}
        <div class="field"><label>วันที่รับเข้า <span class="req">*</span></label>
          <input name="receive_date" type="date" value="${today()}" required></div>
        <div class="field"><label>เลขที่ PO</label>
          <input name="po_no" placeholder="เช่น 22001999" autocomplete="off"></div>
        <div class="field"><label>ผู้ขาย</label>
          <select name="supplier_id">${options(suppliers, { empty: '— ไม่ระบุ —' })}</select></div>
      </div>
      <div class="field"><label>หมายเหตุ</label><input name="note" placeholder="รายละเอียดเพิ่มเติม"></div>
      ${editor.html}`,
    footer: `<button type="button" class="btn" data-close>ยกเลิก</button>
             <button type="submit" class="btn btn-primary">บันทึกรับเข้า</button>`,
    onMount: (root) => { root._lines = editor.mount(root); },
    onSubmit: async (data, { close, root }) => {
      const payload = { ...data, lines: root._lines.collect() };
      const res = await api.post('/receipts', payload);
      close();
      toast(`บันทึกใบรับเข้า ${res.doc_no} เรียบร้อยแล้ว`);
      await reload();
      refreshLowBadge();
    },
  });
}

async function receiptDetail(id, reload) {
  const m = modal({ title: 'รายละเอียดใบรับเข้า', wide: true, body: loading(), footer: '<div class="spacer"></div><button type="button" class="btn" data-close>ปิด</button>' });
  const d = await api.get(`/receipts/${id}`);
  m.root.querySelector('.modal-body').innerHTML = `
    <div class="grid cols-2" style="margin-bottom:16px">
      ${kv([
        ['เลขที่เอกสาร', `<b class="mono">${esc(d.doc_no)}</b>`],
        ['วันที่รับเข้า', fmtDate(d.receive_date)],
        ['คลัง', `<span class="badge tone-info">${esc(d.warehouse_code)}</span> ${esc(d.warehouse_name || '')}`],
        ['เลขที่ PO', esc(d.po_no || '—')],
        ['ผู้ขาย', esc(d.supplier_name || '—')],
      ])}
      ${kv([
        ['สถานะ', statusBadge(d.status)],
        ['ผู้บันทึก', esc(d.created_by_name || '—')],
        ['บันทึกเมื่อ', fmtDateTime(d.created_at)],
        ...(d.status === 'void' ? [['เหตุผลที่ยกเลิก', esc(d.void_reason || '—')]] : []),
        ['หมายเหตุ', esc(d.note || '—')],
      ])}
    </div>
    ${table(d.lines, [
      { key: 'sku', label: 'รหัส', render: (r) => `<span class="mono">${esc(r.sku)}</span>` },
      { key: 'item_name', label: 'อุปกรณ์', render: (r) => `${esc(r.item_name)}${r.serial_list ? `<div class="muted small mono">${esc(r.serial_list)}</div>` : ''}` },
      { key: 'category_name', label: 'หมวดหมู่' },
      { key: 'qty', label: 'จำนวน', className: 'num', render: (r) => `<b>${fmtInt(r.qty)}</b> <span class="muted small">${esc(r.unit)}</span>` },
      { key: 'unit_cost', label: 'ราคา/หน่วย', className: 'num', render: (r) => `฿${fmtMoney(r.unit_cost)}` },
      { key: 'total', label: 'รวม', className: 'num', render: (r) => `฿${fmtMoney(r.qty * r.unit_cost)}` },
      { key: 'note', label: 'หมายเหตุ', render: (r) => `<span class="muted small">${esc(r.note || '')}</span>` },
    ])}`;

  if (d.status === 'posted' && can('officer')) {
    const foot = m.root.querySelector('.modal-foot');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-danger';
    btn.textContent = 'ยกเลิกเอกสารนี้';
    btn.addEventListener('click', async () => { m.close(); await voidDoc('receipts', d.id, d.doc_no, reload); });
    foot.prepend(btn);
  }
}

/* ---------------- 📤 เบิกอุปกรณ์ออก ---------------- */

export async function renderIssues(view) {
  const q = { q: '', from: '', to: '', status: 'posted', charge: '', page: 1, per_page: 30 };

  view.innerHTML = toolbar({
    searchPlaceholder: 'ค้นหาเลขที่เอกสาร, ชื่อหรือรหัสพนักงาน',
    createLabel: 'เบิกอุปกรณ์ออก',
    extra: `<select id="charge">
      <option value="">Charge ทั้งหมด</option>
      <option value="1">เฉพาะ Charge = Y</option>
      <option value="0">เฉพาะ Charge = N</option>
    </select>`,
  });

  const load = async () => {
    const box = view.querySelector('#list');
    box.innerHTML = loading();
    const res = await api.get(`/issues${api.qs({ ...q, ...whParam() })}`);
    box.innerHTML = table(res.data, [
      { key: 'doc_no', label: 'เลขที่เอกสาร', render: (r) => `<b class="mono">${esc(r.doc_no)}</b>` },
      { key: 'issue_date', label: 'วันที่เบิก', className: 'nowrap', render: (r) => fmtDate(r.issue_date) },
      { key: 'warehouse_code', label: 'คลัง', render: (r) => `<span class="badge tone-info">${esc(r.warehouse_code)}</span>` },
      { key: 'employee_name', label: 'ผู้เบิก (Name - Dept.)', render: (r) =>
        `<b>${esc(r.emp_code)} - ${esc(r.employee_name)}</b>${r.department_name ? `<div class="muted small">${esc(r.department_name)}</div>` : ''}` },
      { key: 'line_count', label: 'รายการ', className: 'num', render: (r) => fmtInt(r.line_count) },
      { key: 'total_qty', label: 'จำนวน', className: 'num', render: (r) => `<b>${fmtInt(r.total_qty)}</b>` },
      { key: 'is_staff_name', label: 'IS', render: (r) => esc(r.is_staff_name || '—') },
      { key: 'charge', label: 'Charge', className: 'center', render: (r) =>
        `<span class="badge ${r.charge ? 'pill-y' : 'pill-n'}">${r.charge ? 'Y' : 'N'}</span>` },
      { key: 'remark', label: 'หมายเหตุ', render: (r) => `<span class="muted small">${esc(r.remark || '')}</span>` },
      { key: 'status', label: 'สถานะ', render: (r) => statusBadge(r.status) },
      { key: 'act', label: '', className: 'nowrap', render: (r) => `<button class="btn btn-sm" data-view="${r.id}">ดู</button>` },
    ], { emptyText: 'ยังไม่มีเอกสารเบิกออก', rowClass: (r) => r.status === 'void' ? 'is-void' : '' }) + pager(res);
  };

  bindToolbar(view, q, load, () => issueForm(load));
  view.querySelector('#charge').addEventListener('change', (e) => { q.charge = e.target.value; q.page = 1; load(); });
  view.addEventListener('click', (e) => {
    const v = e.target.closest('[data-view]');
    if (v) issueDetail(Number(v.dataset.view), load);
  });
  await load();
}

async function issueForm(reload) {
  const [items, employees, staff] = await Promise.all([lookup('items'), lookup('employees'), lookup('isStaff')]);
  const editor = lineEditor('issue', items);

  modal({
    title: '📤 เบิกอุปกรณ์ออก',
    wide: true,
    body: `
      <div class="inline" style="margin-bottom:12px">
        ${warehouseField('เบิกจากคลัง')}
        <div class="field"><label>วันที่เบิก <span class="req">*</span></label>
          <input name="issue_date" type="date" value="${today()}" required></div>
        <div class="field" style="flex:2"><label>ผู้เบิก (Name - Dept.) <span class="req">*</span></label>
          <select name="employee_id" required>${options(employees, {
            empty: '— เลือกพนักงาน —',
            label: (r) => `${r.emp_code} - ${r.name}${r.department_name ? ` / ${r.department_name}` : ''}`,
          })}</select></div>
        <div class="field"><label>เจ้าหน้าที่ IS</label>
          <select name="is_staff_id">${options(staff, { empty: '— ไม่ระบุ —' })}</select></div>
      </div>
      <div class="inline" style="margin-bottom:14px">
        <div class="field" style="flex:3"><label>หมายเหตุ (Remark)</label>
          <input name="remark" placeholder="เช่น Use old laptop B78470 - Thanarak W. / Eng. MFG"></div>
        <div class="field fixed" style="min-width:150px"><label>คิดค่าใช้จ่าย (Charge)</label>
          <label class="check-row" style="height:36px"><input type="checkbox" name="charge" checked> ใช่ (Y)</label></div>
      </div>
      ${editor.html}`,
    footer: `<button type="button" class="btn" data-close>ยกเลิก</button>
             <button type="submit" class="btn btn-primary">บันทึกการเบิก</button>`,
    onMount: (root) => {
      // ผูกช่องเลือกคลังเข้ากับตัวแก้ไขรายการ เพื่อให้เลือกได้เฉพาะ Serial ที่อยู่ในคลังนั้นจริง
      root._lines = editor.mount(root, { warehouseSelect: root.querySelector('[name="warehouse_id"]') });
    },
    onSubmit: async (data, { close, root }) => {
      const payload = { ...data, lines: root._lines.collect() };
      const res = await api.post('/issues', payload);
      close();
      toast(`บันทึกใบเบิก ${res.doc_no} เรียบร้อยแล้ว`);
      await reload();
      refreshLowBadge();
    },
  });
}

async function issueDetail(id, reload) {
  const m = modal({ title: 'รายละเอียดใบเบิก', wide: true, body: loading(), footer: '<div class="spacer"></div><button type="button" class="btn" data-close>ปิด</button>' });
  const d = await api.get(`/issues/${id}`);
  m.root.querySelector('.modal-body').innerHTML = `
    <div class="grid cols-2" style="margin-bottom:16px">
      ${kv([
        ['เลขที่เอกสาร', `<b class="mono">${esc(d.doc_no)}</b>`],
        ['วันที่เบิก', fmtDate(d.issue_date)],
        ['คลัง', `<span class="badge tone-info">${esc(d.warehouse_code)}</span> ${esc(d.warehouse_name || '')}`],
        ['ผู้เบิก', `${esc(d.emp_code)} - ${esc(d.employee_name)}`],
        ['แผนก', esc(d.department_name || '—')],
      ])}
      ${kv([
        ['เจ้าหน้าที่ IS', esc(d.is_staff_name || '—')],
        ['Charge', `<span class="badge ${d.charge ? 'pill-y' : 'pill-n'}">${d.charge ? 'Y' : 'N'}</span>`],
        ['สถานะ', statusBadge(d.status)],
        ['ผู้บันทึก', `${esc(d.created_by_name || '—')} · ${fmtDateTime(d.created_at)}`],
        ...(d.status === 'void' ? [['เหตุผลที่ยกเลิก', esc(d.void_reason || '—')]] : []),
        ['หมายเหตุ', esc(d.remark || '—')],
      ])}
    </div>
    ${table(d.lines, [
      { key: 'sku', label: 'รหัส', render: (r) => `<span class="mono">${esc(r.sku)}</span>` },
      { key: 'item_name', label: 'อุปกรณ์', render: (r) => `${esc(r.item_name)}${r.serial_list ? `<div class="muted small mono">${esc(r.serial_list)}</div>` : ''}` },
      { key: 'category_name', label: 'หมวดหมู่' },
      { key: 'qty', label: 'จำนวน', className: 'num', render: (r) => `<b>${fmtInt(r.qty)}</b> <span class="muted small">${esc(r.unit)}</span>` },
      { key: 'note', label: 'หมายเหตุ', render: (r) => `<span class="muted small">${esc(r.note || '')}</span>` },
    ])}`;

  if (d.status === 'posted' && can('officer')) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-danger';
    btn.textContent = 'ยกเลิกเอกสารนี้';
    btn.addEventListener('click', async () => { m.close(); await voidDoc('issues', d.id, d.doc_no, reload); });
    m.root.querySelector('.modal-foot').prepend(btn);
  }
}

/* ---------------- ↩️ รับคืนอุปกรณ์ ---------------- */

export async function renderReturns(view) {
  const q = { q: '', from: '', to: '', status: 'posted', page: 1, per_page: 30 };
  view.innerHTML = toolbar({ searchPlaceholder: 'ค้นหาเลขที่เอกสารหรือชื่อผู้คืน', createLabel: 'รับคืนอุปกรณ์' });

  const load = async () => {
    const box = view.querySelector('#list');
    box.innerHTML = loading();
    const res = await api.get(`/returns${api.qs({ ...q, ...whParam() })}`);
    box.innerHTML = table(res.data, [
      { key: 'doc_no', label: 'เลขที่เอกสาร', render: (r) => `<b class="mono">${esc(r.doc_no)}</b>` },
      { key: 'return_date', label: 'วันที่คืน', className: 'nowrap', render: (r) => fmtDate(r.return_date) },
      { key: 'warehouse_code', label: 'คลัง', render: (r) => `<span class="badge tone-info">${esc(r.warehouse_code)}</span>` },
      { key: 'employee_name', label: 'ผู้คืน', render: (r) =>
        `<b>${esc(r.emp_code)} - ${esc(r.employee_name)}</b>${r.department_name ? `<div class="muted small">${esc(r.department_name)}</div>` : ''}` },
      { key: 'line_count', label: 'รายการ', className: 'num', render: (r) => fmtInt(r.line_count) },
      { key: 'total_qty', label: 'จำนวน', className: 'num', render: (r) => `<b>${fmtInt(r.total_qty)}</b>` },
      { key: 'is_staff_name', label: 'ผู้รับคืน', render: (r) => esc(r.is_staff_name || '—') },
      { key: 'note', label: 'หมายเหตุ', render: (r) => `<span class="muted small">${esc(r.note || '')}</span>` },
      { key: 'status', label: 'สถานะ', render: (r) => statusBadge(r.status) },
      { key: 'act', label: '', className: 'nowrap', render: (r) => `<button class="btn btn-sm" data-view="${r.id}">ดู</button>` },
    ], { emptyText: 'ยังไม่มีเอกสารรับคืน', rowClass: (r) => r.status === 'void' ? 'is-void' : '' }) + pager(res);
  };

  bindToolbar(view, q, load, () => returnForm(load));
  view.addEventListener('click', (e) => {
    const v = e.target.closest('[data-view]');
    if (v) returnDetail(Number(v.dataset.view), load);
  });
  await load();
}

async function returnForm(reload) {
  const [items, employees, staff] = await Promise.all([lookup('items'), lookup('employees'), lookup('isStaff')]);
  const editor = lineEditor('return', items);

  modal({
    title: '↩️ รับคืนอุปกรณ์',
    wide: true,
    body: `
      <div class="inline" style="margin-bottom:14px">
        ${warehouseField('คืนเข้าคลัง')}
        <div class="field"><label>วันที่รับคืน <span class="req">*</span></label>
          <input name="return_date" type="date" value="${today()}" required></div>
        <div class="field" style="flex:2"><label>ผู้คืน <span class="req">*</span></label>
          <select name="employee_id" id="ret-emp" required>${options(employees, {
            empty: '— เลือกพนักงาน —',
            label: (r) => `${r.emp_code} - ${r.name}${r.department_name ? ` / ${r.department_name}` : ''}`,
          })}</select>
          <div class="help">เลือกผู้คืนก่อน ระบบจะกรอง Serial ที่บุคคลนั้นถือครองให้</div></div>
        <div class="field"><label>เจ้าหน้าที่ผู้รับคืน</label>
          <select name="is_staff_id">${options(staff, { empty: '— ไม่ระบุ —' })}</select></div>
      </div>
      <div class="field"><label>หมายเหตุ</label><input name="note" placeholder="เช่น คืนเนื่องจากลาออก"></div>
      ${editor.html}`,
    footer: `<button type="button" class="btn" data-close>ยกเลิก</button>
             <button type="submit" class="btn btn-primary">บันทึกการรับคืน</button>`,
    onMount: (root) => {
      root._lines = editor.mount(root, {
        employeeSelect: root.querySelector('#ret-emp'),
        // รับคืนข้ามคลังได้ จึงไม่กรองตามคลัง แต่ส่งไปเพื่อรีเฟรชรายการเมื่อเปลี่ยนค่า
        warehouseSelect: root.querySelector('[name="warehouse_id"]'),
      });
    },
    onSubmit: async (data, { close, root }) => {
      const payload = { ...data, lines: root._lines.collect() };
      const res = await api.post('/returns', payload);
      close();
      toast(`บันทึกใบรับคืน ${res.doc_no} เรียบร้อยแล้ว`);
      await reload();
      refreshLowBadge();
    },
  });
}

async function returnDetail(id, reload) {
  const m = modal({ title: 'รายละเอียดใบรับคืน', wide: true, body: loading(), footer: '<div class="spacer"></div><button type="button" class="btn" data-close>ปิด</button>' });
  const d = await api.get(`/returns/${id}`);
  m.root.querySelector('.modal-body').innerHTML = `
    <div class="grid cols-2" style="margin-bottom:16px">
      ${kv([
        ['เลขที่เอกสาร', `<b class="mono">${esc(d.doc_no)}</b>`],
        ['วันที่รับคืน', fmtDate(d.return_date)],
        ['คลัง', `<span class="badge tone-info">${esc(d.warehouse_code)}</span> ${esc(d.warehouse_name || '')}`],
        ['ผู้คืน', `${esc(d.emp_code)} - ${esc(d.employee_name)}`],
        ['แผนก', esc(d.department_name || '—')],
      ])}
      ${kv([
        ['ผู้รับคืน', esc(d.is_staff_name || '—')],
        ['สถานะ', statusBadge(d.status)],
        ['ผู้บันทึก', `${esc(d.created_by_name || '—')} · ${fmtDateTime(d.created_at)}`],
        ...(d.status === 'void' ? [['เหตุผลที่ยกเลิก', esc(d.void_reason || '—')]] : []),
        ['หมายเหตุ', esc(d.note || '—')],
      ])}
    </div>
    ${table(d.lines, [
      { key: 'sku', label: 'รหัส', render: (r) => `<span class="mono">${esc(r.sku)}</span>` },
      { key: 'item_name', label: 'อุปกรณ์', render: (r) => `${esc(r.item_name)}${r.serial_list ? `<div class="muted small mono">${esc(r.serial_list)}</div>` : ''}` },
      { key: 'qty', label: 'จำนวน', className: 'num', render: (r) => `<b>${fmtInt(r.qty)}</b> <span class="muted small">${esc(r.unit)}</span>` },
      { key: 'condition', label: 'สภาพ', render: (r) => r.condition === 'scrap'
        ? '<span class="badge tone-danger">ชำรุด (ตัดจำหน่าย)</span>'
        : '<span class="badge tone-success">ใช้งานได้ (เข้าคลัง)</span>' },
      { key: 'note', label: 'หมายเหตุ', render: (r) => `<span class="muted small">${esc(r.note || '')}</span>` },
    ])}`;

  if (d.status === 'posted' && can('officer')) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-danger';
    btn.textContent = 'ยกเลิกเอกสารนี้';
    btn.addEventListener('click', async () => { m.close(); await voidDoc('returns', d.id, d.doc_no, reload); });
    m.root.querySelector('.modal-foot').prepend(btn);
  }
}

/* ---------------- ⚖️ ปรับปรุงสต็อก ---------------- */

const ADJ_REASON = { count: 'ผลการตรวจนับ', damaged: 'ชำรุด', lost: 'สูญหาย', found: 'พบเพิ่ม', other: 'อื่น ๆ' };

export async function renderAdjustments(view) {
  const q = { q: '', from: '', to: '', status: 'posted', page: 1, per_page: 30 };
  view.innerHTML = toolbar({ searchPlaceholder: 'ค้นหาเลขที่เอกสารหรือหมายเหตุ', createLabel: 'ปรับปรุงสต็อก' });

  const load = async () => {
    const box = view.querySelector('#list');
    box.innerHTML = loading();
    const res = await api.get(`/adjustments${api.qs({ ...q, ...whParam() })}`);
    box.innerHTML = table(res.data, [
      { key: 'doc_no', label: 'เลขที่เอกสาร', render: (r) => `<b class="mono">${esc(r.doc_no)}</b>` },
      { key: 'adjust_date', label: 'วันที่', className: 'nowrap', render: (r) => fmtDate(r.adjust_date) },
      { key: 'warehouse_code', label: 'คลัง', render: (r) => `<span class="badge tone-info">${esc(r.warehouse_code)}</span>` },
      { key: 'reason', label: 'สาเหตุ', render: (r) => `<span class="badge badge-gray">${esc(ADJ_REASON[r.reason] || r.reason)}</span>` },
      { key: 'line_count', label: 'รายการ', className: 'num', render: (r) => fmtInt(r.line_count) },
      { key: 'net_qty', label: 'ปรับสุทธิ', className: 'num', render: (r) =>
        `<b style="color:${r.net_qty > 0 ? 'var(--success)' : 'var(--danger)'}">${r.net_qty > 0 ? '+' : ''}${fmtInt(r.net_qty)}</b>` },
      { key: 'note', label: 'หมายเหตุ', render: (r) => `<span class="muted small">${esc(r.note || '')}</span>` },
      { key: 'created_by_name', label: 'ผู้บันทึก', render: (r) => `<span class="muted small">${esc(r.created_by_name || '')}</span>` },
      { key: 'status', label: 'สถานะ', render: (r) => statusBadge(r.status) },
      { key: 'act', label: '', className: 'nowrap', render: (r) => `<button class="btn btn-sm" data-view="${r.id}">ดู</button>` },
    ], { emptyText: 'ยังไม่มีเอกสารปรับปรุงสต็อก', rowClass: (r) => r.status === 'void' ? 'is-void' : '' }) + pager(res);
  };

  bindToolbar(view, q, load, () => adjustmentForm(load));
  view.addEventListener('click', (e) => {
    const v = e.target.closest('[data-view]');
    if (v) adjustmentDetail(Number(v.dataset.view), load);
  });
  await load();
}

async function adjustmentForm(reload) {
  const items = (await lookup('items')).filter((i) => !i.track_serial);
  let balOf = new Map();
  let n = 0;

  // ยอดคงเหลือขึ้นกับคลังที่เลือก จึงต้องโหลดใหม่ทุกครั้งที่เปลี่ยนคลัง
  const loadBalances = async (warehouseId) => {
    const res = await api.get(`/stock/balance${api.qs({ per_page: 1000, warehouse_id: warehouseId || '' })}`);
    balOf = new Map(res.data.map((b) => [b.item_id, b.balance]));
  };

  modal({
    title: '⚖️ ปรับปรุงยอดสต็อก',
    wide: true,
    body: `
      <div class="inline" style="margin-bottom:14px">
        ${warehouseField('คลังที่ปรับปรุง')}
        <div class="field"><label>วันที่ปรับปรุง <span class="req">*</span></label>
          <input name="adjust_date" type="date" value="${today()}" required></div>
        <div class="field"><label>สาเหตุ <span class="req">*</span></label>
          <select name="reason">${Object.entries(ADJ_REASON).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select></div>
        <div class="field" style="flex:2"><label>หมายเหตุ</label>
          <input name="note" placeholder="เช่น ผลการตรวจนับประจำเดือน"></div>
      </div>
      <div class="help" style="margin-bottom:10px">
        ℹ️ ใส่ค่าบวกเพื่อเพิ่มจำนวน หรือค่าลบเพื่อลดจำนวน — อุปกรณ์ที่ติดตามด้วย Serial ต้องปรับผ่านใบรับเข้า/รับคืนแทน
      </div>
      <div class="card" style="margin:0">
        <div class="card-head"><h3>รายการที่ต้องการปรับ</h3><div class="spacer"></div>
          <button type="button" class="btn btn-sm btn-primary" data-add>+ เพิ่มรายการ</button></div>
        <div class="card-body tight"><div class="table-wrap"><table class="data line-table">
          <thead><tr><th style="min-width:230px">อุปกรณ์</th><th class="num" style="width:110px">คงเหลือ</th>
            <th class="num" style="width:120px">ปรับ (+/-)</th><th class="num" style="width:110px">ยอดใหม่</th>
            <th style="min-width:160px">หมายเหตุ</th><th style="width:44px"></th></tr></thead>
          <tbody data-lines></tbody>
        </table></div></div>
      </div>`,
    footer: `<button type="button" class="btn" data-close>ยกเลิก</button>
             <button type="submit" class="btn btn-primary">บันทึกการปรับปรุง</button>`,
    onMount: async (root) => {
      const tbody = root.querySelector('[data-lines]');
      const whSelect = root.querySelector('[name="warehouse_id"]');
      const itemOpts = options(items, { empty: '— เลือกอุปกรณ์ —', label: (r) => `${r.sku} — ${r.name}` });
      await loadBalances(whSelect.value);
      const addLine = () => {
        const tr = document.createElement('tr');
        tr.dataset.line = `a${++n}`;
        tr.innerHTML = `
          <td><select data-item>${itemOpts}</select></td>
          <td class="num"><span data-bal class="muted">—</span></td>
          <td class="num"><input data-diff type="number" step="1" value="0" style="text-align:right"></td>
          <td class="num"><b data-new>—</b></td>
          <td><input data-note placeholder="หมายเหตุ"></td>
          <td><button type="button" class="btn btn-ghost btn-icon" data-remove>✕</button></td>`;
        tbody.appendChild(tr);
      };
      const recalc = (tr) => {
        const id = Number(tr.querySelector('[data-item]').value);
        const bal = balOf.get(id);
        const diff = Number(tr.querySelector('[data-diff]').value || 0);
        tr.querySelector('[data-bal]').textContent = bal == null ? '—' : fmtInt(bal);
        const next = bal == null ? null : bal + diff;
        const cell = tr.querySelector('[data-new]');
        cell.textContent = next == null ? '—' : fmtInt(next);
        cell.style.color = next != null && next < 0 ? 'var(--danger)' : '';
      };
      tbody.addEventListener('change', (e) => { const tr = e.target.closest('[data-line]'); if (tr) recalc(tr); });
      tbody.addEventListener('input', (e) => { const tr = e.target.closest('[data-line]'); if (tr) recalc(tr); });
      tbody.addEventListener('click', (e) => { if (e.target.closest('[data-remove]')) e.target.closest('[data-line]').remove(); });
      root.querySelector('[data-add]').addEventListener('click', addLine);
      whSelect.addEventListener('change', async () => {
        await loadBalances(whSelect.value);
        tbody.querySelectorAll('[data-line]').forEach((tr) => recalc(tr));
      });
      addLine();

      root._collect = () => {
        const lines = [];
        for (const tr of tbody.querySelectorAll('[data-line]')) {
          const id = tr.querySelector('[data-item]').value;
          const diff = Number(tr.querySelector('[data-diff]').value || 0);
          if (!id || diff === 0) continue;
          lines.push({ item_id: Number(id), qty_diff: diff, note: tr.querySelector('[data-note]').value.trim() || null });
        }
        if (!lines.length) throw new Error('กรุณาระบุรายการที่ต้องการปรับอย่างน้อย 1 รายการ (จำนวนต้องไม่เป็น 0)');
        return lines;
      };
    },
    onSubmit: async (data, { close, root }) => {
      const res = await api.post('/adjustments', { ...data, lines: root._collect() });
      close();
      toast(`บันทึกใบปรับปรุง ${res.doc_no} เรียบร้อยแล้ว`);
      await reload();
      refreshLowBadge();
    },
  });
}

async function adjustmentDetail(id, reload) {
  const m = modal({ title: 'รายละเอียดใบปรับปรุง', wide: true, body: loading(), footer: '<div class="spacer"></div><button type="button" class="btn" data-close>ปิด</button>' });
  const d = await api.get(`/adjustments/${id}`);
  m.root.querySelector('.modal-body').innerHTML = `
    ${kv([
      ['เลขที่เอกสาร', `<b class="mono">${esc(d.doc_no)}</b>`],
      ['วันที่', fmtDate(d.adjust_date)],
      ['คลัง', `<span class="badge tone-info">${esc(d.warehouse_code)}</span> ${esc(d.warehouse_name || '')}`],
      ['สาเหตุ', esc(ADJ_REASON[d.reason] || d.reason)],
      ['สถานะ', statusBadge(d.status)],
      ['ผู้บันทึก', `${esc(d.created_by_name || '—')} · ${fmtDateTime(d.created_at)}`],
      ...(d.status === 'void' ? [['เหตุผลที่ยกเลิก', esc(d.void_reason || '—')]] : []),
      ['หมายเหตุ', esc(d.note || '—')],
    ])}
    <div style="margin-top:14px">${table(d.lines, [
      { key: 'sku', label: 'รหัส', render: (r) => `<span class="mono">${esc(r.sku)}</span>` },
      { key: 'item_name', label: 'อุปกรณ์' },
      { key: 'qty_diff', label: 'ปรับ', className: 'num', render: (r) =>
        `<b style="color:${r.qty_diff > 0 ? 'var(--success)' : 'var(--danger)'}">${r.qty_diff > 0 ? '+' : ''}${fmtInt(r.qty_diff)}</b> <span class="muted small">${esc(r.unit)}</span>` },
      { key: 'note', label: 'หมายเหตุ', render: (r) => `<span class="muted small">${esc(r.note || '')}</span>` },
    ])}</div>`;

  if (d.status === 'posted' && can('officer')) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-danger';
    btn.textContent = 'ยกเลิกเอกสารนี้';
    btn.addEventListener('click', async () => { m.close(); await voidDoc('adjustments', d.id, d.doc_no, reload); });
    m.root.querySelector('.modal-foot').prepend(btn);
  }
}

/* ---------------- 🔁 โอนย้ายระหว่างคลัง ---------------- */

export async function renderTransfers(view) {
  const q = { q: '', from: '', to: '', status: 'posted', page: 1, per_page: 30 };
  view.innerHTML = toolbar({ searchPlaceholder: 'ค้นหาเลขที่เอกสารหรือหมายเหตุ', createLabel: 'โอนย้ายระหว่างคลัง' });

  const load = async () => {
    const box = view.querySelector('#list');
    box.innerHTML = loading();
    const res = await api.get(`/transfers${api.qs({ ...q, ...whParam() })}`);
    box.innerHTML = table(res.data, [
      { key: 'doc_no', label: 'เลขที่เอกสาร', render: (r) => `<b class="mono">${esc(r.doc_no)}</b>` },
      { key: 'transfer_date', label: 'วันที่โอน', className: 'nowrap', render: (r) => fmtDate(r.transfer_date) },
      { key: 'route', label: 'เส้นทางการโอน', render: (r) => `
        <span class="badge badge-gray">${esc(r.from_code)}</span>
        <span style="margin:0 6px;color:var(--primary);font-weight:700">→</span>
        <span class="badge tone-info">${esc(r.to_code)}</span>` },
      { key: 'line_count', label: 'รายการ', className: 'num', render: (r) => fmtInt(r.line_count) },
      { key: 'total_qty', label: 'จำนวนที่โอน', className: 'num', render: (r) => `<b>${fmtInt(r.total_qty)}</b>` },
      { key: 'note', label: 'หมายเหตุ', render: (r) => `<span class="muted small">${esc(r.note || '')}</span>` },
      { key: 'created_by_name', label: 'ผู้บันทึก', render: (r) => `<span class="muted small">${esc(r.created_by_name || '')}</span>` },
      { key: 'status', label: 'สถานะ', render: (r) => statusBadge(r.status) },
      { key: 'act', label: '', className: 'nowrap', render: (r) => `<button class="btn btn-sm" data-view="${r.id}">ดู</button>` },
    ], { emptyText: 'ยังไม่มีการโอนย้ายระหว่างคลัง', rowClass: (r) => r.status === 'void' ? 'is-void' : '' }) + pager(res);
  };

  bindToolbar(view, q, load, () => transferForm(load));
  view.addEventListener('click', (e) => {
    const v = e.target.closest('[data-view]');
    if (v) transferDetail(Number(v.dataset.view), load);
  });
  await load();
}

async function transferForm(reload) {
  const items = await lookup('items');
  const warehouses = state.warehouses;
  if (warehouses.length < 2) {
    return toast('ต้องมีคลังอย่างน้อย 2 แห่งจึงจะโอนย้ายได้ — เพิ่มคลังได้ที่หน้าข้อมูลหลัก', 'warn');
  }
  const editor = lineEditor('transfer', items);
  const fromDefault = state.warehouseId || warehouses[0].id;
  const toDefault = warehouses.find((w) => String(w.id) !== String(fromDefault))?.id;

  modal({
    title: '🔁 โอนย้ายอุปกรณ์ระหว่างคลัง',
    wide: true,
    body: `
      <div class="inline" style="margin-bottom:14px">
        <div class="field"><label>วันที่โอนย้าย <span class="req">*</span></label>
          <input name="transfer_date" type="date" value="${today()}" required></div>
        <div class="field"><label>จากคลัง (ต้นทาง) <span class="req">*</span></label>
          <select name="from_warehouse_id" id="tr-from" required>
            ${options(warehouses, { selected: fromDefault, label: (w) => `${w.code} — ${w.name}` })}</select></div>
        <div class="field fixed" style="align-self:center;padding-top:18px;font-size:18px;color:var(--primary)">→</div>
        <div class="field"><label>ไปคลัง (ปลายทาง) <span class="req">*</span></label>
          <select name="to_warehouse_id" id="tr-to" required>
            ${options(warehouses, { selected: toDefault, label: (w) => `${w.code} — ${w.name}` })}</select></div>
      </div>
      <div class="field"><label>หมายเหตุ</label><input name="note" placeholder="เช่น เกลี่ยสต็อกให้คลังปลายทาง"></div>
      <div class="help" style="margin-bottom:10px">
        ℹ️ ระบบจะตัดยอดออกจากคลังต้นทางและเพิ่มเข้าคลังปลายทางในเอกสารเดียว — ยอดรวมทุกคลังไม่เปลี่ยนแปลง
      </div>
      ${editor.html}`,
    footer: `<button type="button" class="btn" data-close>ยกเลิก</button>
             <button type="submit" class="btn btn-primary">บันทึกการโอนย้าย</button>`,
    onMount: (root) => {
      const from = root.querySelector('#tr-from');
      const to = root.querySelector('#tr-to');
      // เลือกคลังต้นทาง/ปลายทางซ้ำกันไม่ได้ — สลับให้อัตโนมัติ
      const avoidSame = (changed, other) => {
        if (changed.value === other.value) {
          const alt = warehouses.find((w) => String(w.id) !== changed.value);
          if (alt) other.value = alt.id;
        }
      };
      from.addEventListener('change', () => { avoidSame(from, to); root._lines.refreshAll(); });
      to.addEventListener('change', () => avoidSame(to, from));
      root._lines = editor.mount(root, { warehouseSelect: from });
    },
    onSubmit: async (data, { close, root }) => {
      const res = await api.post('/transfers', { ...data, lines: root._lines.collect() });
      close();
      toast(`บันทึกใบโอนย้าย ${res.doc_no} เรียบร้อยแล้ว`);
      await reload();
      refreshLowBadge();
    },
  });
}

async function transferDetail(id, reload) {
  const m = modal({
    title: 'รายละเอียดใบโอนย้าย', wide: true, body: loading(),
    footer: '<div class="spacer"></div><button type="button" class="btn" data-close>ปิด</button>',
  });
  const d = await api.get(`/transfers/${id}`);
  m.root.querySelector('.modal-body').innerHTML = `
    <div class="grid cols-2" style="margin-bottom:16px">
      ${kv([
        ['เลขที่เอกสาร', `<b class="mono">${esc(d.doc_no)}</b>`],
        ['วันที่โอนย้าย', fmtDate(d.transfer_date)],
        ['เส้นทาง', `<span class="badge badge-gray">${esc(d.from_code)}</span>
                     <span style="margin:0 6px;color:var(--primary);font-weight:700">→</span>
                     <span class="badge tone-info">${esc(d.to_code)}</span>`],
      ])}
      ${kv([
        ['สถานะ', statusBadge(d.status)],
        ['ผู้บันทึก', `${esc(d.created_by_name || '—')} · ${fmtDateTime(d.created_at)}`],
        ...(d.status === 'void' ? [['เหตุผลที่ยกเลิก', esc(d.void_reason || '—')]] : []),
        ['หมายเหตุ', esc(d.note || '—')],
      ])}
    </div>
    ${table(d.lines, [
      { key: 'sku', label: 'รหัส', render: (r) => `<span class="mono">${esc(r.sku)}</span>` },
      { key: 'item_name', label: 'อุปกรณ์', render: (r) => `${esc(r.item_name)}${r.serial_list ? `<div class="muted small mono">${esc(r.serial_list)}</div>` : ''}` },
      { key: 'category_name', label: 'หมวดหมู่' },
      { key: 'qty', label: 'จำนวนที่โอน', className: 'num', render: (r) => `<b>${fmtInt(r.qty)}</b> <span class="muted small">${esc(r.unit)}</span>` },
      { key: 'note', label: 'หมายเหตุ', render: (r) => `<span class="muted small">${esc(r.note || '')}</span>` },
    ])}`;

  if (d.status === 'posted' && can('officer')) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-danger';
    btn.textContent = 'ยกเลิกเอกสารนี้';
    btn.addEventListener('click', async () => { m.close(); await voidDoc('transfers', d.id, d.doc_no, reload); });
    m.root.querySelector('.modal-foot').prepend(btn);
  }
}
