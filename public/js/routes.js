import { renderDashboard } from './pages/dashboard.js';
import { renderReceipts, renderIssues, renderReturns, renderAdjustments } from './pages/documents.js';
import { renderStock, renderSerials, renderMoves } from './pages/stock.js';
import { renderReports } from './pages/reports.js';
import { renderMaster, renderUsers } from './pages/master.js';

/** ตารางเส้นทางของหน้าเว็บ */
export const routes = {
  '#/': { title: 'แดชบอร์ด', render: renderDashboard },
  '#/receipts': { title: 'รับอุปกรณ์เข้า', render: renderReceipts },
  '#/issues': { title: 'เบิกอุปกรณ์ออก', render: renderIssues },
  '#/returns': { title: 'รับคืนอุปกรณ์', render: renderReturns },
  '#/adjustments': { title: 'ปรับปรุงสต็อก', render: renderAdjustments },
  '#/stock': { title: 'ยอดคงเหลือในคลัง', render: renderStock },
  '#/serials': { title: 'ทะเบียนทรัพย์สิน / Serial', render: renderSerials },
  '#/moves': { title: 'ประวัติการเคลื่อนไหว', render: renderMoves },
  '#/reports': { title: 'รายงาน', render: renderReports },
  '#/master': { title: 'ข้อมูลหลัก', render: renderMaster },
  '#/users': { title: 'ผู้ใช้งานระบบ', render: renderUsers },
};
