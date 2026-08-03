#!/usr/bin/env bash
# Deploy script cho VJU Smart Grading (scoring.cunghoc.net)
#
# Chạy trực tiếp TRÊN SERVER (không phải máy local), sau khi đã `git push`
# code lên remote từ máy local. Ví dụ chạy qua SSH:
#   ssh user@scoring.cunghoc.net 'bash ~/vju-smart-grading/deploy.sh'
#
# Không có CI/CD tự động cho project này — đây là script gom lại các bước
# deploy thủ công đã dùng trong suốt quá trình phát triển, để lần sau chỉ
# cần chạy 1 lệnh thay vì gõ tay từng bước.

set -euo pipefail

PROJECT_DIR="$HOME/vju-smart-grading"
WEB_DIR="$HOME/public_html"
BACKEND_SERVICE="vju-backend.service"

cd "$PROJECT_DIR"

echo "==> 1. Pull code mới nhất"
git pull

echo "==> 2. Build lại frontend"
cd "$PROJECT_DIR/frontend"
npm install
npm run build

echo "==> 3. Đồng bộ file build lên thư mục web"
# Không dùng --delete: .htaccess (SPA routing) đã nằm trong frontend/public/
# nên luôn được Vite copy vào dist/ và sẽ không bị xoá nhầm, nhưng cứ để mặc
# định (không --delete) cho chắc, tránh xoá nhầm file server-only khác.
rsync -av dist/ "$WEB_DIR/"

echo "==> 4. Restart backend"
sudo systemctl restart "$BACKEND_SERVICE"
sudo systemctl status "$BACKEND_SERVICE" --no-pager -l | head -15

echo "==> Xong. Kiểm tra lại tại: https://scoring.cunghoc.net/app/results"
