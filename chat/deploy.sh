#!/usr/bin/env bash
# Deploy brain-chat to the Brain VPS.
#
# Idempotent: safe to re-run on every change.
# - Syncs chat/ to /opt/brain/chat/
# - Installs npm deps
# - Creates .env on first run (preserves BRAIN_API_KEY on subsequent runs)
# - Installs/refreshes systemd unit
# - Restarts the service and shows status
#
# Usage:
#   ./deploy.sh                    # uses defaults (Tailscale hostname)
#   VPS_HOST=root@184.174.39.227 ./deploy.sh
#
# Env overrides:
#   VPS_HOST              ssh target (default: root@vmi3163639 via Tailscale)
#   REMOTE_DIR            remote chat dir (default: /opt/brain/chat)
#   REMOTE_DATA_DIR       remote data dir (default: /opt/brain/chat-data)
#   DEFAULT_REPO          default GitHub repo (default: A-Guy-educ/A-Guy)
#   PORT                  listen port (default: 4098)

set -euo pipefail

VPS_HOST="${VPS_HOST:-root@vmi3163639}"
REMOTE_DIR="${REMOTE_DIR:-/opt/brain/chat}"
REMOTE_DATA_DIR="${REMOTE_DATA_DIR:-/opt/brain/chat-data}"
DEFAULT_REPO="${DEFAULT_REPO:-A-Guy-educ/A-Guy}"
PORT="${PORT:-4101}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ssh_target() {
  if [[ "$VPS_HOST" == *"vmi"* ]] || [[ "$VPS_HOST" == *".ts.net" ]]; then
    tailscale ssh "$@"
  else
    ssh "$@"
  fi
}

remote() {
  ssh_target "$VPS_HOST" "$@"
}

echo "==> deploying brain-chat to $VPS_HOST:$REMOTE_DIR"

echo "==> ensuring remote dirs exist"
remote "mkdir -p $REMOTE_DIR $REMOTE_DATA_DIR"

echo "==> verifying prerequisites"
remote "bash -s" <<'EOF'
set -e
command -v node >/dev/null || { echo "ERROR: node not installed"; exit 1; }
node_major=$(node -p 'process.versions.node.split(".")[0]')
if [ "$node_major" -lt 22 ]; then
  echo "ERROR: node $node_major found, need >=22"; exit 1
fi
command -v gh >/dev/null || { echo "ERROR: gh CLI not installed"; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "ERROR: gh not authenticated — run: gh auth login"; exit 1; }
test -f ~/.claude/credentials.json || echo "WARN: ~/.claude/credentials.json missing — run: claude setup-token"
echo "prereqs ok (node $(node --version))"
EOF

echo "==> syncing files"
rsync -az --delete \
  --exclude node_modules \
  --exclude .data \
  --exclude deploy.sh \
  --exclude .env \
  --rsh="$(command -v tailscale >/dev/null && echo 'tailscale ssh' || echo 'ssh')" \
  "$SCRIPT_DIR/" "$VPS_HOST:$REMOTE_DIR/"

echo "==> installing deps"
remote "cd $REMOTE_DIR && npm install --omit=dev --no-audit --no-fund"

echo "==> pruning wrong libc variant (Ubuntu glibc, not musl)"
remote "rm -rf $REMOTE_DIR/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64-musl || true"

echo "==> ensuring .env"
remote "bash -s" <<EOF
set -e
if [ ! -f $REMOTE_DIR/.env ]; then
  key=\$(openssl rand -hex 24)
  cat > $REMOTE_DIR/.env <<ENVEOF
BRAIN_API_KEY=\$key
BRAIN_DATA_DIR=$REMOTE_DATA_DIR
BRAIN_DEFAULT_REPO=$DEFAULT_REPO
PORT=$PORT
ENVEOF
  chmod 600 $REMOTE_DIR/.env
  echo ""
  echo "================================================================"
  echo "  BRAIN_API_KEY=\$key"
  echo "  Save this — it's required for clients (Vercel, CLI, curl)."
  echo "================================================================"
  echo ""
else
  echo ".env already exists — preserving BRAIN_API_KEY"
fi
EOF

echo "==> installing systemd unit"
remote "cat > /etc/systemd/system/brain-chat.service <<EOF
[Unit]
Description=Brain Chat Server
After=network.target

[Service]
Type=simple
WorkingDirectory=$REMOTE_DIR
Environment=HOME=/root
EnvironmentFile=$REMOTE_DIR/.env
ExecStart=/usr/bin/env node server.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable brain-chat >/dev/null 2>&1 || true
systemctl restart brain-chat"

echo "==> waiting for startup"
sleep 2

echo "==> status"
remote "systemctl status brain-chat --no-pager -l | head -15 || true"

echo "==> health check"
remote "curl -sf http://localhost:$PORT/health && echo" || echo "health check failed — see: journalctl -u brain-chat -n 50"

cat <<EOF

Done.

Logs:    ssh $VPS_HOST 'journalctl -u brain-chat -f'
Restart: ssh $VPS_HOST 'systemctl restart brain-chat'
Remote:  $VPS_HOST:$REMOTE_DIR
EOF
