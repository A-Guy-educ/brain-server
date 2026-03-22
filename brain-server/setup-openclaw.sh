#!/bin/bash
set -euo pipefail

# =============================================================================
# OpenClaw Setup for Brain Server
#
# Usage:
#   scp setup-openclaw.sh root@<SERVER_IP>:/opt/brain-server/
#   ssh root@<SERVER_IP> bash /opt/brain-server/setup-openclaw.sh
# =============================================================================

echo "=========================================="
echo "  OpenClaw Setup for Brain Server"
echo "=========================================="

# ------------------------------------------
# Step 1: Install Node 22
# ------------------------------------------
echo ""
echo "[1/5] Installing Node.js 22..."

if command -v node &>/dev/null; then
    NODE_VERSION=$(node --version)
    echo "  Node already installed: $NODE_VERSION"
else
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - > /dev/null 2>&1
    apt-get install -y -qq nodejs > /dev/null 2>&1
    echo "  ✅ Node.js $(node --version) installed"
fi

# ------------------------------------------
# Step 2: Install OpenClaw
# ------------------------------------------
echo ""
echo "[2/5] Installing OpenClaw..."

if command -v openclaw &>/dev/null; then
    echo "  OpenClaw already installed: $(openclaw --version 2>/dev/null || echo 'unknown')"
else
    npm install -g openclaw@latest > /dev/null 2>&1
    echo "  ✅ OpenClaw installed"
fi

# ------------------------------------------
# Step 3: Create OpenClaw workspace
# ------------------------------------------
echo ""
echo "[3/5] Creating OpenClaw workspace..."

mkdir -p /opt/openclaw-workspace
mkdir -p /opt/openclaw-workspace/skills/claude-delegation

# Create bootstrap files
cat > /opt/openclaw-workspace/AGENTS.md << 'EOF'
# OpenClaw Agent Instructions

You are a helpful assistant running on the brain server.

## Your Role

- Answer simple questions directly using MiniMax (fast, cheap)
- For complex coding tasks, delegate to Claude Code (uses Opus 4-6)

## When to Delegate to Claude Code

Use the `claude-delegation` skill for complex tasks:
- Code analysis, debugging, refactoring
- Git history, diffs, blame
- "Where is X used" / code search
- Anything requiring deep code understanding

## Quick Commands

- `/new` or `/reset` — reset the session
- `/compact` — compact session context
EOF

cat > /opt/openclaw-workspace/SOUL.md << 'EOF'
# Soul

You are a helpful, efficient assistant. You prioritize speed and clarity.
You delegate complex coding tasks to Claude Code when appropriate.
EOF

cat > /opt/openclaw-workspace/IDENTITY.md << 'EOF'
# Identity

Name: Brain Assistant
Emoji: 🧠
Tone: Helpful, concise, practical
EOF

echo "  ✅ Workspace created at /opt/openclaw-workspace"

# ------------------------------------------
# Step 4: Configure OpenClaw
# ------------------------------------------
echo ""
echo "[4/5] Configuring OpenClaw..."

# Get MiniMax API key
MINIMAX_API_KEY="${MINIMAX_API_KEY:-}"
if [ -z "$MINIMAX_API_KEY" ]; then
    echo "  ⚠️  MINIMAX_API_KEY not set. Using placeholder."
    echo "  Set it with: export MINIMAX_API_KEY=your_key"
fi

# Create OpenClaw config
cat > /root/.openclaw/openclaw.json << EOF
{
  gateway: {
    port: 18789,
    bind: "loopback",
  },
  agents: {
    defaults: {
      workspace: "/opt/openclaw-workspace",
      model: {
        primary: "minimax-coding-plan/MiniMax-M2.7-highspeed",
        fallbacks: ["anthropic/claude-sonnet-4-6"],
      },
    },
  },
  models: {
    providers: {
      minimax: {
        apiKey: "${MINIMAX_API_KEY:-not-set}",
      },
    },
  },
  skills: {
    entries: {
      "claude-delegation": {
        enabled: true,
      },
    },
  },
}
EOF

echo "  ✅ Config written to ~/.openclaw/openclaw.json"

# ------------------------------------------
# Step 5: Install Claude Delegation Skill
# ------------------------------------------
echo ""
echo "[5/6] Installing Claude Delegation skill..."

cat > /opt/openclaw-workspace/skills/claude-delegation/SKILL.md << 'EOF'
# Claude Code Delegation Skill

## Purpose

Delegate complex coding tasks to Claude Code, which uses Opus 4-6 for deep code analysis.

## Trigger Patterns

Delegate to Claude Code when user asks for:

- **Code Analysis**: "analyze this code", "what does this function do", "explain this"
- **Debugging**: "find the bug", "debug this", "why is this broken"
- **Git Operations**: "git history", "git diff", "git blame", "what changed"
- **Code Search**: "where is X used", "find all functions that...", "search for..."
- **Refactoring**: "refactor this", "improve this code", "clean up"
- **Complex Changes**: "implement feature X", "add support for Y"

## How to Delegate

Use the `exec` tool to call Claude Code:

```json
{
  "tool": "exec",
  "command": "claude -p --print --dangerously-skip-permissions \"<user question>\" --workdir /repo",
  "workdir": "/repo",
  "timeout": 120
}
```

## Important Notes

- Claude Code has full access to the /repo directory
- Use `--dangerously-skip-permissions` for headless operation
- Set `--workdir /repo` to analyze the correct codebase
- Timeout of 120 seconds for complex operations

## Examples

**User asks**: "Find all unused functions in the codebase"

**Delegate with**:
```json
{
  "tool": "exec",
  "command": "claude -p --print --dangerously-skip-permissions \"Find all unused/exported functions in this codebase\" --workdir /repo",
  "workdir": "/repo"
}
```

**User asks**: "What changed in the last commit?"

**Delegate with**:
```json
{
  "tool": "exec",
  "command": "claude -p --print --dangerously-skip-permissions \"What changed in the last git commit?\" --workdir /repo",
  "workdir": "/repo"
}
```
EOF

echo "  ✅ Claude delegation skill installed"

# ------------------------------------------
# Step 6: Create claude user for Claude Code
# ------------------------------------------
echo ""
echo "[6/6] Creating claude user for Claude Code..."

id claude &>/dev/null || useradd -m -s /bin/bash claude
echo "claude ALL=(ALL) NOPASSWD: ALL" >> /etc/sudoers

# Install Claude Code for claude user
sudo -u claude -i npm install -g claude-code@latest 2>&1 | tail -3

echo "  ✅ Claude user created"

# ------------------------------------------
# Done!
# ------------------------------------------
echo ""
echo "=========================================="
echo "  ✅ OpenClaw Setup Complete!"
echo "=========================================="
echo ""
echo "  Next steps:"
echo "  1. Run: openclaw onboard --install-daemon"
echo "  2. Or run directly: openclaw gateway --port 18789"
echo ""
echo "  Web UI: http://<tailscale_ip>:18789/web"
echo "  Health: http://<tailscale_ip>:18789/health"
echo ""
echo "  To test:"
echo "    openclaw agent --message 'What is 2+2?'"
echo ""
