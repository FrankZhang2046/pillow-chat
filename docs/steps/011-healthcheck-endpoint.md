# /healthCheck Endpoint

## Context

External dashboard needs to poll the smoke-test service to display live health status. Spec was pasted verbatim and is portable across projects — endpoint path, schema, and rollup rules are fixed by the consumer. We need to implement it in this codebase against the two dependencies that can actually take the service down:

- **Postgres** — if the DB is unreachable, chat won't persist, session cookies can't verify, email capture 500s. Critical.
- **OpenRouter** — if OpenRouter is entirely unreachable (all fallback models included), chat can't respond. The site's whole purpose is chat, so a persistent OpenRouter outage means we're down. Critical.

Nothing else in the codebase has a runtime dependency worth checking (no Redis, no queue, no external SaaS other than OpenRouter).

## Approach

**Single new file:** `src/routes/healthCheck.ts` — TanStack Start file route with a `GET` server handler at path `/healthCheck` (deviates from the existing `src/routes/api/*` convention, but matches the spec's literal path so the dashboard config is `https://<domain>/healthCheck` with no extra prefix).

**Handler shape** (follows the existing pattern in `src/routes/api/session-status.ts:4-17`):

```ts
export const Route = createFileRoute('/healthCheck')({
  server: {
    handlers: {
      GET: async () => {
        const started = Date.now()
        const [pg, openrouter] = await Promise.all([probePostgres(), probeOpenRouter()])
        const checks = [pg, openrouter]

        const critFail = checks.some((c) => c.critical && c.status === 'unhealthy')
        const anyDegraded = checks.some((c) => c.status !== 'healthy')
        const overall = critFail ? 'unhealthy' : anyDegraded ? 'degraded' : 'healthy'
        const httpStatus = overall === 'unhealthy' ? 503 : 200

        return new Response(
          JSON.stringify({
            status: overall,
            service: 'pillow-chat',
            version: env.APP_VERSION || 'dev',
            timestamp: new Date().toISOString(),
            checks,
          }),
          {
            status: httpStatus,
            headers: {
              'Content-Type': 'application/json; charset=utf-8',
              'Cache-Control': 'no-store',
              'Access-Control-Allow-Origin': '*',
            },
          },
        )
      },
    },
  },
})
```

**Probe helpers** (colocated in the same file — small, no need for a shared lib):

- `probePostgres()` → runs `db.execute(sql\`SELECT 1\`)` with a 2s timeout via `Promise.race`. Returns `{ name: 'Postgres', status, latencyMs, critical: true, error? }`.
- `probeOpenRouter()` → `fetch('https://openrouter.ai/api/v1/models', { method: 'HEAD', signal: AbortSignal.timeout(2000) })`. Public endpoint, no auth required. Non-2xx or thrown error → unhealthy. Returns `{ name: 'OpenRouter', status, latencyMs, critical: true, error? }`.

Both probes wrap all logic in try/catch; latency is `Math.round(Date.now() - start)`; error string is trimmed to <200 chars to keep the response small.

## Config

- **`APP_VERSION`** — new optional env var added to `src/lib/env.ts` via a `stringWithDefault(name, dflt)` helper (or reuse `optional` + `|| 'dev'` at the callsite; simpler). Deploy pipeline can inject the git SHA (`APP_VERSION=$GITHUB_SHA` in the workflow env) — that's a follow-up outside this task's scope; endpoint returns `"dev"` until wired up.
- **`service`** — hardcoded `"pillow-chat"` (matches `public/manifest.json:2`).

## Files touched

**New**
- `src/routes/healthCheck.ts` — the endpoint + inline probe helpers

**Modified**
- `src/lib/env.ts` — add `APP_VERSION: optional('APP_VERSION')` to the exported `env` object

## Rate-limiting note

The endpoint bypasses `checkRateLimits` entirely — deliberate. Health checks must always respond so the dashboard can distinguish "down" from "rate-limited." No exposure risk: the endpoint doesn't touch OpenRouter's paid endpoints (HEAD `/models` is public + free) and Postgres `SELECT 1` costs nothing. If a bad actor floods it, they burn our compute but not our OpenRouter budget — same class of concern as any unauthenticated endpoint on the box.

Should update `docs/ops/rate-limiting.md` §"What actually protects the budget" with a one-line note that `/healthCheck` is intentionally unrestricted — small doc edit, keeps the ops doc accurate.

## Verification

1. **Local happy path** — `pnpm dev` with Docker Postgres up. `curl -sSi http://localhost:3000/healthCheck` → 200, `status: "healthy"`, both checks report `latencyMs` and `critical: true`, headers include `Cache-Control: no-store` and `Access-Control-Allow-Origin: *`.
2. **DB down** — `docker stop pillow-pg`, curl again → 503, `status: "unhealthy"`, Postgres check has `status: "unhealthy"` with an `error` string, OpenRouter check unaffected.
3. **Schema conformance** — pipe response through `jq` and verify all required fields present, `checks` is an array, `timestamp` is a fresh ISO string, `latencyMs` is an integer.
4. **Post-deploy** — `curl -sSi https://<domain>/healthCheck` returns 200 healthy, `version` is either the git SHA (if `APP_VERSION` wired in CI) or `"dev"`.
5. **Dashboard integration** — user points the dashboard at `https://<domain>/healthCheck` and confirms it displays green.
