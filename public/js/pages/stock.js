import { api } from '../api.js';
import { lookup, state, whParam, whLabel } from '../app.js';
import { esc, fmtInt, fmtMoney, fmtDate, table, pager, options, modal, kv, serialBadge, moveBadge, loading } from '../ui.js';

/* ---------------- ยอดคงเหลือในคลัง ---------------- */

export async function renderStock(view) {
  const categories = await lookup('categories');
  const params = new URLSearchParams((location.hash.split('?')[1] || ''));
  const q = { page: 1, per_page: 50, sort: 'name', q: '', category_id: '', only_low: params.get('only_low') || '' };

  view.innerHTML = `
    <div class="toolbar">
      <input id="q" placeholder="🔍 ค้นหารหัส ชื่อ ยี่ห้อ หรือรุ่น" style="min-width:250px">
      <select id="cat">${options(categories, { empty: 'ทุกหมวดหมู่' })}</select>
      <select id="filter">
        <option value="">แสดงทั้งหมด</option>
        <option value="only_low" ${q.only_low ? 'selected' : ''}>เฉพาะที่ใกล้หมด</option>
        <option value="only_zero">เฉพาะที่หมดคลัง</option>
        <option value="in_stock">เฉพาะที่มีของ</option>
      </select>
      <select id="sort">
        <option value="name">เรียงตามชื่อ</option>
        <option value="sku">เรียงตามรหัส</option>
        <option value="category">เรียงตามหมวดหมู่</option>
        <option value="balance">เรียงตามจำนวนคงเหลือ</option>
        <option value="value">เรียงตามมูลค่า</option>
      </select>
      <div class="spacer"></div>
      <a class="btn btn-sm" id="csv">⬇️ ส่งออก CSV</a>
    </div>
    <div class="grid cols-3" id="summary"></div>
    <div class="card">
      <div class="card-head"><h3 id="head">ยอดคงเหลือ</h3></div>
      <div class="card-body tight" id="list">${loading()}</div>
    </div>`;

  /* ---- โหมดรวมทุกคลัง: ตารางเทียบ MMT | MTHAI | รวม ---- */
  const loadCombined = async () => {
    const res = await api.get(`/stock/by-warehouse${api.qs({ q: q.q, category_id: q.category_id, only_low: q.only_low === 'only_low' ? 1 : '' })}`);
    const whs = res.warehouses;
    view.querySelector('#csv').href = '/api/stock/by-warehouse.csv';
    view.querySelector('#head').textContent = `ยอดคงเหลือแยกรายคลัง และยอดรวมทุกคลัง (${whs.length} คลัง)`;

    const s2 = res.summary;
    view.querySelector('#summary').innerHTML = `
      ${whs.map((w) => `
        <div class="stat"><div class="icon tone-info">🏬</div><div>
          <div class="label">คลัง ${esc(w.code)}</div>
          <div class="value">${fmtInt(s2.by_warehouse[w.id]?.qty || 0)}</div>
          <div class="hint">฿${fmtMoney(s2.by_warehouse[w.id]?.value || 0)}</div></div></div>`).join('')}
      <div class="stat"><div class="icon tone-success">Σ</div><div>
        <div class="label">รวมทุกคลัง</div>
        <div class="value">${fmtInt(s2.total_qty)}</div>
        <div class="hint">฿${fmtMoney(s2.total_value)}</div></div></div>`;

    const columns = [
      { key: 'sku', label: 'รหัส', render: (r) => `<span class="mono">${esc(r.sku)}</span>` },
      { key: 'name', label: 'อุปกรณ์', render: (r) => `<b>${esc(r.name)}</b><div class="muted small">${esc(r.category_name)}</div>` },
      ...whs.map((w) => ({
        key: `wh${w.id}`,
        label: `คลัง ${w.code}`,
        className: 'num',
        render: (r) => {
          const v = r.by_warehouse[w.id] || 0;
          return v > 0
            ? `<b>${fmtInt(v)}</b> <span class="muted small">${esc(r.unit)}</span>`
            : '<span class="muted">—</span>';
        },
      })),
      { key: 'total', label: 'รวมทุกคลัง', className: 'num', render: (r) => {
        const low = r.min_qty > 0 && r.total <= r.min_qty;
        return `<b style="font-size:14px;color:${r.total <= 0 ? 'var(--danger)' : low ? 'var(--warn)' : 'var(--success)'}">${fmtInt(r.total)}</b>
                ${low ? '<div class="badge tone-warn" style="margin-top:2px">ใกล้หมด</div>' : ''}`;
      } },
      { key: 'min_qty', label: 'ขั้นต่ำ', className: 'num', render: (r) => `<span class="muted">${fmtInt(r.min_qty)}</span>` },
      { key: 'total_value', label: 'มูลค่ารวม', className: 'num', render: (r) => `฿${fmtMoney(r.total_value)}` },
      { key: 'act', label: '', className: 'nowrap', render: (r) => `<button class="btn btn-sm" data-card="${r.item_id}">การ์ดสต็อก</button>` },
    ];
    view.querySelector('#list').innerHTML = table(res.data, columns, { emptyText: 'ไม่พบอุปกรณ์ตามเงื่อนไขที่เลือก' });
  };

  /* ---- โหมดเจาะคลังเดียว ---- */
  const loadSingle = async () => {
    const query = {
      page: q.page, per_page: q.per_page, sort: q.sort, q: q.q, category_id: q.category_id,
      ...(q.only_low ? { [q.only_low]: 1 } : {}),
      ...whParam(),
    };
    const res = await api.get(`/stock/balance${api.qs(query)}`);
    view.querySelector('#csv').href = `/api/stock/balance.csv${api.qs(query)}`;
    view.querySelector('#head').textContent = `ยอดคงเหลือเฉพาะ${whLabel()}`;

    view.querySelector('#summary').innerHTML = `
      <div class="stat"><div class="icon tone-info">🔢</div><div><div class="label">จำนวนคงเหลือใน${esc(whLabel())}</div>
        <div class="value">${fmtInt(res.summary.total_qty)}</div></div></div>
      <div class="stat"><div class="icon tone-success">💰</div><div><div class="label">มูลค่าใน${esc(whLabel())}</div>
        <div class="value">฿${fmtMoney(res.summary.total_value)}</div></div></div>
      <div class="stat"><div class="icon tone-warn">⚠️</div><div><div class="label">ต่ำกว่าจุดสั่งซื้อ</div>
        <div class="value">${fmtInt(res.summary.low_items || 0)}</div>
        <div class="hint">เทียบกับขั้นต่ำระดับอุปกรณ์</div></div></div>`;

    view.querySelector('#list').innerHTML = table(res.data, [
      { key: 'sku', label: 'รหัส', render: (r) => `<span class="mono">${esc(r.sku)}</span>` },
      { key: 'name', label: 'อุปกรณ์', render: (r) => `<b>${esc(r.name)}</b>${r.model ? `<div class="muted small">${esc(r.brand || '')} ${esc(r.model)}</div>` : ''}` },
      { key: 'category_name', label: 'หมวดหมู่', render: (r) => `<span class="badge badge-gray">${esc(r.category_name)}</span>` },
      { key: 'total_in', label: 'รับเข้า', className: 'num', render: (r) => fmtInt(r.total_in) },
      { key: 'total_out', label: 'จ่ายออก', className: 'num', render: (r) => fmtInt(r.total_out) },
      { key: 'balance', label: 'คงเหลือ', className: 'num', render: (r) => {
        const low = r.min_qty > 0 && r.balance <= r.min_qty;
        return `<b style="font-size:14px;color:${r.balance <= 0 ? 'var(--danger)' : low ? 'var(--warn)' : 'var(--text)'}">${fmtInt(r.balance)}</b>
                <span class="muted small">${esc(r.unit)}</span>`;
      } },
      { key: 'min_qty', label: 'ขั้นต่ำ', className: 'num', render: (r) => `<span class="muted">${fmtInt(r.min_qty)}</span>` },
      { key: 'serial', label: 'Serial', className: 'center', render: (r) => r.track_serial
        ? `<span class="badge tone-info" title="ในคลังนี้ ${r.serial_in_stock} / เบิกไป ${r.serial_issued}">${fmtInt(r.serial_in_stock)} / ${fmtInt(r.serial_issued)}</span>`
        : '<span class="muted small">—</span>' },
      { key: 'stock_value', label: 'มูลค่า', className: 'num', render: (r) => `฿${fmtMoney(r.stock_value)}` },
      { key: 'act', label: '', className: 'nowrap', render: (r) => `<button class="btn btn-sm" data-card="${r.item_id}">การ์ดสต็อก</button>` },
    ], { emptyText: 'ไม่พบอุปกรณ์ตามเงื่อนไขที่เลือก' }) + pager(res);
  };

  const load = async () => {
    view.querySelector('#list').innerHTML = loading();
    // ไม่ได้เลือกคลัง = แสดงตารางเทียบทุกคลังพร้อมยอดรวม
    if (state.warehouseId) await loadSingle();
    else await loadCombined();
  };

  let timer;
  view.querySelector('#q').addEventListener('input', (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => { q.q = e.target.value; q.page = 1; load(); }, 280);
  });
  view.querySelector('#cat').addEventListener('change', (e) => { q.category_id = e.target.value; q.page = 1; load(); });
  view.querySelector('#filter').addEventListener('change', (e) => { q.only_low = e.target.value; q.page = 1; load(); });
  view.querySelector('#sort').addEventListener('change', (e) => { q.sort = e.target.value; load(); });
  view.addEventListener('click', (e) => {
    const p = e.target.closest('[data-page]');
    if (p) { q.page = Number(p.dataset.page); load(); }
    const c = e.target.closest('[data-card]');
    if (c) stockCard(Number(c.dataset.card));
  });

  await load();
}

/** การ์ดสต็อกรายอุปกรณ์ พร้อมยอดสะสม */
async function stockCard(itemId) {
  const m = modal({ title: 'การ์ดสต็อก', wide: true, body: loading(), footer: '<button type="button" class="btn" data-close>ปิด</button>' });
  const d = await api.get(`/stock/card/${itemId}${api.qs(whParam())}`);
  const i = d.item;
  m.root.querySelector('.modal-body').innerHTML = `
    <div class="grid cols-2" style="margin-bottom:14px">
      ${kv([
        ['รหัสอุปกรณ์', `<span class="mono">${esc(i.sku)}</span>`],
        ['ชื่ออุปกรณ์', esc(i.name)],
        ['หมวดหมู่', esc(i.category_name)],
        ['ยี่ห้อ / รุ่น', `${esc(i.brand || '-')} / ${esc(i.model || '-')}`],
      ])}
      ${kv([
        ['ขอบเขตที่ดู', `<span class="badge tone-primary">${esc(whLabel())}</span>`],
        ['คงเหลือ', `<b style="font-size:16px">${fmtInt(i.balance)}</b> ${esc(i.unit)}`],
        ['จุดสั่งซื้อขั้นต่ำ', fmtInt(i.min_qty)],
        ['มูลค่าคงเหลือ', `฿${fmtMoney(i.stock_value)}`],
        ['ที่จัดเก็บ', esc(i.location || '-')],
      ])}
    </div>
    ${table(d.data, [
      { key: 'moved_at', label: 'วันที่', className: 'nowrap', render: (r) => fmtDate(r.moved_at) },
      { key: 'doc_no', label: 'เอกสาร', render: (r) => `<span class="mono small">${esc(r.doc_no)}</span>` },
      { key: 'warehouse_code', label: 'คลัง', render: (r) => `<span class="badge badge-gray">${esc(r.warehouse_code || '-')}</span>` },
      { key: 'move_type', label: 'ประเภท', render: (r) => moveBadge(r.move_type) },
      { key: 'serial_no', label: 'Serial', render: (r) => r.serial_no ? `<span class="mono small">${esc(r.serial_no)}</span>` : '<span class="muted">—</span>' },
      { key: 'qty', label: 'เข้า/ออก', className: 'num', render: (r) => `<b style="color:${r.qty > 0 ? 'var(--success)' : 'var(--danger)'}">${r.qty > 0 ? '+' : ''}${fmtInt(r.qty)}</b>` },
      { key: 'running_balance', label: 'คงเหลือสะสม', className: 'num', render: (r) => `<b>${fmtInt(r.running_balance)}</b>` },
      { key: 'note', label: 'หมายเหตุ', render: (r) => `<span class="muted small">${esc(r.note || '')}</span>` },
    ], { emptyText: 'ยังไม่มีความเคลื่อนไหวของอุปกรณ์นี้' })}`;
}

/* ---------------- ทะเบียนทรัพย์สิน / Serial ---------------- */

export async function renderSerials(view) {
  const items = await lookup('items');
  const q = { q: '', status: '', item_id: '', page: 1, per_page: 60 };

  view.innerHTML = `
    <div class="toolbar">
      <input id="q" placeholder="🔍 ค้นหา Serial, อุปกรณ์ หรือชื่อผู้ถือครอง" style="min-width:280px">
      <select id="status">
        <option value="">ทุกสถานะ</option>
        <option value="in_stock">อยู่ในคลัง</option>
        <option value="issued">ถูกเบิกออก</option>
        <option value="scrapped">ตัดจำหน่าย</option>
      </select>
      <select id="item">${options(items.filter((i) => i.track_serial), { empty: 'ทุกอุปกรณ์', label: (r) => `${r.sku} — ${r.name}` })}</select>
      <div class="spacer"></div>
      <span class="badge tone-primary">กำลังดู: ${esc(whLabel())}</span>
      <a class="btn btn-sm" href="/api/reports/assets-by-holder.csv">⬇️ ส่งออกทรัพย์สินที่ถือครอง</a>
    </div>
    <div class="card"><div class="card-body tight" id="list">${loading()}</div></div>`;

  const load = async () => {
    const box = view.querySelector('#list');
    box.innerHTML = loading();
    const res = await api.get(`/serials${api.qs({ ...q, ...whParam() })}`);
    box.innerHTML = table(res.data, [
      { key: 'serial_no', label: 'Serial / Asset No.', render: (r) => `<b class="mono">${esc(r.serial_no)}</b>` },
      { key: 'item_name', label: 'อุปกรณ์', render: (r) => `${esc(r.item_name)}<div class="muted small mono">${esc(r.sku)}</div>` },
      { key: 'warehouse_code', label: 'คลัง', render: (r) => `<span class="badge tone-info">${esc(r.warehouse_code || '-')}</span>` },
      { key: 'status', label: 'สถานะ', render: (r) => serialBadge(r.status) },
      { key: 'holder_name', label: 'ผู้ถือครอง', render: (r) => r.holder_name
        ? `<b>${esc(r.holder_name)}</b><div class="muted small">${esc(r.holder_code || '')}${r.holder_dept ? ` · ${esc(r.holder_dept)}` : ''}</div>`
        : '<span class="muted">—</span>' },
      { key: 'issued_at', label: 'วันที่เบิก', className: 'nowrap', render: (r) => fmtDate(r.issued_at) },
      { key: 'received_at', label: 'วันที่รับเข้า/คืน', className: 'nowrap', render: (r) => fmtDate(r.received_at) },
      { key: 'act', label: '', render: (r) => `<button class="btn btn-sm" data-timeline="${r.id}">ประวัติ</button>` },
    ], { emptyText: 'ไม่พบทรัพย์สินตามเงื่อนไข' }) + pager(res);
  };

  let timer;
  view.querySelector('#q').addEventListener('input', (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => { q.q = e.target.value; q.page = 1; load(); }, 280);
  });
  view.querySelector('#status').addEventListener('change', (e) => { q.status = e.target.value; q.page = 1; load(); });
  view.querySelector('#item').addEventListener('change', (e) => { q.item_id = e.target.value; q.page = 1; load(); });
  view.addEventListener('click', (e) => {
    const p = e.target.closest('[data-page]');
    if (p) { q.page = Number(p.dataset.page); load(); }
    const t = e.target.closest('[data-timeline]');
    if (t) serialTimeline(Number(t.dataset.timeline));
  });

  await load();
}

const EVENT_LABEL = {
  receive: 'รับเข้าคลัง', issue: 'เบิกให้พนักงาน', return: 'รับคืนเข้าคลัง',
  scrap: 'ตัดจำหน่าย (ชำรุด)', transfer: 'โอนย้ายระหว่างคลัง',
};

async function serialTimeline(id) {
  const m = modal({ title: 'ประวัติการใช้งานทรัพย์สิน', body: loading(), footer: '<button type="button" class="btn" data-close>ปิด</button>' });
  const d = await api.get(`/serials/${id}`);
  m.root.querySelector('.modal-body').innerHTML = `
    ${kv([
      ['Serial', `<b class="mono">${esc(d.serial_no)}</b>`],
      ['อุปกรณ์', `${esc(d.item_name)} <span class="muted">(${esc(d.sku)})</span>`],
      ['คลังที่อยู่', `<span class="badge tone-info">${esc(d.warehouse_code || '-')}</span> ${esc(d.warehouse_name || '')}`],
      ['สถานะปัจจุบัน', serialBadge(d.status)],
      ['ผู้ถือครอง', d.holder_name ? `${esc(d.holder_name)} (${esc(d.holder_code || '')})` : '—'],
      ['หมายเหตุ', esc(d.note || '—')],
    ])}
    <h4 style="margin:18px 0 8px;font-size:13px">ไทม์ไลน์</h4>
    <ul class="timeline">
      ${d.timeline.length ? d.timeline.map((e) => `
        <li>
          <span class="dot" style="background:${e.reversed ? 'var(--text-soft)' : 'var(--primary)'}"></span>
          <div style="flex:1">
            <div><b>${esc(EVENT_LABEL[e.event] || e.event)}</b>
              ${e.reversed ? '<span class="badge tone-danger" style="margin-left:6px">ถูกยกเลิก</span>' : ''}</div>
            <div class="muted small">${fmtDate(e.event_date)} · เอกสาร <span class="mono">${esc(e.doc_no)}</span>
              ${e.holder_after_name ? ` · ให้ ${esc(e.holder_after_name)}` : ''}
              ${e.event === 'return' && e.holder_before_name ? ` · คืนจาก ${esc(e.holder_before_name)}` : ''}
              ${e.wh_before_code && e.wh_after_code && e.wh_before_code !== e.wh_after_code
                ? ` · ${esc(e.wh_before_code)} → ${esc(e.wh_after_code)}`
                : e.wh_after_code ? ` · คลัง ${esc(e.wh_after_code)}` : ''}</div>
            ${e.note ? `<div class="muted small">${esc(e.note)}</div>` : ''}
          </div>
        </li>`).join('') : '<li class="muted">ยังไม่มีประวัติ</li>'}
    </ul>`;
}

/* ---------------- ประวัติการเคลื่อนไหวทั้งหมด ---------------- */

export async function renderMoves(view) {
  const q = { q: '', move_type: '', doc_type: '', from: '', to: '', page: 1, per_page: 80 };

  view.innerHTML = `
    <div class="toolbar">
      <input id="q" placeholder="🔍 ค้นหาเลขที่เอกสาร, Serial หรือชื่ออุปกรณ์" style="min-width:250px">
      <select id="type">
        <option value="">ทุกประเภท</option>
        <option value="IN">รับเข้า</option>
        <option value="OUT">เบิกออก</option>
        <option value="RETURN">รับคืน</option>
        <option value="ADJUST">ปรับปรุง</option>
        <option value="VOID">ยกเลิก</option>
      </select>
      <div class="fixed"><label class="small muted">ตั้งแต่</label><input type="date" id="from"></div>
      <div class="fixed"><label class="small muted">ถึง</label><input type="date" id="to"></div>
      <div class="spacer"></div>
      <span class="badge tone-primary">กำลังดู: ${esc(whLabel())}</span>
      <a class="btn btn-sm" id="csv">⬇️ ส่งออก CSV</a>
    </div>
    <div class="card"><div class="card-body tight" id="list">${loading()}</div></div>`;

  const load = async () => {
    const box = view.querySelector('#list');
    box.innerHTML = loading();
    const query = { ...q, ...whParam() };
    const res = await api.get(`/stock/moves${api.qs(query)}`);
    view.querySelector('#csv').href = `/api/stock/moves.csv${api.qs(query)}`;
    box.innerHTML = table(res.data, [
      { key: 'moved_at', label: 'วันที่', className: 'nowrap', render: (r) => fmtDate(r.moved_at) },
      { key: 'doc_no', label: 'เอกสาร', render: (r) => `<span class="mono small">${esc(r.doc_no)}</span>` },
      { key: 'warehouse_code', label: 'คลัง', render: (r) => `<span class="badge badge-gray">${esc(r.warehouse_code || '-')}</span>` },
      { key: 'move_type', label: 'ประเภท', render: (r) => moveBadge(r.move_type) },
      { key: 'item_name', label: 'อุปกรณ์', render: (r) => `${esc(r.item_name)}<div class="muted small mono">${esc(r.sku)}</div>` },
      { key: 'serial_no', label: 'Serial', render: (r) => r.serial_no ? `<span class="mono small">${esc(r.serial_no)}</span>` : '<span class="muted">—</span>' },
      { key: 'qty', label: 'จำนวน', className: 'num', render: (r) => `<b style="color:${r.qty > 0 ? 'var(--success)' : 'var(--danger)'}">${r.qty > 0 ? '+' : ''}${fmtInt(r.qty)}</b> <span class="muted small">${esc(r.unit)}</span>` },
      { key: 'note', label: 'หมายเหตุ', render: (r) => `<span class="muted small">${esc(r.note || '')}</span>` },
      { key: 'created_by_name', label: 'ผู้บันทึก', render: (r) => `<span class="muted small">${esc(r.created_by_name || '')}</span>` },
    ], { emptyText: 'ไม่พบรายการเคลื่อนไหว' }) + pager(res);
  };

  let timer;
  view.querySelector('#q').addEventListener('input', (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => { q.q = e.target.value; q.page = 1; load(); }, 280);
  });
  view.querySelector('#type').addEventListener('change', (e) => { q.move_type = e.target.value; q.page = 1; load(); });
  view.querySelector('#from').addEventListener('change', (e) => { q.from = e.target.value; q.page = 1; load(); });
  view.querySelector('#to').addEventListener('change', (e) => { q.to = e.target.value; q.page = 1; load(); });
  view.addEventListener('click', (e) => {
    const p = e.target.closest('[data-page]');
    if (p) { q.page = Number(p.dataset.page); load(); }
  });

  await load();
}
