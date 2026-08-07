import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import fs from 'fs'

// Chứng chỉ HTTPS cục bộ tạo bằng mkcert (xem HUONG_DAN_HTTPS_LOCAL.md ở gốc
// project) — camera trên điện thoại chỉ hoạt động qua https (hoặc
// localhost), nên cần https thật cho cả khi truy cập bằng IP LAN, không chỉ
// http thường. Nếu chưa chạy mkcert / chưa có 2 file này thì tự động rơi về
// http bình thường (không phải bắt buộc để chạy web, chỉ cần khi test camera
// qua IP LAN trên điện thoại).
const certFile = path.resolve(__dirname, '.cert/dev-cert.pem')
const keyFile = path.resolve(__dirname, '.cert/dev-key.pem')
const hasLocalCert = fs.existsSync(certFile) && fs.existsSync(keyFile)

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    // host: true → bind ra 0.0.0.0 thay vì chỉ localhost, để điện thoại
    // cùng WiFi với Mac truy cập được qua http://<IP LAN của Mac>:5173
    // (mặc định Vite chỉ nghe localhost, điện thoại sẽ không kết nối được
    // dù đúng IP nếu thiếu dòng này).
    host: true,
    https: hasLocalCert
      ? { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) }
      : undefined,
    // allowedHosts: true → tắt hẳn việc Vite chặn theo tên host lạ (mặc định
    // Vite chỉ cho localhost/IP LAN, chặn hết các domain khác vì lý do bảo
    // mật DNS rebinding) — cần tắt vì subdomain *.trycloudflare.com đổi ngẫu
    // nhiên mỗi lần chạy `cloudflared tunnel --url http://localhost:5173`,
    // không thể liệt kê trước. Chấp nhận được vì đây là máy dev cá nhân.
    allowedHosts: true,
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
      // 2026-08-04: SheetImageViewer.tsx (tab Ảnh detect/Ảnh đã căn chỉnh/Ảnh
      // gốc) và OmrDebugPage.tsx gọi trực tiếp "${VITE_API_BASE}/outputs/..."
      // hoặc "/uploads/..." (route StaticFiles của backend, xem app/main.py)
      // — 2 route này KHÔNG nằm trong "/api", nên khi VITE_API_BASE để trống
      // (để login qua cloudflared tunnel hoạt động — xem .env.local) thì ảnh
      // lại vô tình gọi nhầm vào chính cổng 5173 (frontend, không có gì ở
      // route này) thay vì cổng 8000 (backend) → "Không có ảnh debug" dù
      // file thật sự tồn tại trên đĩa. Proxy luôn 2 route này giống /api.
      '/outputs': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
      '/uploads': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
})
