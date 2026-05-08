#!/bin/sh
set -eu

REPO_URL="${REPO_URL:-https://github.com/kandor1772/tiberius-phone.git}"
APP_DIR="${APP_DIR:-/opt/tiberius-phone}"
STATE_DIR="${STATE_DIR:-/var/lib/tiberius}"

apt-get update
apt-get install -y --no-install-recommends python3 git curl ca-certificates debian-keyring debian-archive-keyring apt-transport-https

if ! id tiberius >/dev/null 2>&1; then
  useradd --system --create-home --shell /usr/sbin/nologin tiberius
fi

mkdir -p "$APP_DIR" "$STATE_DIR"
chown -R tiberius:tiberius "$APP_DIR" "$STATE_DIR"

if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull --ff-only
else
  git clone "$REPO_URL" "$APP_DIR"
fi

chown -R tiberius:tiberius "$APP_DIR"
cp "$APP_DIR/deploy/systemd/tiberius-backend.service" /etc/systemd/system/tiberius-backend.service
systemctl daemon-reload
systemctl enable --now tiberius-backend

if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf "https://dl.cloudsmith.io/public/caddy/stable/gpg.key" | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf "https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt" > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  apt-get install -y caddy
fi

cp "$APP_DIR/deploy/Caddyfile" /etc/caddy/Caddyfile
systemctl reload caddy || systemctl restart caddy

echo "Tiberius backend installed."
echo "Check: curl -fsS https://eltiburon.duckdns.org/health"
