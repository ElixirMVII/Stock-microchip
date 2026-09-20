import { api } from '../api.js';
import { esc, fmtInt, fmtMoney, fmtDate, table, moveBadge, MONTH_FULL } from '../ui.js';
import { whParam, whLabel, state } from '../app.js';

const stat = (icon, tone, label, value, hint = '') => `
  <div class="stat">
    <div class="icon ${tone}">${icon}</div>
    <div style="min-width:0">
      <div class="label">${esc(label)}</div>
      <div class="value">${value}</div>
      ${hint ? `<div class="hint">${esc(hint)}</div>` : ''}
    </div>
  </div>`;

/** กราฟแท่งรับเข้า/จ่ายออกแบบ inline SVG (ไม่ต้องพึ่งไลบรารีภายนอก) */
function trendChart(rows) {
  if (!rows.length) return '<div class="empty">ยังไม่มีข้อมูลความเคลื่อนไหว</div>';
  const w = 620, h = 190, pad = { t: 14, r: 12, b: 30, l: 46 };
  const max = Math.max(1, ...rows.map((r) => Math.max(r.qty_in, r.qty_out)));
  const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
  const slot = iw / rows.length, bw = Math.min(20, slot / 2.6);

  const bars = rows.map((r, i) => {
    const cx = pad.l + slot * i + slot / 2;
    const hi = (r.qty_in / max) * ih, ho = (r.qty_out / max) * ih;
    const [yy, mm] = r.ym.split('-');
    return `
      <rect x="${cx - bw - 2}" y="${pad.t + ih - hi}" width="${bw}" height="${hi}" rx="3" fill="var(--success)"><title>รับเข้า ${fmtInt(r.qty_in)}</title></rect>
      <rect x="${cx + 2}" y="${pad.t + ih - ho}" width="${bw}" height="${ho}" rx="3" fill="var(--warn)"><title>จ่ายออก ${fmtInt(r.qty_out)}</title></rect>
      <text x="${cx}" y="${h - 10}" text-anchor="middle" font-size="10.5" fill="var(--text-muted)">${esc(MONTH_FULL[Number(mm) - 1].slice(0, 3))} ${esc(yy.slice(2))}</text>`;
  }).join('');

  const grid = [0, .5, 1].map((f) => {
    const y = pad.t + ih - ih * f;
    return `<line x1="${pad.l}" y1="${y}" x2="${w - pad.r}" y2="${y}" stroke="var(--border)" stroke-width="1"/>
            <text x="${pad.l - 7}" y="${y + 3.5}" text-anchor="end" font-size="10" fill="var(--text-soft)">${fmtInt(Math.round(max * f))}</text>`;
  }).join('');

  return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:auto" role="img" aria-label="กราฟความเคลื่อนไหวรายเดือน">
    ${grid}${bars}
  </svg>
  <div style="display:flex;gap:16px;justify-content:center;font-size:12px;margin-top:4px">
    <span><span style="display:inline-block;width:10px;height:10px;background:var(--success);border-radius:2px"></span> รับเข้า</span>
    <span><span style="display:inline-block;width:10px;height:10px;background:var(--warn);border-radius:2px"></span> จ่ายออก</span>
  </div>`;
}

export async function renderDashboard(view) {
  const d = await api.get(`/dashboard${api.qs(whParam())}`);
  const t = d.totals;
  const now = new Date();

  // แถวเปรียบเทียบรายคลัง แสดงเฉพาะตอนดูรวมทุกคลัง
  const whCards = (!state.warehouseId && d.warehouses?.length > 1) ? `
    <div class="card" style="margin-bottom:16px">
      <div class="card-head"><h3>🏬 เปรียบเทียบคลัง</h3><div class="spacer"></div>
        <a href="#/stock" class="btn btn-sm">ดูรายอุปกรณ์</a></div>
      <div class="card-body">
        <div class="grid cols-${Math.min(4, d.warehouses.length + 1)}">
          ${d.warehouses.map((w) => `
            <div class="stat"><div class="icon tone-info">🏬</div><div>
              <div class="label">คลัง ${esc(w.code)}</div>
              <div class="value">${fmtInt(w.balance)}</div>
              <div class="hint">฿${fmtMoney(w.value)} · ${fmtInt(w.item_count)} รายการ</div>
            </div></div>`).join('')}
          <div class="stat"><div class="icon tone-success">Σ</div><div>
            <div class="label">รวมทุกคลัง</div>
            <div class="value">${fmtInt(d.totals.total_qty)}</div>
            <div class="hint">฿${fmtMoney(d.totals.total_value)}</div>
          </div></div>
        </div>
      </div>
    </div>` : '';

  view.innerHTML = `
    ${state.warehouseId ? `<div class="toolbar"><span class="badge tone-primary">กำลังดูเฉพาะ ${esc(whLabel())}</span>
      <span class="muted small">เลือก “ทุกคลัง (รวม)” ที่แถบด้านบนเพื่อดูภาพรวมทั้งหมด</span></div>` : ''}
    ${whCards}
    <div class="grid cols-5" style="margin-bottom:16px">
      ${stat('📦', 'tone-primary', 'อุปกรณ์ในระบบ', fmtInt(t.item_count), 'รายการที่เปิดใช้งาน')}
      ${stat('🔢', 'tone-info', 'จำนวนคงเหลือรวม', fmtInt(t.total_qty), 'ทุกหมวดหมู่รวมกัน')}
      ${stat('💰', 'tone-success', 'มูลค่าคงคลัง', `฿${fmtMoney(t.total_value)}`, 'คำนวณจากราคาต่อหน่วย')}
      ${stat('⚠️', 'tone-warn', 'ใกล้ถึงจุดสั่งซื้อ', fmtInt(t.low_count), 'ต่ำกว่าหรือเท่าขั้นต่ำ')}
      ${stat('🚫', 'tone-danger', 'ของหมดคลัง', fmtInt(t.out_count), 'คงเหลือ 0')}
    </div>

    <div class="grid cols-4" style="margin-bottom:16px">
      ${stat('📥', 'tone-success', `รับเข้าเดือน${MONTH_FULL[now.getMonth()]}`, fmtInt(d.thisMonth.qty_in))}
      ${stat('📤', 'tone-warn', `จ่ายออกเดือน${MONTH_FULL[now.getMonth()]}`, fmtInt(d.thisMonth.qty_out))}
      ${stat('🔖', 'tone-info', 'ทรัพย์สินที่ถูกเบิกไป', fmtInt(d.assets.issued || 0), 'นับตาม Serial')}
      ${stat('🏬', 'tone-primary', 'ทรัพย์สินพร้อมจ่าย', fmtInt(d.assets.in_stock || 0), 'Serial ที่อยู่ในคลัง')}
    </div>

    <div class="grid cols-2">
      <div class="card">
        <div class="card-head"><h3>ความเคลื่อนไหว 6 เดือนล่าสุด</h3></div>
        <div class="card-body">${trendChart(d.trend)}</div>
      </div>

      <div class="card">
        <div class="card-head"><h3>⚠️ ต้องสั่งซื้อเพิ่ม</h3><div class="spacer"></div>
          <a href="#/stock?only_low=1" class="btn btn-sm">ดูทั้งหมด</a></div>
        <div class="card-body tight">
          ${table(d.lowItems, [
            { key: 'name', label: 'อุปกรณ์', render: (r) => `<b>${esc(r.name)}</b><div class="muted small">${esc(r.sku)}</div>` },
            { key: 'balance', label: 'คงเหลือ', className: 'num', render: (r) => `<b style="color:var(--danger)">${fmtInt(r.balance)}</b> <span class="muted small">${esc(r.unit)}</span>` },
            { key: 'min_qty', label: 'ขั้นต่ำ', className: 'num', render: (r) => fmtInt(r.min_qty) },
            { key: 'bar', label: '', render: (r) => {
              const pct = r.min_qty ? Math.min(100, (r.balance / r.min_qty) * 100) : 100;
              const color = pct <= 34 ? 'var(--danger)' : pct <= 67 ? 'var(--warn)' : 'var(--success)';
              return `<div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:${color}"></div></div>`;
            } },
          ], { emptyText: 'สต็อกทุกรายการอยู่ในระดับปกติ 👍' })}
        </div>
      </div>
    </div>

    <div class="grid cols-2">
      <div class="card">
        <div class="card-head"><h3>รายการเคลื่อนไหวล่าสุด</h3><div class="spacer"></div>
          <a href="#/moves" class="btn btn-sm">ดูทั้งหมด</a></div>
        <div class="card-body tight">
          ${table(d.recentMoves, [
            { key: 'moved_at', label: 'วันที่', className: 'nowrap', render: (r) => fmtDate(r.moved_at) },
            { key: 'move_type', label: 'ประเภท', render: (r) => moveBadge(r.move_type) },
            { key: 'item_name', label: 'อุปกรณ์', render: (r) => `${esc(r.item_name)}${r.warehouse_code ? ` <span class="badge badge-gray">${esc(r.warehouse_code)}</span>` : ''}${r.serial_no ? `<div class="muted small mono">${esc(r.serial_no)}</div>` : ''}` },
            { key: 'qty', label: 'จำนวน', className: 'num', render: (r) => `<b style="color:${r.qty > 0 ? 'var(--success)' : 'var(--danger)'}">${r.qty > 0 ? '+' : ''}${fmtInt(r.qty)}</b>` },
            { key: 'doc_no', label: 'เอกสาร', render: (r) => `<span class="mono small">${esc(r.doc_no)}</span>` },
          ], { emptyText: 'ยังไม่มีการเคลื่อนไหว' })}
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h3>สัดส่วนคงเหลือตามหมวดหมู่</h3></div>
        <div class="card-body tight">
          ${table(d.byCategory, [
            { key: 'category_name', label: 'หมวดหมู่' },
            { key: 'balance', label: 'คงเหลือ', className: 'num', render: (r) => fmtInt(r.balance) },
            { key: 'value', label: 'มูลค่า', className: 'num', render: (r) => `฿${fmtMoney(r.value)}` },
            { key: 'bar', label: '', render: (r) => {
              const max = Math.max(...d.byCategory.map((x) => x.balance), 1);
              return `<div class="bar-track"><div class="bar-fill" style="width:${(r.balance / max) * 100}%"></div></div>`;
            } },
          ], { emptyText: 'ยังไม่มีสินค้าคงเหลือ' })}
        </div>
      </div>
    </div>`;
}
