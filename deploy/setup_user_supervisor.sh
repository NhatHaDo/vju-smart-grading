#!/usr/bin/env bash
# Cài supervisor + Python 3.13 cho user hiện tại (KHÔNG cần sudo). Chạy 1 lần.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p ~/supervisor ~/logs ~/vju-data

command -v uv >/dev/null || { curl -LsSf https://astral.sh/uv/install.sh | sh; }
export PATH="$HOME/.local/bin:$PATH"

uv python install 3.13
uv venv --clear --python 3.13 --seed ~/supervisor/venv
~/supervisor/venv/bin/pip install -q supervisor
cp deploy/supervisor/supervisord-user.conf ~/supervisor/supervisord.conf

# tự chạy lại sau khi server khởi động lại (nếu server cho phép cron cho user)
if command -v crontab >/dev/null; then
  ( crontab -l 2>/dev/null | grep -v supervisord || true ; \
    echo "@reboot $HOME/supervisor/venv/bin/supervisord -c $HOME/supervisor/supervisord.conf" ) | crontab - \
    || echo "CẢNH BÁO: không đặt được cron @reboot — nhờ anh Tú, hoặc sau khi server khởi động lại phải chạy tay supervisord"
else
  echo "CẢNH BÁO: server không có crontab — sau khi khởi động lại phải chạy tay supervisord (hoặc nhờ anh Tú)"
fi

pgrep -u "$USER" -f supervisord >/dev/null || ~/supervisor/venv/bin/supervisord -c ~/supervisor/supervisord.conf
echo "OK. Kiểm tra: ~/supervisor/venv/bin/supervisorctl -c ~/supervisor/supervisord.conf status"
