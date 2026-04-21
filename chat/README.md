# brain-chat

Multi-turn agent chat server. One `POST` per user message, streams agent events back over SSE, keeps conversation memory per `chatId` using Claude Agent SDK session resume, isolates work per chat via git worktrees on a shared bare clone.

Built to be consumed by a separate frontend (e.g. Vercel) — this is API only.

## What it does

| Problem | Solution |
|---|---|
| Agent forgets between HTTP requests | SDK session jsonl on disk, resumed by `chatId` |
| Concurrent chats can't share one repo checkout | Shared bare clone + per-chat worktree |
| Cloning a full repo per chat is slow | Bare clone once, worktrees are seconds |
| Auth on a public URL | Shared-secret `X-Api-Key` header |

## Architecture

```
Client (Vercel / curl / CLI)
  │  POST /chats/:id/messages   (X-Api-Key: …)
  ▼
chat-server (Node, :4101)
  ├── per-chatId queue (serializes turns)
  ├── workspace: $DATA_DIR/workspaces/<chatId>/repo  (git worktree)
  ├── state:     $DATA_DIR/chats/<chatId>/state.json (sessionId, repo, cwd)
  └── query(prompt, { resume: sessionId, cwd, tools })
      │
      ▼ SSE stream (text | tool_use | done | error)
```

Shared bare clone lives at `$DATA_DIR/repos/<owner>__<name>.git`. First chat against a repo clones it; subsequent chats fetch + `git worktree add`.

## API

All endpoints require `X-Api-Key: <BRAIN_API_KEY>` except `/health`.

### `GET /health`
```json
{"status":"ok","model":"claude-sonnet-4-5","dataDir":"/opt/brain/chat-data"}
```

### `POST /chats/:chatId/messages`
Request:
```json
{"message":"What's in package.json?"}
```
Response: `text/event-stream`, one `data: {...}` per line. Event types:
- `{"type":"chat","chatId":"..."}` — first event, confirms the active chat.
- `{"type":"text","text":"..."}` — assistant text (may be partial).
- `{"type":"tool_use","name":"Read","input":{...}}` — agent called a tool.
- `{"type":"done","text":"<final>"}` — turn finished.
- `{"type":"error","error":"..."}` — something failed.

### `POST /chats/:chatId/reset`
Wipes the chat's state.json and worktree. Next message starts a fresh session.

## Environment

All set via `.env` (loaded by systemd `EnvironmentFile=`):

| Var | Default | Purpose |
|---|---|---|
| `BRAIN_API_KEY` | — (required) | Shared secret clients must send. |
| `BRAIN_DATA_DIR` | `$HOME/tmp/brain-test` | Where repos, worktrees, and state live. |
| `BRAIN_DEFAULT_REPO` | `A-Guy-educ/A-Guy` | GitHub repo cloned for each chat. |
| `BRAIN_MODEL` | `claude-sonnet-4-5` | Claude model id. |
| `PORT` | `4101` | HTTP listen port. |
| `ANTHROPIC_API_KEY` | — | Used by the SDK if Claude OAuth is absent/expired. |

Server is read-only by design: allowed tools are `Read, Grep, Glob, Bash`. No `Edit`/`Write`.

## Local dev

```bash
cd chat/
npm install
BRAIN_API_KEY=$(openssl rand -hex 24) node server.js
# In another terminal:
BRAIN_API_KEY=<same> node cli.js      # interactive chat loop
```

## Deploy to the Brain VPS

```bash
./deploy.sh
```

Idempotent — safe to re-run. On first run it generates and prints `BRAIN_API_KEY`; preserves it thereafter. Installs systemd unit `brain-chat.service`, restarts the service, health-checks.

Env overrides:
```bash
VPS_HOST=root@vmi3163639 DEFAULT_REPO=org/repo PORT=4101 ./deploy.sh
```

## Public access (Tailscale Funnel)

Brain is Tailscale-only by default. To expose the chat API publicly (e.g. for Vercel):

```bash
ssh root@vmi3163639 'tailscale funnel --bg 4101'
```

Public URL: `https://vmi3163639.<tailnet>.ts.net`

The `X-Api-Key` check is the only thing gating access once Funnel is on — keep that key long and random.

## Smoke test (end-to-end)

```bash
KEY=<your-BRAIN_API_KEY>
URL=https://vmi3163639.<tailnet>.ts.net

curl -sf "$URL/health"

CHAT="smoke-$(date +%s)"

# Turn 1: seed memory
curl -N -H "X-Api-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"message":"Remember: 42197. Reply only: ok"}' \
  "$URL/chats/$CHAT/messages"

# Turn 2: recall (should echo 42197)
curl -N -H "X-Api-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"message":"What number did I ask you to remember?"}' \
  "$URL/chats/$CHAT/messages"

# Turn 3: repo-aware
curl -N -H "X-Api-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"message":"What is the package name in package.json?"}' \
  "$URL/chats/$CHAT/messages"
```

## Ops

```bash
ssh root@vmi3163639 'journalctl -u brain-chat -f'          # logs
ssh root@vmi3163639 'systemctl restart brain-chat'         # restart
ssh root@vmi3163639 'tailscale funnel status'              # funnel state
ssh root@vmi3163639 'ls /opt/brain/chat-data/chats/'       # active chats
```

## Gotchas learned

- **Port 4096 is taken** on the VPS by an existing `token-manager`. We use 4101.
- **`libc` variant**: Ubuntu is glibc but the SDK optional dep for `linux-x64-musl` gets installed too and is picked first. `deploy.sh` removes it post-install.
- **`rsync --delete`** will wipe `.env` unless excluded — `deploy.sh` excludes it so `BRAIN_API_KEY` is preserved across deploys.
- **Claude OAuth on the VPS** was expired. Service falls back to `ANTHROPIC_API_KEY` pulled from the existing `/opt/brain-server/.env`.
- **gh auth on the VPS** must match an account that can read the target repo (or the repo must be public / invite the VPS's GH account as collaborator).
- **Branch collisions**: per-chat worktrees use a sanitized full `chatId` as the local branch name; don't shorten.

## Files

- [server.js](server.js) — HTTP + SSE, worktree + session plumbing.
- [cli.js](cli.js) — terminal chat client for manual testing.
- [deploy.sh](deploy.sh) — idempotent VPS deploy.
- [package.json](package.json) — one runtime dep: `@anthropic-ai/claude-agent-sdk`.
