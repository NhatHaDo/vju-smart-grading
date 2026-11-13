# Deploy lên server nội bộ (Python + supervisor, không Docker)

Kiến trúc: `Internet → Cloudflare Tunnel / proxy → uvicorn :10000 (FastAPI + giao diện web)`.
Supervisor giữ backend luôn chạy. Không cần nginx: backend phục vụ luôn giao diện đã build (`FRONTEND_DIST`).

## 1. Chuẩn bị (user `scoring`, không cần sudo nếu server đã có sẵn)
```bash
python3 --version      # cần 3.12 hoặc 3.13 (Python 3.14 chưa có sẵn gói numpy/opencv bản đang ghim)
which supervisorctl git
```
Nếu Python là 3.14: cài Python riêng không cần sudo bằng `uv` → `curl -LsSf https://astral.sh/uv/install.sh | sh`, `uv python install 3.13`, rồi tạo venv bằng `~/.local/bin/uv venv --python 3.13 backend/.venv`.
LibreOffice (chỉ cho đề Word có công thức) cần quyền cài đặt: bỏ qua được, chức năng đó sẽ tắt.

## 2. Cài lần đầu
```bash
git clone https://github.com/NhatHaDo/vju-smart-grading.git ~/vju-smart-grading
cd ~/vju-smart-grading
mkdir -p ~/vju-data ~/logs
cp deploy/env.example backend/.env
nano backend/.env          # JWT_SECRET_KEY (openssl rand -hex 32), CORS_ORIGINS
```
Giao diện: server có `npm` thì `deploy.sh` tự build. Không có thì build trên máy rồi đưa lên:
```bash
cd frontend && npm ci && VITE_API_BASE= npm run build
scp -r dist scoring@172.16.12.95:~/vju-smart-grading/frontend/
```
Chạy deploy (cài thư viện, khởi động lại, kiểm tra health):
```bash
bash ~/vju-smart-grading/deploy.sh
```

## 3. Supervisor
**Không có sudo / chưa có supervisor** (trường hợp server `prod01`): chạy 1 lần script cài supervisor + Python 3.13 cho user `scoring`:
```bash
bash ~/vju-smart-grading/deploy/setup_user_supervisor.sh
```
Script tự cài `uv`, Python 3.13, supervisor, đặt cron `@reboot` để tự chạy lại. Cần server ra Internet (astral.sh, github.com, pypi.org). Làm bước này TRƯỚC `deploy.sh`.

**Có root:** cách chuẩn dưới đây.
Nhờ người quản server (hoặc tự nếu có quyền) đặt `deploy/supervisor/vju-backend.conf` vào thư mục conf của supervisor, rồi:
```bash
supervisorctl reread && supervisorctl update && supervisorctl status vju-backend
```
User `scoring` cần quyền gọi `supervisorctl` (socket cho phép nhóm/user đó) để `deploy.sh` restart được.
Log: `~/logs/vju-backend.log`.

Mở thử trong mạng trường: `http://172.16.12.95:10000`. **Đổi ngay mật khẩu admin mặc định** (`admin@vju.ac.vn` / `password`).

## 4. Mở ra ngoài
**Cloudflare Tunnel:** Zero Trust → Networks → Tunnels → tạo tunnel, hostname = domain trường, Service = `http://localhost:10000`; cài `cloudflared` làm service trên server (cần quyền root/anh Tú). Sau đó thêm `https://<domain>` vào `CORS_ORIGINS` rồi `supervisorctl restart vju-backend`.
**Reverse proxy của IT:** trỏ domain → `http://172.16.12.95:10000`, bật HTTPS, `client_max_body_size 100m`, `proxy_read_timeout 300s`. HTTPS bắt buộc (camera + quét QR).

## 5. CI/CD (GitHub Actions)
Push lên `main` → chạy test + build giao diện → deploy trên server. Server nội bộ GitHub không với tới, nên cần **self-hosted runner** (label `vju-prod`) cài bằng user `scoring`:
GitHub repo → Settings → Actions → Runners → New self-hosted runner, làm theo lệnh. Chạy nền: `./svc.sh install` cần sudo (nhờ anh Tú), hoặc chạy `./run.sh` trong supervisor/tmux.

## 6. Lưu ý
- Dữ liệu (DB, ảnh) nằm ở `~/vju-data`, **ngoài thư mục code**: đưa vào lịch backup hằng ngày.
- Backend chạy 1 tiến trình vì dùng SQLite.
- Đổi domain: chỉ sửa `CORS_ORIGINS` + hostname tunnel. App iOS vẫn phải sửa `frontend/capacitor.config.ts`.
- Font Be Vietnam Pro cho ảnh debug chưa có trong repo (xem `backend/app/core/omr/assets/fonts/README.md`).
