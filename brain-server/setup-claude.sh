#!/bin/bash
set -euo pipefail

# =============================================================================
# Claude Code Setup for Brain Server
#
# Usage:
#   scp setup-claude.sh root@<SERVER_IP>:/opt/brain-server/
#   ssh root@<SERVER_IP> bash /opt/brain-server/setup-claude.sh
# =============================================================================

echo "=========================================="
echo "  Claude Code Setup for Brain Server"
echo "=========================================="

# ------------------------------------------
# Step 1: Check Node.js
# ------------------------------------------
echo ""
echo "[1/4] Checking Node.js..."

if ! command -v node &>/dev/null; then
    echo "  ❌ Node.js not found. Install Node 22 first:"
    echo "     curl -fsSL https://deb.nodesource.com/setup_22.x | bash -"
    echo "     apt-get install -y nodejs"
    exit 1
fi

echo "  ✅ Node.js $(node --version) found"

# ------------------------------------------
# Step 2: Install Claude Code
# ------------------------------------------
echo ""
echo "[2/4] Installing Claude Code..."

if command -v claude &>/dev/null; then
    echo "  Claude already installed: $(claude --version 2>/dev/null || echo 'unknown')"
else
    npm install -g claude-code@latest 2>&1 | tail -3
    echo "  ✅ Claude Code installed"
fi

# ------------------------------------------
# Step 3: Configure Claude Code
# ------------------------------------------
echo ""
echo "[3/4] Configuring Claude Code..."

# Create Claude config directory
mkdir -p /root/.claude

# Configure allowed directories
cat > /root/.claude/config.json << 'EOF'
{
  "allowedDirectories": ["/repo", "/opt/openclaw-workspace", "/root"]
}
EOF

# Set up environment for headless operation
cat >> /root/.bashrc << 'EOF'

# Claude Code aliases
alias claude-headless='claude --dangerously-skip-permissions'
alias claude-mcp='claude mcp serve'
EOF

echo "  ✅ Claude Code configured"

# ------------------------------------------
# Step 4: Test Installation
# ------------------------------------------
echo ""
echo "[4/4] Testing Claude Code..."

# Test basic invocation (without API key, may fail auth but proves CLI works)
if claude --version &>/dev/null; then
    echo "  ✅ Claude Code CLI works"
    echo ""
    echo "  ⚠️  Next: Set up authentication"
    echo "      Run: claude setup-token"
    echo "      Or set ANTHROPIC_API_KEY environment variable"
else
    echo "  ❌ Claude Code CLI test failed"
    exit 1
fi

# ------------------------------------------
# Done!
# ------------------------------------------
echo ""
echo "=========================================="
echo "  ✅ Claude Code Setup Complete!"
echo "=========================================="
echo ""
echo "  To use Claude Code:"
echo "  1. Set ANTHROPIC_API_KEY env var:"
echo "     export ANTHROPIC_API_KEY=sk-..."
echo ""
echo "  2. Test it works:"
echo "     claude -p --print 'Hello' --dangerously-skip-permissions"
echo ""
echo "  3. Start MCP server (optional, for persistent session):"
echo "     claude mcp serve &"
echo ""
echo "  Note: Claude Code uses Opus 4-6 by default for complex tasks"
echo ""
