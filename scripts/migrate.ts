import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import { env } from '#/lib/env'

const client = postgres(env.DATABASE_URL, { max: 1 })
const db = drizzle(client)

await migrate(db, { migrationsFolder: 'src/db/migrations' })
await client.end()

console.log('migrations applied')
