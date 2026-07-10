# 006 — Chat Persistence

## Context

Extracted from `003-m2-smoke-test.md` §4. This is where the smoke test actually starts capturing demand signal — every message a stranger sends and every reply the model streams back gets a row in `messages`, attributed to a session via 005's cookie.

**Why this is Task #6 and not Task #5** (rate-limits): the persistence path is the *whole point* of the smoke test — without it we're just paying OpenRouter to have anonymous chats evaporate. Rate-limits are a cost guardrail, important but secondary. Doing persistence first also gives us data to observe *while* deciding rate-limit thresholds empirically in Task #5.

**Rate-limit check deferred:** the doc §4 says "Rate-limit check — early return 429 if exceeded." That comes in Task #5. This task leaves a clean insertion point.

## Scope

**In:**
- Extract the new user message from `body.messages` (last entry, must be role='user')
- Atomically: INSERT user row, UPDATE `sessions.message_count`+`last_seen_at`, INSERT `message_sent` event
- Tee upstream SSE: relay chunks to client (unchanged UX) + accumulate assistant deltas server-side
- Finally-block INSERT assistant row on stream end — fires on both natural completion and client abort
- Cancel upstream reader on client abort (cost savings)

**Out:**
- Per-session and per-IP rate limits (Task #5)
- Persona upgrade to full persona card (Task #6 in the M2 doc)
- Server-side validation of full message history (client is source of truth for conversation state at M2)

## Approach

### 1. Order of operations in the handler

```
1. apiKey check (unchanged)
2. body parse (unchanged)
3. getOrCreateSession — from Task #3, returns { session, setCookieHeader? }
4. Validate last body.messages entry is a non-empty user message → 400 if not
5. Persist user turn (transaction):
     INSERT INTO messages (sessionId, role='user', content=<last msg>)
     UPDATE sessions SET message_count = message_count + 1, last_seen_at = now() WHERE id = session.id
     INSERT INTO events (sessionId, kind='message_sent', meta={role:'user'})
6. Upstream fetch to OpenRouter (streaming as today)
7. If upstream fails: return error passthrough with Set-Cookie
8. Build a ReadableStream that:
     - Reads chunks from upstream
     - Passes them to the client
     - Parses SSE deltas server-side, accumulates into `assistantBuffer`
     - On loop end (natural or cancelled): INSERT assistant row
9. Return Response(stream) with SSE headers + Set-Cookie
```

### 2. Tee-stream pattern

The tricky part. Approach:

- `let cancelled = false` in outer closure
- `ReadableStream({ start, cancel })`:
  - `start(controller)`: get reader from upstream.body, loop reading, enqueue to controller, parse SSE for deltas into `assistantBuffer`. Loop exits on `done` or `cancelled`. Finally-block: cancel upstream reader (idempotent), INSERT assistant row (empty content is fine — represents drop-off).
  - `cancel()`: called by runtime when client disconnects. Sets `cancelled=true` and cancels upstream reader so `reader.read()` unblocks and the loop exits.

Node built-in Web Streams; no npm dep.

### 3. Persistence contract

- **User message:** exact string from `body.messages[body.messages.length - 1].content`.
- **Assistant message:** the *accumulated deltas we streamed to the client*, verbatim. If client aborts early, this may be a prefix of what OpenRouter would have sent — that's the intended drop-off signal.
- **`sessions.message_count`:** counts only user turns (not assistant replies), so it matches the rate-limit semantic ("50 messages per session").
- **`events`:** one `message_sent` row per user turn, `meta.role='user'`. Assistant-side events skipped to reduce write volume.

## Files touched

**Modified:**
- `src/routes/api/chat.ts` — full rewrite of the POST handler body

**Referenced (not modified):**
- `src/lib/session.ts` — `getOrCreateSession` from Task #3
- `src/db/index.ts` — `db` singleton from Task #2
- `src/db/schema.ts` — `sessions`, `messages`, `events` tables

## Verification

Dev server running:

1. Fresh cookie: `curl -X POST http://localhost:3000/api/chat -H 'Content-Type: application/json' -d '{"messages":[{"role":"user","content":"say hi"}]}' -c /tmp/c.txt --max-time 30 -o /tmp/r.txt`
2. `docker exec pillow-pg psql -U postgres -c 'SELECT role, content, model FROM messages ORDER BY created_at'` — expect one `user` row (content=`say hi`) and one `assistant` row (content=OpenRouter's reply, model=`anthracite-org/magnum-v4-72b`).
3. `psql -c 'SELECT message_count FROM sessions'` — expect `1`.
4. `psql -c 'SELECT kind, meta FROM events'` — expect one `message_sent` row with `meta.role='user'`.
5. **Second turn:** replay with cookie and appended history:
   `curl -X POST … -b /tmp/c.txt -d '{"messages":[{"role":"user","content":"say hi"},{"role":"assistant","content":"hi!"},{"role":"user","content":"how are you"}]}'`
   Expect: 4 messages rows total (2 user + 2 assistant), `message_count=2`, 2 event rows.
6. **Browser round-trip:** open http://localhost:3000, click through consent, send a message, watch tokens stream. `SELECT content FROM messages WHERE role='assistant' ORDER BY created_at DESC LIMIT 1;` shows the full reply.
7. **Drop-off simulation:** send a request with `--max-time 0.5` (aborts mid-stream). Check DB — assistant row present but content shorter than a normal reply. (Optional; hard to reliably trigger via curl.)

## Notes / deferred concerns

- **Server-side history reconciliation.** Client sends full history each turn; server only persists the *new* user turn. If client's copy of prior assistant replies drifts from what server captured (client aborted mid-stream on turn N), the two diverge. Server DB is source of truth for analytics; client display is source of truth for UX. Acceptable at M2.
- **Empty assistant content edge case.** If upstream 200s but never streams anything, or client aborts before first token, we insert an assistant row with `content=''`. Kept as a signal for analysis ("zero-response turns") rather than discarded.
- **`sessions.message_count` doesn't include assistant rows.** By design — it's a *user turn* counter, matching how "50 free messages" is understood.
- **Transaction failure.** If the user-turn transaction fails after we've already promised the session cookie in headers, the client gets an error 500 but keeps the cookie. Next request works normally. Acceptable — transaction failure at this scale is a bug, not a routine case.
- **Upstream cost on abort.** We cancel the upstream reader on client-abort, which closes the TCP connection to OpenRouter. OpenRouter should stop generating tokens shortly after. Not zero-cost — first tokens are already billed — but bounded.
- **No dedup.** If a client double-submits the same POST (retry after network hiccup), we get two user rows. At M2 scale, fine. Post-productization, add an idempotency key.
