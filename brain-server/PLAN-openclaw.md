# Brain Server + OpenClaw Setup Plan

## Status: ✅ IMPLEMENTED

> **Implementation details:** See [openclaw-setup.md](./openclaw-setup.md)

## Overview

Add OpenClaw to brain-server for intelligent model routing:

- **Default model**: `minimax/MiniMax-M2.7-highspeed` (fast, cheap) for simple tasks
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

## Completed Items

- [x] Install OpenClaw on VPS
- [x] Configure MiniMax M2.7-highspeed model
- [x] Set up Caddy proxy with Basic Auth
- [x] Configure Tailscale Funnel
- [x] Test chat working

## TODO

- [ ] Connect chat storage to Supabase (see [PLAN-openclaw-memory.md](./PLAN-openclaw-memory.md))
- [ ] Set up Claude Code delegation for complex tasks
- [ ] Add more models as fallbacks
- [ ] Configure proper backup strategy

## Model Name Issue (Learned)

**Important:** OpenClaw uses `minimax` as the provider name, NOT `minimax-coding-plan`.

- ❌ Wrong: `minimax-coding-plan/MiniMax-M2.7-highspeed`
- ✅ Correct: `minimax/MiniMax-M2.7-highspeed`

## Files

| File                      | Purpose                      |
| ------------------------- | ---------------------------- |
| `openclaw-setup.md`       | Detailed setup documentation |
| `PLAN-openclaw-memory.md` | Plan for Supabase sync       |
