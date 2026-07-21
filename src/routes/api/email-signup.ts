import { createFileRoute } from '@tanstack/react-router'
import { and, count, eq, gt, sql } from 'drizzle-orm'
import { db } from '#/db'
import { emailSignups, events } from '#/db/schema'
import { getOrCreateSession, hashClientIp } from '#/lib/session'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MAX_EMAIL_LEN = 254
const PER_IP_DAILY_CAP = 20
const VALID_SOURCES = new Set(['landing', 'wall'])

type Body = { email?: unknown; source?: unknown }
type ErrorBody =
  | { error: 'bad_request' }
  | { error: 'invalid_email' }
  | { error: 'invalid_source' }
  | { error: 'rate_limit' }

function jsonResponse(
  status: number,
  body: { ok: true } | ErrorBody,
  setCookieHeader?: string,
): Response {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (setCookieHeader) headers['Set-Cookie'] = setCookieHeader
  return new Response(JSON.stringify(body), { status, headers })
}

export const Route = createFileRoute('/api/email-signup')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: Body
        try {
          body = await request.json()
        } catch {
          return jsonResponse(400, { error: 'bad_request' })
        }

        const rawEmail = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
        const source = typeof body.source === 'string' ? body.source : ''

        if (!VALID_SOURCES.has(source)) {
          return jsonResponse(400, { error: 'invalid_source' })
        }
        if (!rawEmail || rawEmail.length > MAX_EMAIL_LEN || !EMAIL_RE.test(rawEmail)) {
          return jsonResponse(400, { error: 'invalid_email' })
        }

        const { session, setCookieHeader } = await getOrCreateSession(request)
        const ipHash = hashClientIp(request)

        const [ipCount] = await db
          .select({ n: count() })
          .from(emailSignups)
          .where(
            and(
              eq(emailSignups.ipHash, ipHash),
              gt(emailSignups.createdAt, sql`now() - interval '1 day'`),
            ),
          )
        if ((ipCount?.n ?? 0) >= PER_IP_DAILY_CAP) {
          return jsonResponse(429, { error: 'rate_limit' }, setCookieHeader)
        }

        const inserted = await db
          .insert(emailSignups)
          .values({
            email: rawEmail,
            source,
            sessionId: session.id,
            ipHash,
          })
          .onConflictDoNothing({ target: emailSignups.email })
          .returning({ id: emailSignups.id })

        await db.insert(events).values({
          sessionId: session.id,
          kind: 'email_signup',
          meta: { source, was_new: inserted.length > 0 },
        })

        return jsonResponse(200, { ok: true }, setCookieHeader)
      },
    },
  },
})
