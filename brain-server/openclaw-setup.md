# OpenClaw Setup on brain-server

**Date:** 2026-03-22
**Server:** brain-server (VPS at 100.66.248.120)
**Public URL:** https://vmi3163639.tailec1a59.ts.net

---

## Overview

OpenClaw is installed on brain-server as an AI agent gateway that:
- Provides a web UI for chatting with AI models
- Uses MiniMax M2.7-highspeed as the default model
- Routes through Caddy proxy with Basic Auth
- Accessible via Tailscale Funnel

---

## Architecture

```
Internet → Tailscale Funnel (443) → Caddy (18790) → OpenClaw Gateway (18789)
                                                        ↓
                                              MiniMax API (api.minimax.io)
```

---

## Components

### 1. OpenClaw Gateway

**Port:** 18789
**Auth Mode:** Token-based (`test_token_12345`)
**Workspace:** `/opt/openclaw-workspace`

Start command: `openclaw gateway`

### 2. Caddy Reverse Proxy

**Port:** 18790
**Purpose:** HTTP Basic Auth protection
**Credentials:** `admin` / `brain123`

### 3. Tailscale Funnel

**Public URL:** https://vmi3163639.tailec1a59.ts.net
**Port:** 443 (Funnel)

---

## Configuration Files

### `/root/.openclaw/openclaw.json`

```json
{
  "gateway": {
    "port": 18789,
    "mode": "local",
    "bind": "loopback",
    "auth": {
      "mode": "token",
      "token": "test_token_12345"
    },
    "controlUi": {
      "allowedOrigins": ["*"]
    }
  },
  "agents": {
    "defaults": {
      "workspace": "/opt/openclaw-workspace",
      "model": {
        "primary": "minimax/MiniMax-M2.7-highspeed"
      }
    }
  },
  "models": {
    "providers": {
      "minimax": {
        "baseUrl": "https://api.minimax.io/anthropic",
        "api": "anthropic-messages",
        "authHeader": true,
        "models": [
          {
            "id": "MiniMax-M2.7-highspeed",
            "name": "MiniMax M2.7 Highspeed",
            "reasoning": true,
            "input": ["text"],
            "cost": { "input": 0.3, "output": 1.2, "cacheRead": 0.03, "cacheWrite": 0.12 },
            "contextWindow": 200000,
            "maxTokens": 8192
          }
        ],
        "apiKey": "MINIMAX_API_KEY"
      }
    }
  },
  "skills": {
    "entries": {
      "claude-delegation": {
        "enabled": true
      }
    }
  }
}
```

### `/root/.openclaw/agents/main/agent/auth-profiles.json`

```json
{
  "minimax": {
    "apiKey": "MINIMAX_API_KEY"
  }
}
```

**Note:** The API key is read from the `MINIMAX_API_KEY` environment variable, which is set in the systemd service.

### `/etc/systemd/system/openclaw-gateway.service`

```ini
[Unit]
Description=OpenClaw Gateway
After=network.target

[Service]
Type=simple
User=root
Environment=MINIMAX_API_KEY=sk-cp-MlLWB-r2xxxsoUCugSia0GW2qBmU4G5oSiG1FDN2dLezbYDvklaahxSL0k2nfI4Woua7mOBoKzTghNRVaU2wF7kZh_hxQPZIzMqR5T8e_UsFShU2O_tvDHc
ExecStart=/usr/bin/openclaw gateway
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

### `/etc/caddy/Caddyfile`

```
:18790 {
    basic_auth {
        admin $2a$14$5ahdRDngCQOwErKrCbJtreqdHjft.2A/4FJu/.kGGSQbpLKsJv0Bq
    }
    reverse_proxy localhost:18789
}
```

---

## Key Learnings / Troubleshooting

### 1. Model Name Issue

**Problem:** `minimax-coding-plan/MiniMax-M2.7-highspeed` was not recognized by OpenClaw.

**Cause:** `minimax-coding-plan` is an OpenCode.ai provider name, NOT an OpenClaw provider. OpenClaw uses `minimax` as the provider.

**Solution:** Use `minimax/MiniMax-M2.7-highspeed` instead.

### 2. Custom Model Registration

**Problem:** OpenClaw didn't know about `MiniMax-M2.7-highspeed` model.

**Solution:** Add the model to `models.providers.minimax.models` in `openclaw.json`.

### 3. Auth Not Being Read

**Problem:** OpenClaw kept saying "No API key found for provider minimax".

**Cause:** The `auth-profiles.json` with `minimax-coding-plan` key wasn't being picked up.

**Solution:** 
- Use `minimax` as provider name in auth-profiles.json
- Set the actual API key in the `MINIMAX_API_KEY` environment variable
- OpenClaw reads env vars for auth

### 4. Caddy Basic Auth Hash

**Problem:** Caddy requires bcrypt hash, not plaintext password.

**Solution:** Generate hash with: `caddy hash-password --plaintext brain123 --algorithm bcrypt`

### 5. API BaseURL

**Problem:** Got "HTTP 404: 404 page not found" when using wrong baseUrl.

**Solution:** Use `https://api.minimax.io/anthropic` for MiniMax provider (not `api.minimaxi.chat`).

---

## Commands

### Start/Restart Gateway
```bash
systemctl restart openclaw-gateway
systemctl status openclaw-gateway
```

### Check Model Status
```bash
openclaw models status
openclaw models list
```

### Test Chat (CLI)
```bash
openclaw agent --session-id test123 --message 'Say hello in 3 words' --json
```

### View Logs
```bash
tail -f /tmp/openclaw/openclaw-2026-03-22.log
journalctl -u openclaw-gateway -f
```

### Reload Caddy
```bash
caddy reload --config /etc/caddy/Caddyfile
```

---

## Files Summary

| File | Purpose |
|------|---------|
| `/root/.openclaw/openclaw.json` | Main OpenClaw config (model, gateway, skills) |
| `/root/.openclaw/agents/main/agent/auth-profiles.json` | API key references |
| `/root/.openclaw/agents/main/agent/models.json` | Custom model definitions (if separate) |
| `/etc/systemd/system/openclaw-gateway.service` | Systemd service with env vars |
| `/etc/caddy/Caddyfile` | Reverse proxy with Basic Auth |
| `/opt/openclaw-workspace/` | Workspace for sessions and files |

---

## TODO

- [ ] Connect chat storage to Supabase
- [ ] Set up Claude Code delegation for complex tasks
- [ ] Add more models as fallbacks
- [ ] Configure proper backup strategy

---

## Credentials

| Service | Username | Password |
|---------|----------|----------|
| OpenClaw Web UI | admin | brain123 |
| Tailscale Funnel | (none) | (via HTTPS) |

**Gateway Token:** `test_token_12345`

**MiniMax API Key:** Set in systemd environment (not shown for security)
