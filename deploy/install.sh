#!/usr/bin/env bash
set -euo pipefail
INSTALL_DIR="${1:-/opt/dump-sniper}"
SERVICE_USER="${SERVICE_USER:-ubuntu}"
if [[ $EUID -ne 0 ]]; then echo 'Run with sudo.'; exit 1; fi
# Restrict substitutions and destinations to simple absolute deployment paths.
if [[ ! "$INSTALL_DIR" =~ ^/[a-zA-Z0-9_/-]+$ || "$INSTALL_DIR" == / || "$INSTALL_DIR" == *..* ]]; then
  echo 'Use a dedicated absolute installation directory.'; exit 1
fi
if [[ ! "$SERVICE_USER" =~ ^[a-z_][a-z0-9_-]*$ ]]; then echo 'Invalid service user'; exit 1; fi
id "$SERVICE_USER" >/dev/null
for cmd in node npm rsync systemctl; do command -v "$cmd" >/dev/null; done
node -e 'if (+process.versions.node.split(".")[0] < 22) process.exit(1)'
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
mkdir -p "$INSTALL_DIR/helius" "$INSTALL_DIR/deploy"
if [[ "$(readlink -f "$PROJECT_DIR")" != "$(readlink -f "$INSTALL_DIR")" ]]; then
  rsync -a --exclude=node_modules --exclude=.env --exclude=.cos.env --exclude=data --exclude='*.jsonl' \
    "$PROJECT_DIR/helius/" "$INSTALL_DIR/helius/"
  cp "$PROJECT_DIR/deploy/"*.service "$PROJECT_DIR/deploy/"*.timer "$INSTALL_DIR/deploy/"
  cp "$PROJECT_DIR/package.json" "$PROJECT_DIR/package-lock.json" "$PROJECT_DIR/README.md" "$INSTALL_DIR/"
fi
if [[ ! -f "$INSTALL_DIR/helius/.env" ]]; then cp "$INSTALL_DIR/helius/.env.example" "$INSTALL_DIR/helius/.env"; fi
if [[ ! -f "$INSTALL_DIR/helius/.cos.env" ]]; then cp "$INSTALL_DIR/helius/.cos.env.example" "$INSTALL_DIR/helius/.cos.env"; fi
mkdir -p "$INSTALL_DIR/helius/data"
chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR/helius"
chmod 600 "$INSTALL_DIR/helius/.env"
chmod 600 "$INSTALL_DIR/helius/.cos.env"
sudo -u "$SERVICE_USER" npm ci --prefix "$INSTALL_DIR/helius" --omit=dev
NODE_BIN="$(command -v node)"
sed -e "s|/opt/dump-sniper|$INSTALL_DIR|g" \
  -e "s|^User=ubuntu|User=$SERVICE_USER|" -e "s|^Group=ubuntu|Group=$SERVICE_USER|" \
  -e "s|^ExecStart=/usr/bin/node |ExecStart=$NODE_BIN |" \
  "$INSTALL_DIR/deploy/dump-sniper.service" > /etc/systemd/system/dump-sniper.service
sed -e "s|/opt/dump-sniper|$INSTALL_DIR|g" \
  -e "s|^User=ubuntu|User=$SERVICE_USER|" -e "s|^Group=ubuntu|Group=$SERVICE_USER|" \
  -e "s|^ExecStart=/usr/bin/node |ExecStart=$NODE_BIN |" \
  "$INSTALL_DIR/deploy/dump-sniper-upload.service" > /etc/systemd/system/dump-sniper-upload.service
cp "$INSTALL_DIR/deploy/dump-sniper-upload.timer" /etc/systemd/system/dump-sniper-upload.timer
sed -e "s|/opt/dump-sniper|$INSTALL_DIR|g" \
  -e "s|^User=ubuntu|User=$SERVICE_USER|" -e "s|^Group=ubuntu|Group=$SERVICE_USER|" \
  -e "s|^ExecStart=/usr/bin/node |ExecStart=$NODE_BIN |" \
  "$INSTALL_DIR/deploy/dump-sniper-dashboard.service" > /etc/systemd/system/dump-sniper-dashboard.service
systemctl daemon-reload
echo "Installed. Configure $INSTALL_DIR/helius/.env; DRY_RUN=true is the default."
echo 'Fresh installation: state files are created automatically on first start.'
echo 'When ready: sudo systemctl enable --now dump-sniper'
echo 'Logs: journalctl -u dump-sniper -f'
echo 'Dashboard: sudo systemctl enable --now dump-sniper-dashboard.service (127.0.0.1:8787)'
echo "Daily COS: fill $INSTALL_DIR/helius/.cos.env, then sudo systemctl enable --now dump-sniper-upload.timer"
