import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'

type Message = { role: 'user' | 'assistant'; content: string }

export const Route = createFileRoute('/')({
  component: Chat,
  validateSearch: (s: Record<string, unknown>) => ({
    model: typeof s.model === 'string' ? s.model : undefined,
  }),
})

function Chat() {
  const { model } = Route.useSearch()
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [messages, streaming])

  async function send() {
    const text = input.trim()
    if (!text || streaming) return
    setError(null)
    setInput('')

    const nextMessages: Message[] = [...messages, { role: 'user', content: text }]
    setMessages([...nextMessages, { role: 'assistant', content: '' }])
    setStreaming(true)

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: nextMessages, model }),
      })

      if (!res.ok || !res.body) {
        const errText = await res.text().catch(() => `HTTP ${res.status}`)
        throw new Error(errText || `HTTP ${res.status}`)
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        const events = buffer.split('\n\n')
        buffer = events.pop() ?? ''

        for (const event of events) {
          for (const line of event.split('\n')) {
            if (!line.startsWith('data:')) continue
            const data = line.slice(5).trim()
            if (!data || data === '[DONE]') continue
            try {
              const parsed = JSON.parse(data)
              const delta = parsed.choices?.[0]?.delta?.content
              if (typeof delta === 'string' && delta.length > 0) {
                setMessages((prev) => {
                  const copy = prev.slice()
                  const last = copy[copy.length - 1]
                  copy[copy.length - 1] = { ...last, content: last.content + delta }
                  return copy
                })
              }
            } catch {
              // ignore comments/keepalives/partial lines
            }
          }
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
      setMessages((prev) => prev.slice(0, -1))
    } finally {
      setStreaming(false)
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send()
    }
  }

  return (
    <div className="flex h-dvh flex-col mx-auto max-w-2xl">
      <header className="border-b px-4 py-3 text-sm text-neutral-500">
        {model ?? 'default model'}
      </header>

      <div ref={listRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {messages.length === 0 && (
          <div className="text-neutral-400 text-sm">say something.</div>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            className={
              m.role === 'user'
                ? 'ml-auto max-w-[80%] rounded-2xl bg-blue-600 text-white px-3 py-2 whitespace-pre-wrap'
                : 'mr-auto max-w-[80%] rounded-2xl bg-neutral-200 text-neutral-900 px-3 py-2 whitespace-pre-wrap'
            }
          >
            {m.content || (streaming && i === messages.length - 1 ? '…' : '')}
          </div>
        ))}
        {error && (
          <div className="text-red-600 text-sm whitespace-pre-wrap">error: {error}</div>
        )}
      </div>

      <div className="border-t p-3 flex gap-2">
        <textarea
          className="flex-1 resize-none rounded-lg border px-3 py-2 focus:outline-none focus:ring"
          rows={1}
          placeholder="message"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={streaming}
        />
        <button
          className="rounded-lg bg-blue-600 text-white px-4 py-2 disabled:opacity-50"
          onClick={() => void send()}
          disabled={streaming || input.trim().length === 0}
        >
          send
        </button>
      </div>
    </div>
  )
}
