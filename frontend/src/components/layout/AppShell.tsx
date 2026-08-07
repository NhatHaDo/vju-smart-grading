import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';
import Header from './Header';
import BottomNav from './BottomNav';

export default function AppShell() {
  return (
    <div
      // 2026-08-04: 100vh trên trình duyệt di động (Safari/Chrome) tính theo
      // chiều cao viewport LỚN NHẤT (lúc thanh địa chỉ ẩn đi), không phải
      // chiều cao đang thực sự nhìn thấy — khiến BottomNav (position:fixed,
      // bottom:0 trong .app-bottom-nav) bị đặt thấp hơn phần màn hình nhìn
      // thấy thật, trông như "mất tab". 100dvh (dynamic viewport height)
      // luôn khớp đúng phần đang hiển thị; và {'-webkit-fill-available'}
      // dự phòng cho Safari cũ hơn chưa hỗ trợ dvh.
      style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
      className="app-shell-root"
    >
      {/* VJU red top bar */}
      <Header />

      {/* Body: icon sidebar (desktop) + scrollable main */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        <Sidebar />

        <main
          className="app-main"
          style={{
            flex: 1,
            overflowY: 'auto',
            // 2026-08-04: chỉ set overflowY khiến trình duyệt tự suy ra
            // overflowX="auto" (theo spec CSS, không phải "visible" như mong
            // đợi) — bất kỳ hàng nào trong trang lỡ rộng hơn màn hình (form
            // lọc không wrap, grid nhiều cột cứng...) sẽ khiến CẢ TRANG cuộn
            // ngang được, dễ thấy trên điện thoại (nội dung bị đẩy lệch,
            // "lộn xộn"). Ép hidden ở đây — bảng nào cố ý cần cuộn ngang thì
            // tự có overflow-x riêng (.dash-table-scroll, .table-scroll-x),
            // không phụ thuộc vào overflow của .app-main.
            overflowX: 'hidden',
            background: '#F5F5F5',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <Outlet />
        </main>
      </div>

      {/* Bottom tab bar (mobile only, see globals.css) */}
      <BottomNav />
    </div>
  );
}
