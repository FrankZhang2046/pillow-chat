import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useRef, useState, type CSSProperties } from 'react'

type ErrorKind = 'retry' | 'rate-limit-session' | 'rate-limit-ip' | 'service-down'

type Message = {
  role: 'user' | 'assistant'
  content: string
  createdAt: Date
  errorKind?: ErrorKind
}

const MESSAGE_LIMIT = 50
const OPENER = "hey. what's on your mind tonight"

export const Route = createFileRoute('/chat')({
  component: Chat,
  validateSearch: (s: Record<string, unknown>): { model?: string } => {
    const model = typeof s.model === 'string' ? s.model : undefined
    return model ? { model } : {}
  },
})

function Chat() {
  const { model } = Route.useSearch()
  const navigate = useNavigate()
  const [gateChecked, setGateChecked] = useState(false)
  const [messages, setMessages] = useState<Message[]>(() => [
    { role: 'assistant', content: OPENER, createdAt: new Date() },
  ])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const userScrolledUp = useRef(false)

  useEffect(() => {
    if (localStorage.getItem('age_confirmed') === '1') setGateChecked(true)
    else void navigate({ to: '/' })
  }, [navigate])

  useEffect(() => {
    if (!listRef.current || userScrolledUp.current) return
    listRef.current.scrollTo({ top: listRef.current.scrollHeight })
  }, [messages, streaming])

  function onListScroll() {
    const el = listRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    userScrolledUp.current = !nearBottom
  }

  const userCount = messages.filter((m) => m.role === 'user').length
  const remaining = Math.max(0, MESSAGE_LIMIT - userCount)
  const rateLimitHitByCount = userCount >= MESSAGE_LIMIT
  const lastUserErrorKind = [...messages].reverse().find((m) => m.role === 'user')?.errorKind
  const showSessionCard =
    rateLimitHitByCount || lastUserErrorKind === 'rate-limit-session'
  const showIpCard = lastUserErrorKind === 'rate-limit-ip'
  const showServiceDownCard = lastUserErrorKind === 'service-down'
  const blocked = showSessionCard || showIpCard || showServiceDownCard
  const inputDisabled = streaming || blocked

  async function streamAssistantReply(historyForApi: Message[]) {
    setStreaming(true)
    userScrolledUp.current = false
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: historyForApi.map(({ role, content }) => ({ role, content })),
          model,
        }),
      })
      if (!res.ok || !res.body) {
        const parsed = await res.json().catch(() => null)
        let kind: ErrorKind = 'retry'
        if (parsed?.error === 'rate_limit') {
          kind = parsed.reason === 'ip' ? 'rate-limit-ip' : 'rate-limit-session'
        } else if (parsed?.error === 'service_unavailable') {
          kind = 'service-down'
        }
        throw Object.assign(new Error('send failed'), { kind })
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
                  if (last?.role === 'assistant') {
                    copy[copy.length - 1] = { ...last, content: last.content + delta }
                  }
                  return copy
                })
              }
            } catch {
              // keepalives / partial lines
            }
          }
        }
      }
    } catch (err) {
      const kind: ErrorKind =
        (err && typeof err === 'object' && 'kind' in err && typeof (err as { kind: unknown }).kind === 'string'
          ? ((err as { kind: string }).kind as ErrorKind)
          : 'retry')
      setMessages((prev) => {
        const copy = prev.slice()
        const last = copy[copy.length - 1]
        if (last?.role === 'assistant' && last.content === '') copy.pop()
        const nowLast = copy[copy.length - 1]
        if (nowLast?.role === 'user') copy[copy.length - 1] = { ...nowLast, errorKind: kind }
        return copy
      })
    } finally {
      setStreaming(false)
    }
  }

  function send() {
    const text = input.trim()
    if (!text || inputDisabled) return
    setInput('')
    const now = new Date()
    const next: Message[] = [
      ...messages,
      { role: 'user', content: text, createdAt: now },
      { role: 'assistant', content: '', createdAt: now },
    ]
    setMessages(next)
    void streamAssistantReply(next.slice(0, -1))
  }

  function retry(index: number) {
    if (streaming) return
    const now = new Date()
    const next: Message[] = [
      ...messages.slice(0, index),
      { ...messages[index], errorKind: undefined },
      ...messages.slice(index + 1),
      { role: 'assistant', content: '', createdAt: now },
    ]
    setMessages(next)
    void streamAssistantReply(next.slice(0, -1))
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send()
    }
  }

  if (!gateChecked) return null

  return (
    <div
      style={{
        height: '100dvh',
        background: 'oklch(0.08 0.005 30)',
        fontFamily: 'Sora, sans-serif',
        color: 'oklch(0.95 0.01 30)',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* HEADER */}
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '16px 18px',
          borderBottom: '1px solid oklch(0.18 0.015 30)',
          flexShrink: 0,
          maxWidth: '640px',
          width: '100%',
          margin: '0 auto',
          boxSizing: 'border-box',
        }}
      >
        <span
          style={{
            font: '800 15px Sora, sans-serif',
            color: 'oklch(0.95 0.01 30)',
            letterSpacing: '-0.01em',
          }}
        >
          Pillow Chat
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span
            style={{
              font: `${remaining < 10 ? 700 : 600} 11px Sora, sans-serif`,
              color:
                remaining < 10 ? 'oklch(0.7 0.15 40)' : 'oklch(0.42 0.01 30)',
            }}
          >
            {remaining}/{MESSAGE_LIMIT}
          </span>
          <span
            style={{
              font: '700 9.5px Sora, sans-serif',
              letterSpacing: '0.08em',
              color: 'oklch(0.98 0.01 30)',
              background: 'oklch(0.68 0.17 350)',
              padding: '3px 7px',
              borderRadius: '5px',
            }}
          >
            18+
          </span>
        </div>
      </header>

      {/* MESSAGE LIST */}
      <div
        ref={listRef}
        onScroll={onListScroll}
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '18px',
          display: 'flex',
          flexDirection: 'column',
          gap: '16px',
          maxWidth: '640px',
          width: '100%',
          margin: '0 auto',
          boxSizing: 'border-box',
        }}
      >
        {messages.map((m, i) => {
          const isLast = i === messages.length - 1
          if (m.role === 'assistant') {
            if (m.content === '' && streaming && isLast) {
              return <TypingDots key={i} />
            }
            if (m.content === '') return null
            return (
              <AssistantBubble
                key={i}
                content={m.content}
                time={formatTime(m.createdAt)}
                showCursor={streaming && isLast}
              />
            )
          }
          if (m.errorKind === 'retry') {
            return (
              <UserBubbleFailed
                key={i}
                content={m.content}
                onRetry={() => retry(i)}
              />
            )
          }
          return (
            <UserBubble
              key={i}
              content={m.content}
              time={formatTime(m.createdAt)}
            />
          )
        })}

        {!streaming && showSessionCard && <RateLimitSessionCard />}
        {!streaming && showIpCard && <RateLimitIpCard />}
        {!streaming && showServiceDownCard && <ServiceDownCard />}
      </div>

      {/* INPUT */}
      <div
        style={{
          padding: '14px 16px 18px',
          borderTop: '1px solid oklch(0.18 0.015 30)',
          flexShrink: 0,
          maxWidth: '640px',
          width: '100%',
          margin: '0 auto',
          boxSizing: 'border-box',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            background: inputDisabled ? 'oklch(0.11 0.008 30)' : 'oklch(0.13 0.01 30)',
            borderRadius: '24px',
            padding: '6px 6px 6px 18px',
            border: `1px solid ${
              inputDisabled ? 'oklch(0.17 0.012 30)' : 'oklch(0.2 0.015 30)'
            }`,
            opacity: blocked ? 0.5 : streaming ? 0.6 : 1,
          }}
        >
          <textarea
            rows={1}
            placeholder={
              showSessionCard
                ? 'Preview limit reached'
                : showIpCard
                  ? 'Rate limited'
                  : showServiceDownCard
                    ? 'Service unavailable'
                    : 'Message…'
            }
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={inputDisabled}
            autoFocus
            style={{
              flex: 1,
              background: 'transparent',
              border: 'none',
              outline: 'none',
              resize: 'none',
              font: '400 14px Sora, sans-serif',
              color: 'oklch(0.95 0.01 30)',
              caretColor: 'oklch(0.74 0.17 350)',
              padding: '8px 0',
              maxHeight: '120px',
              lineHeight: 1.4,
            }}
          />
          <button
            onClick={() => void send()}
            disabled={inputDisabled || input.trim().length === 0}
            aria-label="Send"
            style={{
              width: '36px',
              height: '36px',
              borderRadius: '50%',
              border: 'none',
              background:
                inputDisabled || input.trim().length === 0
                  ? 'oklch(0.24 0.015 30)'
                  : 'oklch(0.74 0.17 350)',
              color:
                inputDisabled || input.trim().length === 0
                  ? 'oklch(0.42 0.01 30)'
                  : 'oklch(0.12 0.01 30)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '15px',
              flexShrink: 0,
              cursor:
                inputDisabled || input.trim().length === 0 ? 'not-allowed' : 'pointer',
              transition: 'background 0.15s ease, color 0.15s ease',
            }}
          >
            ➤
          </button>
        </div>
      </div>
    </div>
  )
}

function AssistantBubble({
  content,
  time,
  showCursor,
}: {
  content: string
  time: string
  showCursor: boolean
}) {
  return (
    <div
      style={{
        alignSelf: 'flex-start',
        maxWidth: '82%',
        display: 'flex',
        flexDirection: 'column',
        gap: '5px',
      }}
    >
      <div
        style={{
          background: 'oklch(0.2 0.04 350)',
          color: 'oklch(0.97 0.01 30)',
          font: '500 14.5px/1.45 Sora, sans-serif',
          padding: '12px 15px',
          borderRadius: '4px 16px 16px 16px',
          boxShadow: '0 0 0 1px oklch(0.4 0.06 350 / 0.5) inset',
          whiteSpace: 'pre-wrap',
          minHeight: '1.45em',
        }}
      >
        {content}
        {showCursor && (
          <span
            style={{
              display: 'inline-block',
              width: '2px',
              height: '14px',
              background: 'oklch(0.9 0.05 350)',
              marginLeft: '2px',
              verticalAlign: 'middle',
              animation: 'cursorBlink 0.9s steps(1) infinite',
            }}
          />
        )}
      </div>
      {!showCursor && (
        <span
          style={{
            font: '500 10.5px Sora, sans-serif',
            color: 'oklch(0.42 0.01 30)',
            marginLeft: '4px',
          }}
        >
          {time}
        </span>
      )}
    </div>
  )
}

function UserBubble({ content, time }: { content: string; time: string }) {
  return (
    <div
      style={{
        alignSelf: 'flex-end',
        maxWidth: '78%',
        display: 'flex',
        flexDirection: 'column',
        gap: '5px',
        alignItems: 'flex-end',
      }}
    >
      <div
        style={{
          background: 'oklch(0.22 0.01 30)',
          color: 'oklch(0.93 0.01 30)',
          font: '500 14.5px/1.45 Sora, sans-serif',
          padding: '12px 15px',
          borderRadius: '16px 4px 16px 16px',
          whiteSpace: 'pre-wrap',
        }}
      >
        {content}
      </div>
      <span
        style={{
          font: '500 10.5px Sora, sans-serif',
          color: 'oklch(0.42 0.01 30)',
          marginRight: '4px',
        }}
      >
        {time}
      </span>
    </div>
  )
}

function UserBubbleFailed({
  content,
  onRetry,
}: {
  content: string
  onRetry: () => void
}) {
  return (
    <div
      style={{
        alignSelf: 'flex-end',
        maxWidth: '78%',
        display: 'flex',
        flexDirection: 'column',
        gap: '5px',
        alignItems: 'flex-end',
      }}
    >
      <div
        style={{
          background: 'oklch(0.22 0.01 30)',
          color: 'oklch(0.6 0.01 30)',
          font: '500 14.5px/1.45 Sora, sans-serif',
          padding: '12px 15px',
          borderRadius: '16px 4px 16px 16px',
          opacity: 0.55,
          whiteSpace: 'pre-wrap',
        }}
      >
        {content}
      </div>
      <button
        onClick={onRetry}
        style={{
          background: 'none',
          border: 'none',
          padding: 0,
          display: 'flex',
          alignItems: 'center',
          gap: '5px',
          cursor: 'pointer',
        }}
      >
        <span
          style={{
            width: '6px',
            height: '6px',
            borderRadius: '50%',
            background: 'oklch(0.62 0.09 40)',
          }}
        />
        <span
          style={{
            font: '500 11.5px Sora, sans-serif',
            color: 'oklch(0.6 0.08 40)',
          }}
        >
          Couldn't send
        </span>
        <span
          style={{
            font: '600 11.5px Sora, sans-serif',
            color: 'oklch(0.74 0.17 350)',
          }}
        >
          · Tap to retry
        </span>
      </button>
    </div>
  )
}

function TypingDots() {
  const dot: CSSProperties = {
    width: '6px',
    height: '6px',
    borderRadius: '50%',
    background: 'oklch(0.88 0.05 350)',
  }
  return (
    <div
      style={{
        alignSelf: 'flex-start',
        display: 'flex',
        gap: '4px',
        padding: '13px 16px',
        background: 'oklch(0.2 0.04 350)',
        borderRadius: '4px 16px 16px 16px',
        width: 'fit-content',
        boxShadow: '0 0 0 1px oklch(0.4 0.06 350 / 0.5) inset',
      }}
    >
      {[0, 0.15, 0.3].map((delay) => (
        <span
          key={delay}
          style={{
            ...dot,
            animation: 'typingBounce 1.2s infinite',
            animationDelay: `${delay}s`,
          }}
        />
      ))}
    </div>
  )
}

const cardContainerStyle: CSSProperties = {
  alignSelf: 'center',
  textAlign: 'center',
  display: 'flex',
  flexDirection: 'column',
  gap: '10px',
  background: 'oklch(0.14 0.04 350 / 0.45)',
  borderRadius: '16px',
  padding: '16px 18px',
  marginTop: '6px',
  maxWidth: '86%',
}

const cardTextStyle: CSSProperties = {
  font: '500 13px/1.5 Sora, sans-serif',
  color: 'oklch(0.85 0.03 30)',
}

const cardActionStyle: CSSProperties = {
  background: 'none',
  border: 'none',
  padding: 0,
  font: '700 13px Sora, sans-serif',
  color: 'oklch(0.78 0.16 350)',
  cursor: 'pointer',
}

function RateLimitSessionCard() {
  return (
    <div style={cardContainerStyle}>
      <span style={cardTextStyle}>
        You've hit the free-preview limit for this session — reload to start over.
      </span>
      <button onClick={() => window.location.reload()} style={cardActionStyle}>
        ↻ Reload chat
      </button>
    </div>
  )
}

function RateLimitIpCard() {
  return (
    <div style={cardContainerStyle}>
      <span style={cardTextStyle}>
        Too many chats from your network right now. Try again in a bit.
      </span>
    </div>
  )
}

function ServiceDownCard() {
  return (
    <div style={cardContainerStyle}>
      <span style={cardTextStyle}>
        Service is temporarily unavailable. We're on it — try again in a bit.
      </span>
    </div>
  )
}

function formatTime(d: Date): string {
  const diffSec = (Date.now() - d.getTime()) / 1000
  if (diffSec < 60) return 'JUST NOW'
  const h = d.getHours()
  const m = d.getMinutes().toString().padStart(2, '0')
  const period = h >= 12 ? 'PM' : 'AM'
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h
  return `${h12}:${m} ${period}`
}
