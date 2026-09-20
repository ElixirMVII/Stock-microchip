import { api } from '../api.js';
import { esc, options, fmtInt } from '../ui.js';

/* ============================================================
 *  ตัวแก้ไขรายการอุปกรณ์ในเอกสาร (ใช้ร่วมกันทุกประเภทเอกสาร)
 *  - อุปกรณ์ที่ติดตาม Serial จะกำหนดจำนวนอัตโนมัติจาก Serial ที่เลือก
 *    ทำให้จำนวนกับ Serial ตรงกันเสมอ
 * ============================================================ */

let seq = 0;

/**
 * @param {'receipt'|'issue'|'return'} mode
 * @param {Array} items รายการอุปกรณ์ทั้งหมด
 */
export function lineEditor(mode, items) {
  const showCost = mode === 'receipt';
  const showCondition = mode === 'return';
  const serialStatus = mode === 'receipt' ? null : mode === 'issue' ? 'in_stock' : 'issued';

  const html = `
    <div class="card" style="margin:0">
      <div class="card-head">
        <h3>รายการอุปกรณ์</h3>
        <div class="spacer"></div>
        <button type="button" class="btn btn-sm btn-primary" data-add-line>+ เพิ่มรายการ</button>
      </div>
      <div class="card-body tight">
        <div class="table-wrap">
          <table class="data line-table">
            <thead><tr>
              <th style="min-width:230px">อุปกรณ์ <span class="req" style="color:var(--danger)">*</span></th>
              <th style="width:110px" class="num">จำนวน</th>
              ${showCost ? '<th style="width:120px" class="num">ราคา/หน่วย</th>' : ''}
              ${showCondition ? '<th style="width:130px">สภาพ</th>' : ''}
              <th style="min-width:180px">หมายเหตุ</th>
              <th style="width:44px"></th>
            </tr></thead>
            <tbody data-lines></tbody>
          </table>
        </div>
        <div class="muted small" style="padding:10px 12px" data-lines-empty hidden>
          ยังไม่มีรายการ — กด “เพิ่มรายการ” เพื่อเริ่มบันทึก
        </div>
      </div>
    </div>`;

  /** ติดตั้ง event handler หลังจากใส่ HTML ลง DOM แล้ว */
  function mount(root, { employeeSelect } = {}) {
    const tbody = root.querySelector('[data-lines]');
    const emptyMsg = root.querySelector('[data-lines-empty]');

    const itemOptions = options(items, { empty: '— เลือกอุปกรณ์ —', label: (r) => `${r.sku} — ${r.name}` });

    const refreshEmpty = () => { emptyMsg.hidden = tbody.children.length > 0; };

    const addLine = () => {
      const id = `ln${++seq}`;
      const tr = document.createElement('tr');
      tr.dataset.line = id;
      tr.innerHTML = `
        <td>
          <select data-item>${itemOptions}</select>
          <div data-serial-box hidden style="margin-top:6px"></div>
        </td>
        <td class="num"><input data-qty type="number" min="1" step="1" value="1" style="text-align:right"></td>
        ${showCost ? '<td class="num"><input data-cost type="number" min="0" step="0.01" value="0" style="text-align:right"></td>' : ''}
        ${showCondition ? `<td><select data-condition>
            <option value="good">ใช้งานได้ (คืนเข้าคลัง)</option>
            <option value="scrap">ชำรุด (ตัดจำหน่าย)</option>
          </select></td>` : ''}
        <td><input data-note placeholder="หมายเหตุ"></td>
        <td><button type="button" class="btn btn-ghost btn-icon" data-remove title="ลบรายการ">✕</button></td>`;
      tbody.appendChild(tr);
      refreshEmpty();
      return tr;
    };

    /** โหลดตัวเลือก Serial ของอุปกรณ์ที่เลือก */
    async function refreshSerials(tr) {
      const itemId = tr.querySelector('[data-item]').value;
      const box = tr.querySelector('[data-serial-box]');
      const qty = tr.querySelector('[data-qty]');
      const item = items.find((i) => String(i.id) === String(itemId));

      if (!item?.track_serial) {
        box.hidden = true;
        box.innerHTML = '';
        qty.readOnly = false;
        qty.title = '';
        return;
      }
      box.hidden = false;
      qty.readOnly = true;
      qty.title = 'จำนวนคำนวณอัตโนมัติจาก Serial';

      if (mode === 'receipt') {
        box.innerHTML = `
          <textarea data-serials rows="2" placeholder="กรอก Serial / Asset No. คั่นด้วยการขึ้นบรรทัดใหม่หรือเครื่องหมายจุลภาค&#10;เช่น ST:3X76N3, ST:2KP76N3"></textarea>
          <div class="help" data-serial-count>ยังไม่ได้กรอก Serial</div>`;
      } else {
        box.innerHTML = '<div class="help">กำลังโหลดรายการ Serial…</div>';
        const holder = employeeSelect?.value;
        const query = { status: serialStatus, ...(mode === 'return' && holder ? { holder_id: holder } : {}) };
        const res = await api.get(`/items/${itemId}/serials${api.qs({ status: serialStatus })}`);
        let list = res.data;
        if (mode === 'return' && query.holder_id) {
          const mine = list.filter((s) => String(s.holder_id) === String(query.holder_id));
          if (mine.length) list = mine;
        }
        box.innerHTML = list.length
          ? `<select data-serials multiple size="${Math.min(6, Math.max(3, list.length))}">
               ${list.map((s) => `<option value="${esc(s.serial_no)}">${esc(s.serial_no)}${s.holder_name ? ` — ${esc(s.holder_name)}` : ''}</option>`).join('')}
             </select>
             <div class="help" data-serial-count>เลือกได้หลายรายการ (กด Ctrl/Cmd ค้างไว้) · มีให้เลือก ${fmtInt(list.length)} ชิ้น</div>`
          : `<div class="help" style="color:var(--danger)">ไม่มี Serial ที่${mode === 'issue' ? 'พร้อมจ่ายในคลัง' : 'ถูกเบิกออกไป'}สำหรับอุปกรณ์นี้</div>`;
      }
      syncQty(tr);
    }

    /** ปรับจำนวนให้ตรงกับ Serial ที่ระบุ */
    function syncQty(tr) {
      const field = tr.querySelector('[data-serials]');
      if (!field) return;
      const n = readSerials(tr).length;
      tr.querySelector('[data-qty]').value = n || 0;
      const counter = tr.querySelector('[data-serial-count]');
      if (counter && field.tagName === 'TEXTAREA') {
        counter.textContent = n ? `กรอกแล้ว ${n} Serial — ระบบจะบันทึกจำนวน ${n} ชิ้น` : 'ยังไม่ได้กรอก Serial';
      }
    }

    function readSerials(tr) {
      const field = tr.querySelector('[data-serials]');
      if (!field) return [];
      if (field.tagName === 'TEXTAREA') {
        return field.value.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean);
      }
      return [...field.selectedOptions].map((o) => o.value);
    }

    tbody.addEventListener('change', (e) => {
      const tr = e.target.closest('[data-line]');
      if (!tr) return;
      if (e.target.matches('[data-item]')) refreshSerials(tr);
      if (e.target.matches('[data-serials]')) syncQty(tr);
    });
    tbody.addEventListener('input', (e) => {
      const tr = e.target.closest('[data-line]');
      if (tr && e.target.matches('textarea[data-serials]')) syncQty(tr);
    });
    tbody.addEventListener('click', (e) => {
      if (e.target.closest('[data-remove]')) {
        e.target.closest('[data-line]').remove();
        refreshEmpty();
      }
    });
    root.querySelector('[data-add-line]').addEventListener('click', () => addLine());

    // เมื่อเปลี่ยนผู้คืน ให้โหลด Serial ใหม่ให้ตรงกับผู้ถือครอง
    employeeSelect?.addEventListener('change', () => {
      if (mode === 'return') tbody.querySelectorAll('[data-line]').forEach((tr) => refreshSerials(tr));
    });

    addLine();

    /** อ่านค่ารายการทั้งหมดออกมาเป็น payload */
    function collect() {
      const lines = [];
      for (const tr of tbody.querySelectorAll('[data-line]')) {
        const itemId = tr.querySelector('[data-item]').value;
        if (!itemId) continue;
        const line = {
          item_id: Number(itemId),
          qty: Number(tr.querySelector('[data-qty]').value || 0),
          note: tr.querySelector('[data-note]').value.trim() || null,
          serials: readSerials(tr),
        };
        if (showCost) line.unit_cost = Number(tr.querySelector('[data-cost]').value || 0);
        if (showCondition) line.condition = tr.querySelector('[data-condition]').value;
        lines.push(line);
      }
      if (!lines.length) throw new Error('กรุณาเพิ่มรายการอุปกรณ์อย่างน้อย 1 รายการ');
      for (const l of lines) {
        if (!l.qty || l.qty < 1) {
          const item = items.find((i) => i.id === l.item_id);
          throw new Error(item?.track_serial
            ? `กรุณาระบุ Serial ของ "${item.name}" อย่างน้อย 1 รายการ`
            : 'จำนวนของแต่ละรายการต้องมากกว่า 0');
        }
      }
      return lines;
    }

    return { collect, addLine };
  }

  return { html, mount };
}
