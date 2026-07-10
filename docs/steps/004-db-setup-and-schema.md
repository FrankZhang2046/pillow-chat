# 004 — DB Setup & Schema

## Context

Extracted from `003-m2-smoke-test.md` §1–§2 so the DB piece can be executed and reviewed as its own unit before the code that consumes it lands. Sits under M2 (public smoke test) and doesn't change the overall M2 scope — this is a decomposition, not a new milestone.

**Why the DB exists at all** — four things need durable storage:

1. **Message capture.** The point of the smoke test is measuring stranger engagement (session length, drop-off, what people actually say). No persistence, no signal.
2. **Per-session rate limit.** Enforce the 50-msg-per-session cap via a persistent counter tied to the anonymous session cookie.
3. **Per-IP hourly rate limit.** Cost guardrail against a single bad actor. Hour-bucketed rows keyed on hashed IP make writes and cleanup trivial.
4. **Funnel events.** session_start / gate_accepted / message_sent for later analysis of gate conversion + drop-off by message index.

**Why Postgres over SQLite.** Want to `psql` in from the laptop against the VPS during the smoke test to eyeball data live, and it matches the prod deploy (`003-m2-smoke-test.md` §10). SQLite would break both.

**Why plaintext message content, not encrypted at rest.** For a smoke test with tens of users on a single VPS holding both key and ciphertext, no backups configured yet, and one operator, at-rest encryption is compliance theater — the key sits next to the data. It also blocks `psql` spot-checks, which is a real ergonomic cost during the smoke test. Encryption gets added back at M6+ when we're commercializing and the value/effort flips. This decision requires a landing-page copy update (see §5).

## Scope

**In:**
- Local dev Postgres via Docker
- Typed env accessor with runtime validation (scaffold now, grows in later steps)
- Drizzle wiring: `drizzle-orm`, `drizzle-kit`, `postgres.js`, `tsx`
- Schema: `sessions`, `messages`, `events`, `ip_counters`
- Initial migration checked in (`0001_initial.sql`)
- `pnpm` scripts: `db:generate`, `db:migrate`, `db:studio`
- Landing-page copy edit to remove the now-untrue "encrypted at rest" claim

**Out (deferred to later 003-M2 sub-steps):**
- Session cookie signing (Task #3)
- Chat route persistence + tee-buffer (Task #6, needs schema + session lib first)
- Rate-limit read/write logic (Task #5, needs schema)
- Retention cron (Task #8, needs schema)
- VPS Postgres provisioning specifics (Task #10)

**Removed from M2 entirely (not deferred):**
- AES-256-GCM encryption module (was Task #4) — see Context.

## Approach

Steps ordered so each can be executed and verified before the next.

### 1. Local Postgres via Docker

```
docker run -d --name pillow-pg \
  -p 5432:5432 \
  -e POSTGRES_PASSWORD=dev \
  -v pillow-pg-data:/var/lib/postgresql/data \
  postgres:16
```

Same command re-used on the VPS (`docs/ops/vps-setup.md` in Task #10). Volume-backed so data survives `docker restart`.

### 2. Env accessor

`src/lib/env.ts` — typed getter that reads `process.env` once at boot, validates required vars, throws on missing with a clear message. This file starts with only `DATABASE_URL` and grows as later steps add `SESSION_SECRET`, `RATE_LIMIT_*`, etc. All other modules import from here — never `process.env` directly.

Extend `.env.example` with:

```
DATABASE_URL=postgres://postgres:dev@localhost:5432/postgres
```

### 3. Drizzle wiring

Install:
- `drizzle-orm` (runtime)
- `drizzle-kit` (dev — schema diff → migration SQL)
- `postgres` (the `postgres.js` driver — smaller + better TS than `pg`)
- `tsx` (dev — TS runner for the migration + future cron scripts)

Files created:
- `drizzle.config.ts` at repo root, dialect `postgresql`, schema `src/db/schema.ts`, out `src/db/migrations/`, credentials from `env.ts`
- `src/db/index.ts` — connection singleton: `postgres(env.DATABASE_URL)` + `drizzle(client)`, exported as `db`
- `scripts/migrate.ts` — invokes drizzle-orm's `migrate()` against `env.DATABASE_URL`

`package.json` scripts:
- `db:generate` → `drizzle-kit generate`
- `db:migrate` → `tsx scripts/migrate.ts`
- `db:studio` → `drizzle-kit studio` (bonus for eyeballing)

### 4. Schema

All IDs generated app-side via `crypto.randomUUID()` (Drizzle `.$defaultFn(() => crypto.randomUUID())`) — no `pgcrypto` extension needed, schema stays portable.

```
sessions
  id                uuid pk
  created_at        timestamptz not null default now()
  last_seen_at      timestamptz not null default now()
  ip_hash           text not null            -- SHA-256(ip), never raw IP
  user_agent        text
  message_count     integer not null default 0
  index on (last_seen_at)                    -- for retention scan

messages
  id                uuid pk
  session_id        uuid not null references sessions(id) on delete cascade
  role              text not null            -- 'user' | 'assistant' | 'system'
  content           text not null            -- plaintext for M2; revisit at M6+
  model             text                     -- null for user rows; OpenRouter model id for assistant rows
  created_at        timestamptz not null default now()
  index on (session_id, created_at)         -- transcript reads
  index on (created_at)                     -- retention scan

events
  id                uuid pk
  session_id        uuid references sessions(id) on delete set null  -- nullable for pre-session events
  kind              text not null            -- 'session_start' | 'age_gate_accepted' | 'message_sent' | …
  meta              jsonb                    -- free-form per-event context
  created_at        timestamptz not null default now()
  index on (kind, created_at)                -- funnel queries
  index on (created_at)                      -- retention scan

ip_counters
  ip_hash           text not null
  hour_bucket       timestamptz not null     -- date_trunc('hour', now())
  count             integer not null default 0
  primary key (ip_hash, hour_bucket)
  index on (hour_bucket)                     -- retention scan
```

**Rationale:**

- `sessions.message_count` denormalizes the count so the per-session rate-limit check is a single row read, not `COUNT(*)` on `messages`.
- `ip_counters` hour-bucketing makes cleanup `DELETE WHERE hour_bucket < now() - '48h'` and reads `SELECT count WHERE ip_hash = ? AND hour_bucket = date_trunc('hour', now())`.
- `messages.session_id` cascades on delete so the 90-day retention purge by `sessions` covers orphan messages automatically.
- `events.session_id` on-delete-set-null keeps aggregate funnel history intact even after a session is retention-purged.
- No `email` / `user_id` / anything identifiable — login is M5+, out of scope by design.

### 5. Landing-page copy edit

Dropped encryption means two lines in the landing page need to change to stay honest:

- `src/routes/index.tsx:373` (Private-by-design value prop): `body="Encrypted. No account or email needed."` → `body="No account. No email. Private by default."`
- `src/routes/index.tsx:475` (Footer): `"Privacy policy placeholder — chats encrypted in transit and at rest."` → `"Privacy policy placeholder — chats encrypted in transit."` (drop the "at rest" claim; TLS-in-transit is still true because Nginx will terminate TLS per §10)

### 6. Migration workflow

- `pnpm db:generate` after every `schema.ts` change → new `src/db/migrations/NNNN_xxx.sql`, committed
- `pnpm db:migrate` applies pending migrations against `$DATABASE_URL`
- No `drizzle-kit push` in this repo — every schema change produces a checked-in migration SQL, so prod and dev stay in lockstep

## Files touched

**New:**
- `src/lib/env.ts`
- `src/db/index.ts`
- `src/db/schema.ts`
- `src/db/migrations/0001_initial.sql` (generated)
- `scripts/migrate.ts`
- `drizzle.config.ts`

**Modified:**
- `package.json` — add `drizzle-orm`, `drizzle-kit`, `postgres`, `tsx`; add `db:*` scripts
- `.env.example` — add `DATABASE_URL`
- `src/routes/index.tsx` — copy edits at :373 and :475 (see §5)
- `docs/steps/003-m2-smoke-test.md` — point §2 at 004, drop encryption references from §4 and Scope

## Verification

End-to-end on a fresh clone:

1. `docker run …postgres:16` (see §1) — container up, `docker ps` shows it healthy
2. `pnpm install` — new deps land, lockfile updates
3. `cp .env.example .env`, ensure `DATABASE_URL` set to the Docker container's URL
4. `pnpm db:generate` — produces `src/db/migrations/0001_initial.sql`; inspect SQL and confirm four tables, indexes, cascades
5. `pnpm db:migrate` — applies without error
6. `psql $DATABASE_URL -c '\dt'` — shows `sessions`, `messages`, `events`, `ip_counters`
7. `psql $DATABASE_URL -c '\d messages'` — confirms `content text not null` column and FK with `ON DELETE CASCADE`
8. Smoke insert from `psql`:
   ```
   INSERT INTO sessions (id, ip_hash) VALUES ('00000000-0000-0000-0000-000000000001', 'test');
   INSERT INTO messages (id, session_id, role, content)
     VALUES ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'user', 'hello world');
   SELECT content FROM messages WHERE session_id = '00000000-0000-0000-0000-000000000001';
   -- expect: 'hello world' — proves plaintext read (spot-check ergonomic goal)
   DELETE FROM sessions WHERE id = '00000000-0000-0000-0000-000000000001';
   SELECT count(*) FROM messages;
   -- expect: 0 — proves cascade works
   ```
9. `src/lib/env.ts` boot check: unset `DATABASE_URL`, run `pnpm dev`, confirm it throws with a clear "missing DATABASE_URL" message. Reset and confirm normal boot.
10. Visit the landing page in a browser and confirm the value-prop and footer copy match §5, not the old encryption promise.

## Notes / deferred concerns

- **Encryption revisit trigger.** Set a reminder for M6+ (commercialization prep) to reintroduce AES-GCM at rest: new `content_ciphertext/iv/tag` columns, a versioned key scheme so ciphertext survives key rotation, and a `content` column drop after backfill.
- **VPS Postgres.** Same Docker image on the VPS, but exposing on `127.0.0.1:5432` only (not 0.0.0.0). VPS-side details land in `docs/ops/vps-setup.md` under Task #10.
- **Backups.** Explicitly out of scope for M2. Once encryption is back, a `pg_dump` cron with off-VPS storage is table stakes; noting it here so it doesn't get lost.
- **`postgres.js` connection pool.** Default `max=10` is fine at smoke-test load. Node singleton pattern via `globalThis` cache is needed to avoid hot-reload leaks in dev (`src/db/index.ts` handles this).
- **Migration on deploy.** Prod runs `pnpm db:migrate` as part of the deploy step (systemd `ExecStartPre=`). Documented in Task #10's ops doc.
