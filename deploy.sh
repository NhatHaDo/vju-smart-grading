#!/usr/bin/env bash
# Deploy VJU Smart Grading — chạy TRÊN SERVER (không Docker, dùng Python venv + supervisor).
#   bash ~/vju-smart-grading/deploy.sh
# Giao diện: nếu server có npm thì tự build; không thì cần có sẵn frontend/dist
# (CI/CD GitHub Actions tự đưa dist lên, hoặc build trên máy rồi scp lên).
set -euo pipefail
cd "$(dirname "$0")"

echo "==> 1. Code mới nhất"
git pull --ff-only

echo "==> 2. Backend (venv + thư viện)"
cd backend
[ -d .venv ] || python3 -m venv .venv
.venv/bin/pip install -q --upgrade pip
.venv/bin/pip install -q -r requirements.txt
cd ..

echo "==> 3. Giao diện"
if [ -z "${SKIP_FRONTEND_BUILD:-}" ] && command -v npm >/dev/null; then
  (cd frontend && npm ci && VITE_API_BASE= npm run build)
elif [ ! -f frontend/dist/index.html ]; then
  echo "Chưa có frontend/dist và server không có npm — build trên máy rồi scp dist lên." >&2; exit 1
fi

echo "==> 4. Khởi động lại backend"
supervisorctl restart vju-backend

echo "==> 5. Kiểm tra"
for i in $(seq 1 20); do
  curl -fs http://localhost:10000/api/v1/health && echo && exit 0
  sleep 2
done
echo "Backend chưa lên — xem log: ~/logs/vju-backend.log" >&2; exit 1
