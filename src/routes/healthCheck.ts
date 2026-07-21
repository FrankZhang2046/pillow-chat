import { createFileRoute } from '@tanstack/react-router'
import { sql } from 'drizzle-orm'
import { db } from '#/db'
import { env } from '#/lib/env'

type CheckStatus = 'healthy' | 'degraded' | 'unhealthy'

type Check = {
  name: string
  status: CheckStatus
  latencyMs: number
  critical: boolean
  error?: string
}

const PROBE_TIMEOUT_MS = 2000

function truncateError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw.slice(0, 200)
}

async function withTimeout<T>(work: () => Promise<T>, ms: number): Promise<T> {
  return await Promise.race([
    work(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms),
    ),
  ])
}

async function probePostgres(): Promise<Check> {
  const started = Date.now()
  try {
    await withTimeout(() => db.execute(sql`SELECT 1`), PROBE_TIMEOUT_MS)
    return {
      name: 'Postgres',
      status: 'healthy',
      latencyMs: Math.round(Date.now() - started),
      critical: true,
    }
  } catch (err) {
    return {
      name: 'Postgres',
      status: 'unhealthy',
      latencyMs: Math.round(Date.now() - started),
      critical: true,
      error: truncateError(err),
    }
  }
}

async function probeOpenRouter(): Promise<Check> {
  const started = Date.now()
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models', {
      method: 'HEAD',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    if (!res.ok) {
      return {
        name: 'OpenRouter',
        status: 'unhealthy',
        latencyMs: Math.round(Date.now() - started),
        critical: true,
        error: `HTTP ${res.status}`,
      }
    }
    return {
      name: 'OpenRouter',
      status: 'healthy',
      latencyMs: Math.round(Date.now() - started),
      critical: true,
    }
  } catch (err) {
    return {
      name: 'OpenRouter',
      status: 'unhealthy',
      latencyMs: Math.round(Date.now() - started),
      critical: true,
      error: truncateError(err),
    }
  }
}

export const Route = createFileRoute('/healthCheck')({
  server: {
    handlers: {
      GET: async () => {
        const checks = await Promise.all([probePostgres(), probeOpenRouter()])

        const critFail = checks.some((c) => c.critical && c.status === 'unhealthy')
        const anyDegraded = checks.some((c) => c.status !== 'healthy')
        const overall: CheckStatus = critFail
          ? 'unhealthy'
          : anyDegraded
            ? 'degraded'
            : 'healthy'
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
