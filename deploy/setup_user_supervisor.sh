#!/usr/bin/env bash
# Cài supervisor + Python 3.13 cho user hiện tại (KHÔNG cần sudo). Chạy 1 lần.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p ~/supervisor ~/logs ~/vju-data

command -v uv >/dev/null || { curl -LsSf https://astral.sh/uv/install.sh | sh; }
export PATH="$HOME/.local/bin:$PATH"

uv python install 3.13
uv venv --python 3.13 --seed ~/supervisor/venv
~/supervisor/venv/bin/pip install -q supervisor
cp deploy/supervisor/supervisord-user.conf ~/supervisor/supervisord.conf

# tự chạy lại sau khi server khởi động lại
( crontab -l 2>/dev/null | grep -v supervisord ; \
  echo "@reboot $HOME/supervisor/venv/bin/supervisord -c $HOME/supervisor/supervisord.conf" ) | crontab -

pgrep -u "$USER" -f supervisord >/dev/null || ~/supervisor/venv/bin/supervisord -c ~/supervisor/supervisord.conf
echo "OK. Kiểm tra: ~/supervisor/venv/bin/supervisorctl -c ~/supervisor/supervisord.conf status"
