# Hướng dẫn deploy lên server nội bộ

Kiến trúc: `Internet → Cloudflare Tunnel (hoặc reverse proxy) → nginx (web) → FastAPI (backend)`.
Server nội bộ **không cần mở cổng vào** khi dùng Cloudflare Tunnel.

## 1. Yêu cầu server
- Linux có Docker + Docker Compose plugin, ra được Internet (tải image, kết nối Cloudflare).
- ~3 GB trống để build (LibreOffice nặng; bỏ bằng `INSTALL_LIBREOFFICE=0` nếu không dùng đề Word có công thức).

## 2. Cài lần đầu
```bash
sudo mkdir -p /opt/vju && sudo chown $USER /opt/vju
git clone https://github.com/NhatHaDo/vju-smart-grading.git ~/vju-smart-grading
cd ~/vju-smart-grading
cp deploy.env.example /opt/vju/deploy.env
nano /opt/vju/deploy.env        # JWT_SECRET_KEY, CORS_ORIGINS, token tunnel
docker compose --env-file /opt/vju/deploy.env up -d --build   # thử, chưa mở ra ngoài
curl http://localhost:8080/api/v1/health
```
Dữ liệu (DB, ảnh) nằm trong volume Docker `app_data` → **đưa volume này vào lịch backup hằng ngày**:
```bash
docker run --rm -v vju-smart-grading_app_data:/data -v /backup:/backup alpine \
  tar czf /backup/vju-$(date +%F).tgz -C /data .
```

## 3. Mở ra ngoài
**Cách A – Cloudflare Tunnel (khuyên dùng):**
1. Cloudflare Zero Trust → Networks → Tunnels → Create tunnel → copy token vào `CLOUDFLARE_TUNNEL_TOKEN`.
2. Public hostname: domain của trường → Service `http://web:80`.
3. `docker compose --env-file /opt/vju/deploy.env --profile tunnel up -d`
4. Đặt `CORS_ORIGINS=https://<domain trường>`.

**Cách B – Reverse proxy của IT (nginx/Caddy):** trỏ domain → `http://<ip server>:8080`, bật HTTPS ở proxy,
đặt header `X-Forwarded-Proto`, `client_max_body_size 100m`, `proxy_read_timeout 300s`.

HTTPS là bắt buộc (camera + quét QR chỉ chạy trên HTTPS).

## 4. CI/CD bằng GitHub Actions (`.github/workflows/deploy.yml`)
Push lên `main` → chạy test + build → deploy trên server.
Server nội bộ GitHub không truy cập được nên dùng **self-hosted runner**:
1. GitHub repo → Settings → Actions → Runners → New self-hosted runner → làm theo lệnh, thêm label `vju-prod`.
2. Cài runner thành service: `sudo ./svc.sh install && sudo ./svc.sh start` (user của runner phải thuộc nhóm `docker`).
3. File `/opt/vju/deploy.env` có sẵn trên server (bí mật không nằm trong GitHub).
Từ đó mỗi lần merge vào `main` là tự deploy; chạy tay: tab Actions → CI/CD → Run workflow.

Rollback: `git revert` rồi push, hoặc trên server `git checkout <commit> && docker compose ... up -d --build`.

## 5. Lưu ý
- Domain đổi: chỉ sửa `CORS_ORIGINS` + hostname tunnel (web không build cứng domain). App iOS vẫn cần sửa `frontend/capacitor.config.ts`.
- Font Be Vietnam Pro cho ảnh debug chưa có trong repo (xem `backend/app/core/omr/assets/fonts/README.md`).
- Backend chạy 1 worker vì dùng SQLite.
- Tài khoản admin mặc định `admin@vju.ac.vn` / `password` được tự tạo khi chạy lần đầu: **đăng nhập đổi mật khẩu ngay**.
