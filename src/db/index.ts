import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { env } from '#/lib/env'
import * as schema from './schema'

type GlobalWithDb = typeof globalThis & {
  __pillowDbClient?: ReturnType<typeof postgres>
}
const g = globalThis as GlobalWithDb

const client = g.__pillowDbClient ?? postgres(env.DATABASE_URL)
if (process.env.NODE_ENV !== 'production') g.__pillowDbClient = client

export const db = drizzle(client, { schema })
