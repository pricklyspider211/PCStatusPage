#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://github.com/pricklyspider211/PCStatusPage.git"
APP_DIR="${APP_DIR:-/var/www/pcstatuspage}"
PORT="${PORT:-3000}"
LOG_DIR="$APP_DIR/.logs"

mkdir -p "$APP_DIR" "$LOG_DIR"
rm -f "$APP_DIR/install.log" "$APP_DIR/server.log" "$APP_DIR/.npm-install.pid"

if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull --ff-only >/dev/null 2>&1 || true
else
  git clone "$REPO_URL" "$APP_DIR"
fi

if [ ! -d "$APP_DIR/node_modules" ]; then
  echo "Installing dependencies..."
  (
    cd "$APP_DIR"
    nohup npm install > "$LOG_DIR/install.log" 2>&1 &
    echo $! > "$APP_DIR/.npm-install.pid"
  )

  INSTALL_PID="$(cat "$APP_DIR/.npm-install.pid" 2>/dev/null || echo "")"
  if [ -n "$INSTALL_PID" ]; then
    while kill -0 "$INSTALL_PID" 2>/dev/null; do
      echo "Dependency installation is running in the background..."
      sleep 2
    done
  fi
  rm -f "$APP_DIR/.npm-install.pid"
  echo "Dependencies installed."
fi

if ! pgrep -f "node server.js" >/dev/null 2>&1; then
  echo "Starting server in the background..."
  (
    cd "$APP_DIR"
    PORT="$PORT" nohup node server.js > "$LOG_DIR/server.log" 2>&1 &
  )
fi

for _ in $(seq 1 30); do
  if curl -fsS "http://localhost:$PORT" >/dev/null 2>&1; then
    echo "Successfully Started The PCStatusPage."
    read -r -p "Create initial SuperAdmin account now? [Y/n]: " create_superadmin
    if [[ -z "$create_superadmin" || "$create_superadmin" =~ ^[Yy]$ ]]; then
      (cd "$APP_DIR" && node pstatus.js add superadmin)
    fi
    exit 0
  fi
  sleep 1
done

echo "Failed to start the server. Check $LOG_DIR/server.log"
exit 1
