import { sql } from 'drizzle-orm'
import { db } from '#/db'
import { ipCounters } from '#/db/schema'
import { env } from '#/lib/env'
import { hashClientIp, isAdmin } from '#/lib/session'

export type RateLimitResult = { ok: true } | { ok: false; reason: 'session' | 'ip' }

export async function checkRateLimits(
  sessionMessageCount: number,
  request: Request,
): Promise<RateLimitResult> {
  if (isAdmin(request)) return { ok: true }

  if (sessionMessageCount >= env.RATE_LIMIT_PER_SESSION) {
    return { ok: false, reason: 'session' }
  }

  const hourBucket = new Date()
  hourBucket.setUTCMinutes(0, 0, 0)

  const [row] = await db
    .insert(ipCounters)
    .values({
      ipHash: hashClientIp(request),
      hourBucket,
      count: 1,
    })
    .onConflictDoUpdate({
      target: [ipCounters.ipHash, ipCounters.hourBucket],
      set: { count: sql`${ipCounters.count} + 1` },
    })
    .returning({ count: ipCounters.count })

  if (row!.count > env.RATE_LIMIT_PER_IP_HOURLY) {
    return { ok: false, reason: 'ip' }
  }
  return { ok: true }
}
