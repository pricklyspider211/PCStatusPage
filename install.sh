#!/usr/bin/env bash
set -euo pipefail

if [ "$EUID" -ne 0 ]; then
  echo "Please run this script as root (use sudo)."
  exit 1
fi

REPO_URL="https://github.com/pricklyspider211/PCStatusPage.git"
APP_DIR="${APP_DIR:-/var/www/pcstatuspage}"
PORT="${PORT:-3000}"
LOG_DIR="$APP_DIR/.logs"

echo "=============================================="
echo "       PricklyStatus Management Menu          "
echo "=============================================="
echo "  1) Install / Update Status Page"
echo "  2) Uninstall Status Page"
echo "=============================================="
read -r -p "Select an option [1-2]: " choice

case "$choice" in
  1)
    echo "Starting installation..."
    if ! command -v node &> /dev/null || ! command -v npm &> /dev/null; then
      echo "Node.js or npm is missing. Installing Node.js 20.x..."
      apt-get update -y
      apt-get install -y curl git build-essential
      curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
      apt-get install -y nodejs
    fi

    if [ -d "$APP_DIR/.git" ]; then
      echo "Updating existing installation..."
      git -C "$APP_DIR" pull --ff-only >/dev/null 2>&1 || true
    else
      echo "Setting up fresh installation directory..."
      rm -rf "$APP_DIR"
      git clone "$REPO_URL" "$APP_DIR"
    fi

    mkdir -p "$APP_DIR" "$LOG_DIR"
    rm -f "$APP_DIR/install.log" "$APP_DIR/server.log" "$APP_DIR/.npm-install.pid"

    if [ ! -d "$APP_DIR/node_modules" ]; then
      echo "Installing project dependencies..."
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

    if command -v ufw &> /dev/null && ufw status | grep -qw "active"; then
      echo "Opening port $PORT in UFW..."
      ufw allow "$PORT" >/dev/null 2>&1 || true
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
    ;;
  2)
    echo "Starting uninstallation..."
    read -r -p "Are you sure you want to completely remove PricklyStatus? [y/N]: " confirm_unins
    if [[ "$confirm_unins" =~ ^[Yy]$ ]]; then
      echo "Stopping running server instances..."
      pkill -f "node server.js" || true

      if command -v ufw &> /dev/null && ufw status | grep -qw "active"; then
        echo "Removing port $PORT rule from UFW..."
        ufw delete allow "$PORT" >/dev/null 2>&1 || true
      fi

      if [ -d "$APP_DIR" ]; then
        echo "Removing application directory ($APP_DIR)..."
        rm -rf "$APP_DIR"
      fi

      echo "PricklyStatus has been successfully uninstalled."
    else
      echo "Uninstallation cancelled."
    fi
    exit 0
    ;;
  *)
    echo "Invalid option selected. Exiting."
    exit 1
    ;;
esac
