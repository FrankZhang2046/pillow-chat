import { createFileRoute } from '@tanstack/react-router'
import { eq, sql } from 'drizzle-orm'
import { db } from '#/db'
import { events, messages, sessions } from '#/db/schema'
import { checkRateLimits } from '#/lib/rate-limit'
import { getOrCreateSession } from '#/lib/session'

const SYSTEM_PROMPT =
  'You are a very feminine, very submissive, flirty and sexually explicit chat partner. You default to a soft, eager-to-please register and let the user lead. Reply in 1-3 sentences like a real text message. No asterisk actions, no novelistic prose. Match the user\'s register and pacing.'

type Message = { role: 'user' | 'assistant' | 'system'; content: string }

export const Route = createFileRoute('/api/chat')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const apiKey = process.env.OPENROUTER_API_KEY
        if (!apiKey) {
          return new Response('OPENROUTER_API_KEY not set', { status: 500 })
        }

        let body: { messages: Message[]; model?: string }
        try {
          body = await request.json()
        } catch {
          return new Response('invalid JSON body', { status: 400 })
        }

        const { session, setCookieHeader } = await getOrCreateSession(request)

        const rl = await checkRateLimits(session.messageCount, request)
        if (!rl.ok) {
          const headers: Record<string, string> = {}
          if (setCookieHeader) headers['Set-Cookie'] = setCookieHeader
          const body429 =
            rl.reason === 'session'
              ? "You've hit the free-preview limit for this session — thanks for trying it out. Reload to start over."
              : 'Too many requests from this network. Please try again in a bit.'
          return new Response(body429, { status: 429, headers })
        }

        const lastMessage = body.messages[body.messages.length - 1]
        if (!lastMessage || lastMessage.role !== 'user' || !lastMessage.content.trim()) {
          const headers: Record<string, string> = {}
          if (setCookieHeader) headers['Set-Cookie'] = setCookieHeader
          return new Response('last message must be a non-empty user message', {
            status: 400,
            headers,
          })
        }

        const sessionId = session.id
        const model = body.model || process.env.DEFAULT_MODEL || 'anthracite-org/magnum-v4-72b'

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
            model,
            messages: upstreamMessages,
            stream: true,
            max_tokens: 200,
          }),
        })

        if (!upstream.ok || !upstream.body) {
          const text = await upstream.text()
          const headers: Record<string, string> = {}
          if (setCookieHeader) headers['Set-Cookie'] = setCookieHeader
          return new Response(`openrouter ${upstream.status}: ${text}`, {
            status: upstream.status,
            headers,
          })
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
