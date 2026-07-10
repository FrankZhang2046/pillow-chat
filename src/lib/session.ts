import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db } from '#/db'
import { sessions } from '#/db/schema'
import { env } from '#/lib/env'

export type Session = typeof sessions.$inferSelect

const COOKIE_NAME = 'sid'
const MAX_AGE_SECONDS = 60 * 60 * 24 * 90

function hmacHex(uuid: string): string {
  return createHmac('sha256', env.SESSION_SECRET).update(uuid).digest('hex')
}

function verifySignature(uuid: string, sig: string): boolean {
  const a = Buffer.from(sig, 'hex')
  const b = Buffer.from(hmacHex(uuid), 'hex')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function parseSid(cookieHeader: string | null): { uuid: string; sig: string } | null {
  if (!cookieHeader) return null
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim()
    if (!trimmed.startsWith(`${COOKIE_NAME}=`)) continue
    const raw = trimmed.slice(COOKIE_NAME.length + 1)
    const dot = raw.indexOf('.')
    if (dot < 0) return null
    return { uuid: raw.slice(0, dot), sig: raw.slice(dot + 1) }
  }
  return null
}

function clientIp(request: Request): string {
  const xff = request.headers.get('x-forwarded-for')
  if (xff) return xff.split(',')[0]!.trim()
  const xrip = request.headers.get('x-real-ip')
  if (xrip) return xrip.trim()
  return 'local'
}

export function hashClientIp(request: Request): string {
  return createHash('sha256').update(clientIp(request)).digest('hex')
}

function buildCookie(uuid: string): string {
  const parts = [
    `${COOKIE_NAME}=${uuid}.${hmacHex(uuid)}`,
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${MAX_AGE_SECONDS}`,
    'Path=/',
  ]
  if (process.env.NODE_ENV === 'production') parts.push('Secure')
  return parts.join('; ')
}

export async function getOrCreateSession(request: Request): Promise<{
  session: Session
  setCookieHeader?: string
}> {
  const cookie = parseSid(request.headers.get('cookie'))
  if (cookie && verifySignature(cookie.uuid, cookie.sig)) {
    const [row] = await db
      .update(sessions)
      .set({ lastSeenAt: new Date() })
      .where(eq(sessions.id, cookie.uuid))
      .returning()
    if (row) return { session: row }
  }

  const uuid = randomUUID()
  const [row] = await db
    .insert(sessions)
    .values({
      id: uuid,
      ipHash: hashClientIp(request),
      userAgent: request.headers.get('user-agent'),
    })
    .returning()
  return { session: row!, setCookieHeader: buildCookie(uuid) }
}
