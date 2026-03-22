# Plan: Connect OpenClaw to Brain Memory (OB1/Supabase)

## Brain's Purpose

**Brain Server** provides code analysis via MCP - tools like `brain_ask`, `get_blast_radius`, `semantic_search` using Claude Opus 4.6 + Context+.

**OB1 (Personal Brain)** stores user context/thoughts in Supabase with embeddings for semantic search. Any AI can read/write to it via MCP.

The goal is to sync OpenClaw chat sessions to OB1's Supabase so that `brain_ask` queries can benefit from context stored in OpenClaw conversations.

---

## Architecture

```
OpenClaw Chat → Session Files → Sync Script → Supabase (thoughts table)
                                              ↓
                                    Semantic Search via OB1
                                              ↓
                                    brain_ask gets context
```

---

## Session Storage

OpenClaw sessions are stored at:

```
/opt/openclaw-workspace/sessions/
```

Format: JSON with messages array containing role/content pairs.

**Need to verify:** SSH to VPS and check actual session JSON format.

---

## Sync Strategy

### Recommended: Each Session = One Thought

Each OpenClaw session becomes one "thought" in OB1:

- Extract all user/assistant messages combined into text
- Generate one embedding per session
- Store in `thoughts` table with metadata

```sql
-- Session stored as thought
INSERT INTO thoughts (content, metadata) VALUES (
  'OpenClaw Session:\nUser: What did I work on today?\nAssistant: You worked on X...\nUser: Tell me more about Y...',
  '{"source": "openclaw", "session_id": "xxx", "message_count": 6}'
);
```

### Alternative: Per-Message Thoughts

Split each user/assistant exchange into separate thoughts (higher granularity, more embeddings).

**Recommendation:** Start with per-session (simpler, good for context).

---

## Implementation

### 1. Explore Session Format

```bash
ssh root@100.66.248.120
ls /opt/openclaw-workspace/sessions/
cat /opt/openclaw-workspace/sessions/*.json | head -200
```

### 2. Create Sync Script

**File:** `/opt/openclaw-workspace/sync-to-ob1.js`

- Read session files from `/opt/openclaw-workspace/sessions/`
- Track last-synced session ID in `/opt/openclaw-workspace/.last_synced_session`
- Extract messages, combine into text content
- Generate embedding via OpenRouter
- Insert into Supabase `thoughts` table
- Update last-synced marker

### 3. Environment Variables

Add to brain-server:

```bash
SUPABASE_URL=https://jmdccivoxtiumrpsujwg.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<key>
OPENROUTER_API_KEY=<key>
```

### 4. Cron Job

Run sync every 5 minutes:

```bash
*/5 * * * * node /opt/openclaw-workspace/sync-to-ob1.js >> /var/log/openclaw-sync.log 2>&1
```

---

## Files to Create

| File                                           | Purpose                  |
| ---------------------------------------------- | ------------------------ |
| `/opt/openclaw-workspace/sync-to-ob1.js`       | Node.js sync script      |
| `/opt/openclaw-workspace/.last_synced_session` | Marker file for tracking |

---

## Questions

1. **Session format** - Need to SSH and verify actual JSON structure
2. **Per-session or per-message?** - Recommend per-session first
3. **Which Supabase project?** - OB1's existing project?

---

## TODO

- [ ] Explore OpenClaw session file format (SSH to VPS)
- [ ] Create sync-to-ob1.js script
- [ ] Test Supabase insert
- [ ] Add cron job
- [ ] Test semantic search works
