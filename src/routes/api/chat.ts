import { createFileRoute } from '@tanstack/react-router'

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

        const model = body.model || process.env.DEFAULT_MODEL || 'anthracite-org/magnum-v4-72b'
        const messages: Message[] = [
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
            messages,
            stream: true,
            max_tokens: 200,
          }),
        })

        if (!upstream.ok || !upstream.body) {
          const text = await upstream.text()
          return new Response(`openrouter ${upstream.status}: ${text}`, {
            status: upstream.status,
          })
        }

        return new Response(upstream.body, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
          },
        })
      },
    },
  },
})
