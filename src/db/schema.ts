import { randomUUID } from 'node:crypto'
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().$defaultFn(() => randomUUID()),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    ipHash: text('ip_hash').notNull(),
    userAgent: text('user_agent'),
    messageCount: integer('message_count').notNull().default(0),
    isAdmin: boolean('is_admin').notNull().default(false),
  },
  (t) => [index('sessions_last_seen_at_idx').on(t.lastSeenAt)],
)

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().$defaultFn(() => randomUUID()),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    content: text('content').notNull(),
    model: text('model'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('messages_session_id_created_at_idx').on(t.sessionId, t.createdAt),
    index('messages_created_at_idx').on(t.createdAt),
  ],
)

export const events = pgTable(
  'events',
  {
    id: uuid('id').primaryKey().$defaultFn(() => randomUUID()),
    sessionId: uuid('session_id').references(() => sessions.id, { onDelete: 'set null' }),
    kind: text('kind').notNull(),
    meta: jsonb('meta'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('events_kind_created_at_idx').on(t.kind, t.createdAt),
    index('events_created_at_idx').on(t.createdAt),
  ],
)

export const ipCounters = pgTable(
  'ip_counters',
  {
    ipHash: text('ip_hash').notNull(),
    hourBucket: timestamp('hour_bucket', { withTimezone: true }).notNull(),
    count: integer('count').notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.ipHash, t.hourBucket] }),
    index('ip_counters_hour_bucket_idx').on(t.hourBucket),
  ],
)
