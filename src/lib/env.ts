try {
  process.loadEnvFile('.env')
} catch {}

function required(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Missing required env var: ${name}`)
  return v
}

function intWithDefault(name: string, dflt: number): number {
  const v = process.env[name]
  if (v == null || v === '') return dflt
  const n = Number.parseInt(v, 10)
  if (Number.isNaN(n)) throw new Error(`env var ${name} not a valid integer: ${v}`)
  return n
}

export const env = {
  DATABASE_URL: required('DATABASE_URL'),
  SESSION_SECRET: required('SESSION_SECRET'),
  RATE_LIMIT_PER_SESSION: intWithDefault('RATE_LIMIT_PER_SESSION', 50),
  RATE_LIMIT_PER_IP_HOURLY: intWithDefault('RATE_LIMIT_PER_IP_HOURLY', 200),
} as const
