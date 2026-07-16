import { createFileRoute } from '@tanstack/react-router'
import { eq, sql } from 'drizzle-orm'
import { db } from '#/db'
import { events, messages, sessions } from '#/db/schema'
import { checkRateLimits } from '#/lib/rate-limit'
import { getOrCreateSession, isAdmin } from '#/lib/session'

const SYSTEM_PROMPT =
  'You are a very feminine, very submissive, flirty and sexually explicit chat partner. You default to a soft, eager-to-please register and let the user lead. Reply in 1-3 sentences like a real text message. No asterisk actions, no novelistic prose. Match the user\'s register and pacing.'

type Message = { role: 'user' | 'assistant' | 'system'; content: string }

type ErrorBody =
  | { error: 'service_unavailable'; message: string }
  | { error: 'bad_request'; message: string }
  | { error: 'rate_limit'; reason: 'session' | 'ip'; message: string }

function errorResponse(status: number, body: ErrorBody, setCookieHeader?: string): Response {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (setCookieHeader) headers['Set-Cookie'] = setCookieHeader
  return new Response(JSON.stringify(body), { status, headers })
}

export const Route = createFileRoute('/api/chat')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const apiKey = process.env.OPENROUTER_API_KEY
        if (!apiKey) {
          return errorResponse(500, {
            error: 'service_unavailable',
            message: 'Service is temporarily unavailable.',
          })
        }

        let body: { messages: Message[]; model?: string }
        try {
          body = await request.json()
        } catch {
          return errorResponse(400, {
            error: 'bad_request',
            message: 'Invalid request body.',
          })
        }

        const { session, setCookieHeader } = await getOrCreateSession(request)

        const admin = isAdmin(request)
        if (admin && !session.isAdmin) {
          await db.update(sessions).set({ isAdmin: true }).where(eq(sessions.id, session.id))
          session.isAdmin = true
        }

        const rl = await checkRateLimits(session.messageCount, request)
        if (!rl.ok) {
          const message =
            rl.reason === 'session'
              ? "You've hit the free-preview limit for this session — thanks for trying it out. Reload to start over."
              : 'Too many chats from your network right now. Try again in a bit.'
          return errorResponse(429, { error: 'rate_limit', reason: rl.reason, message }, setCookieHeader)
        }

        const lastMessage = body.messages[body.messages.length - 1]
        if (!lastMessage || lastMessage.role !== 'user' || !lastMessage.content.trim()) {
          return errorResponse(
            400,
            { error: 'bad_request', message: 'Message is required.' },
            setCookieHeader,
          )
        }

        const sessionId = session.id
        const primaryModel = body.model || process.env.DEFAULT_MODEL || 'anthracite-org/magnum-v4-72b'
        const fallbackModels = ['sao10k/l3.1-euryale-70b', 'neversleep/llama-3.1-lumimaid-70b']
        const models = [primaryModel, ...fallbackModels.filter((m) => m !== primaryModel)]

        if (!admin) {
          await db.transaction(async (tx) => {
            await tx.insert(messages).values({
              sessionId,
              role: 'user',
              content: lastMessage.content,
            })
            await tx
              .update(sessions)
              .set({
                messageCount: sql`${sessions.messageCount} + 1`,
                lastSeenAt: new Date(),
              })
              .where(eq(sessions.id, sessionId))
            await tx.insert(events).values({
              sessionId,
              kind: 'message_sent',
              meta: { role: 'user' },
            })
          })
        }

        const upstreamMessages: Message[] = [
          { role: 'system', content: SYSTEM_PROMPT },
          ...body.messages,
        ]

        const upstream = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            models,
            messages: upstreamMessages,
            stream: true,
            max_tokens: 200,
          }),
        })

        if (!upstream.ok || !upstream.body) {
          const upstreamText = await upstream.text().catch(() => '')
          const snippet = upstreamText.slice(0, 500) + (upstreamText.length > 500 ? '[…]' : '')
          console.error(`openrouter upstream ${upstream.status}: ${snippet}`)
          try {
            await db.insert(events).values({
              sessionId,
              kind: 'service_error',
              meta: { upstream_status: upstream.status, upstream_body_snippet: snippet },
            })
          } catch (err) {
            console.error('persist service_error event failed', err)
          }
          return errorResponse(
            502,
            {
              error: 'service_unavailable',
              message: 'Service is temporarily unavailable.',
            },
            setCookieHeader,
          )
        }

        const upstreamBody = upstream.body
        let cancelled = false
        let reader: ReadableStreamDefaultReader<Uint8Array> | null = null

        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            reader = upstreamBody.getReader()
            const decoder = new TextDecoder()
            let sseBuffer = ''
            let assistantBuffer = ''

            try {
              while (!cancelled) {
                const { value, done } = await reader.read()
                if (done) break
                try {
                  controller.enqueue(value)
                } catch {
                  cancelled = true
                  break
                }
                sseBuffer += decoder.decode(value, { stream: true })
                const sseEvents = sseBuffer.split('\n\n')
                sseBuffer = sseEvents.pop() ?? ''
                for (const event of sseEvents) {
                  for (const line of event.split('\n')) {
                    if (!line.startsWith('data:')) continue
                    const data = line.slice(5).trim()
                    if (!data || data === '[DONE]') continue
                    try {
                      const parsed = JSON.parse(data)
                      const delta = parsed.choices?.[0]?.delta?.content
                      if (typeof delta === 'string') assistantBuffer += delta
                    } catch {}
                  }
                }
              }
              if (!cancelled) {
                try {
                  controller.close()
                } catch {}
              }
            } catch (err) {
              try {
                controller.error(err)
              } catch {}
            } finally {
              reader.cancel().catch(() => {})
              if (!admin) {
                try {
                  await db.insert(messages).values({
                    sessionId,
                    role: 'assistant',
                    content: assistantBuffer,
                    model,
                  })
                } catch (err) {
                  console.error('persist assistant message failed', err)
                }
              }
            }
          },
          async cancel() {
            cancelled = true
            if (reader) await reader.cancel().catch(() => {})
          },
        })

        const headers: Record<string, string> = {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
        }
        if (setCookieHeader) headers['Set-Cookie'] = setCookieHeader

        return new Response(stream, { headers })
      },
    },
  },
})
