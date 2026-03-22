# Brain Server + OpenClaw Setup Plan

## Status: ✅ IMPLEMENTED

## Overview

Add OpenClaw to brain-server for intelligent model routing:

- **Default model**: `minimax-coding-plan/MiniMax-M2.7-highspeed` (fast, cheap) for simple tasks
- **Complex tasks**: Route to Claude Code (uses `anthropic/claude-opus-4-6`)

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Brain Server (VPS)                      │
│                                                              │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐  │
│  │   Brain      │    │   Ollama     │    │  OpenClaw    │  │
│  │ (context+)   │    │  (gemma2)    │    │  (gateway)   │  │
│  └──────────────┘    └──────────────┘    └──────┬───────┘  │
│                                                  │           │
│                                                  │           │
│                                       ┌──────────▼────────┐  │
│                                       │  Claude Code MCP  │  │
│                                       │  (on-demand)     │  │
│                                       └──────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                            ↑
                    User ←→ WebChat/Chat
```

## Phases

---

## Phase 1: Install OpenClaw on VPS

**Files to create/modify:**

- `/opt/brain-server/setup-openclaw.sh` - Installation script
- `/opt/brain-server/openclaw-compose.yml` - Add OpenClaw to docker-compose

**Tasks:**

1. Create installation script for Node 22 + OpenClaw
2. Add OpenClaw container to docker-compose
3. Configure workspace directory
4. Set up Tailscale access

**Verification:**

```bash
curl -sf http://<TAILSCALE_IP>:18789/health
```

---

## Phase 2: Configure Primary Model (MiniMax)

**Files to create/modify:**

- `~/.openclaw/openclaw.json` - OpenClaw config on VPS

**Tasks:**

1. Configure primary model (MiniMax-M2.7-highspeed for fast/cheap tasks)
2. Set up workspace directory at `/opt/openclaw-workspace`
3. Configure tool allowlist

**Config structure:**

```json5
{
  agents: {
    defaults: {
      workspace: '/opt/openclaw-workspace',
      model: {
        primary: 'minimax-coding-plan/MiniMax-M2.7-highspeed',
        fallbacks: ['anthropic/claude-sonnet-4-6'],
      },
    },
  },
}
```

**Note:** MiniMax requires API key configuration in OpenClaw. Fallback to Sonnet if MiniMax is unavailable.

**Verification:**

```bash
openclaw gateway call sessions.create --params '{"message": "test"}'
```

---

## Phase 3: Create Claude Delegation Skill

**Files to create/modify:**

- `/opt/openclaw-workspace/skills/claude-delegation/SKILL.md`

**Tasks:**

1. Create skill directory
2. Write skill that instructs OpenClaw when to delegate to Claude Code (Opus 4-6)
3. Define trigger patterns (git analysis, code debugging, refactoring)

**Skill content:**

```
When user asks for:
- "analyze this code" / "find the bug" / "debug this"
- git history, diffs, blame, what changed
- complex refactoring, improve this code
- "where is X used" / find function / code search
- anything requiring deep code understanding

Use exec tool to call Claude Code (which uses Opus 4-6):
{"tool": "exec", "command": "claude -p --print --dangerously-skip-permissions \"<user question>\"", "workdir": "/repo"}
```

**Key:** Claude Code uses `anthropic/claude-opus-4-6` by default for complex tasks.

**Verification:**

```bash
# Simple question → MiniMax answers
openclaw agent --message "What is 2+2?"

# Complex coding → Claude Code (Opus) answers
openclaw agent --message "Find all unused exports in this codebase"
```

---

## Phase 4: Set Up Claude Code on VPS

**Files to create/modify:**

- `/opt/brain-server/setup-claude.sh` - Installation script
- SSH config for headless Claude auth

**Tasks:**

1. Install Claude Code on VPS
2. Set up authentication token (`claude setup-token`)
3. Configure allowed directories (`/repo` for codebase access)
4. Test Claude CLI works

**Verification:**

```bash
claude -p --print "Hello" --dangerously-skip-permissions
```

---

## Phase 5: Test Suite

**Test categories:**

### A. Basic OpenClaw

```bash
# 1. OpenClaw gateway starts
curl -sf http://<IP>:18789/health

# 2. Can chat via WebChat
open http://<IP>:18789/web/chat

# 3. Simple question answered (MiniMax)
openclaw agent --message "What is 2+2?"
```

### B. Model Routing

```bash
# 4. MiniMax answers simple questions
openclaw agent --message "What's the capital of France?"

# 5. Complex task triggers delegation to Claude Code (Opus)
openclaw agent --message "Find all functions in /repo that use database queries"
```

### C. Claude Delegation

```bash
# 6. Claude Code (Opus 4-6) invoked for complex task
openclaw agent --message "Analyze the git diff and tell me what changed"

# 7. Claude Code used for code search
openclaw agent --message "Where is the auth function defined?"
```

### D. Persistence

```bash
# 8. Claude session stays warm (if using MCP serve)
# 9. OpenClaw handles multiple concurrent requests
```

---

## Files to Create

| File                         | Purpose                       |
| ---------------------------- | ----------------------------- |
| `setup-openclaw.sh`          | Install OpenClaw on VPS       |
| `openclaw-compose.yml`       | Docker compose for OpenClaw   |
| `claude-delegation/SKILL.md` | Skill for routing to Claude   |
| `setup-claude.sh`            | Install Claude Code on VPS    |
| `openclaw.env`               | Environment vars for OpenClaw |
| `test-openclaw.sh`           | Test script                   |

---

## Timeline

| Phase                     | Estimated Time |
| ------------------------- | -------------- |
| Phase 1: OpenClaw Install | 5 min          |
| Phase 2: Model Config     | 5 min          |
| Phase 3: Delegation Skill | 10 min         |
| Phase 4: Claude Setup     | 10 min         |
| Phase 5: Tests            | 15 min         |

**Total: ~45 minutes**

---

## Prerequisites

- [x] VPS with Docker running
- [x] Tailscale connected
- [ ] GitHub PAT for repo access
- [ ] MiniMax API key (for default fast model)
- [ ] Anthropic API key (for Opus fallback / Claude Code)
- [ ] Claude Code auth on VPS (`claude setup-token`)

---

## Next Step

Should I implement this plan? I'll start with:

1. `setup-openclaw.sh` - Install script
2. `openclaw-compose.yml` - Docker compose addition
3. `claude-delegation/SKILL.md` - Delegation skill
