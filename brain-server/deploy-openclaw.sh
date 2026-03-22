#!/bin/bash
set -euo pipefail

# =============================================================================
# Deploy OpenClaw + Claude Code to Brain Server
#
# Usage:
#   ./deploy-openclaw.sh [VPS_IP] [MINIMAX_API_KEY] [ANTHROPIC_API_KEY]
#   ./deploy-openclaw.sh 100.66.248.120 sk-minimax-xxx sk-antropic-xxx
# =============================================================================

VPS_IP="${1:-100.66.248.120}"
MINIMAX_API_KEY="${2:-}"
ANTHROPIC_API_KEY="${3:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "=========================================="
echo "  Deploying OpenClaw + Claude Code"
echo "=========================================="
echo "  VPS: $VPS_IP"
echo ""

# ------------------------------------------
# Upload Scripts
# ------------------------------------------
echo "[1/5] Uploading scripts..."
scp "$SCRIPT_DIR/setup-openclaw.sh" root@"$VPS_IP":/opt/brain-server/setup-openclaw.sh
scp "$SCRIPT_DIR/setup-claude.sh" root@"$VPS_IP":/opt/brain-server/setup-claude.sh
echo "  ✅ Scripts uploaded"

# ------------------------------------------
# Upload Docker Compose
# ------------------------------------------
echo ""
echo "[2/5] Uploading docker-compose..."
scp "$SCRIPT_DIR/openclaw-standalone.yml" root@"$VPS_IP":/opt/brain-server/openclaw-standalone.yml
echo "  ✅ Docker compose uploaded"

# ------------------------------------------
# Run OpenClaw Setup
# ------------------------------------------
echo ""
echo "[3/5] Running OpenClaw setup..."
ssh root@"$VPS_IP" "MINIMAX_API_KEY='$MINIMAX_API_KEY' bash /opt/brain-server/setup-openclaw.sh"
echo "  ✅ OpenClaw installed"

# ------------------------------------------
# Run Claude Setup
# ------------------------------------------
echo ""
echo "[4/5] Running Claude Code setup..."
ssh root@"$VPS_IP" "ANTHROPIC_API_KEY='$ANTHROPIC_API_KEY' bash /opt/brain-server/setup-claude.sh"
echo "  ✅ Claude Code installed"

# ------------------------------------------
# Start Docker Compose
# ------------------------------------------
echo ""
echo "[5/5] Starting Docker containers..."
ssh root@"$VPS_IP" "cd /opt/brain-server && \
    MINIMAX_API_KEY='$MINIMAX_API_KEY' \
    ANTHROPIC_API_KEY='$ANTHROPIC_API_KEY' \
    docker-compose -f openclaw-standalone.yml up -d"
echo "  ✅ Containers started"

# ------------------------------------------
# Done!
# ------------------------------------------
echo ""
echo "=========================================="
echo "  ✅ Deployment Complete!"
echo "=========================================="
echo ""
echo "  Access OpenClaw:"
echo "    http://$VPS_IP:18789/web"
echo "    http://$VPS_IP:18789/health"
echo ""
echo "  Test with CLI:"
echo "    ssh root@$VPS_IP 'openclaw agent --message \"What is 2+2?\"'"
echo ""
echo "  Run tests:"
echo "    ./test-openclaw.sh $VPS_IP"
echo ""
