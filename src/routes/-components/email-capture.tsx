import { useState, type CSSProperties } from 'react'

type Source = 'landing' | 'wall'
type State = 'idle' | 'submitting' | 'done' | 'error'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

type Props = {
  source: Source
  buttonLabel: string
  doneLabel: string
  placeholder?: string
  variant?: 'landing' | 'wall'
}

export function EmailCaptureForm({
  source,
  buttonLabel,
  doneLabel,
  placeholder = 'your email',
  variant = 'landing',
}: Props) {
  const [email, setEmail] = useState('')
  const [state, setState] = useState<State>('idle')

  async function submit() {
    if (state === 'submitting') return
    const trimmed = email.trim()
    if (!EMAIL_RE.test(trimmed) || trimmed.length > 254) {
      setState('error')
      return
    }
    setState('submitting')
    try {
      const res = await fetch('/api/email-signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: trimmed, source }),
      })
      if (!res.ok) throw new Error('failed')
      setState('done')
    } catch {
      setState('error')
    }
  }

  if (state === 'done') {
    return <span style={doneTextStyle(variant)}>{doneLabel}</span>
  }

  const buttonText =
    state === 'submitting' ? 'Sending…' : state === 'error' ? 'Try again' : buttonLabel

  return (
    <div style={rowStyle(variant)}>
      <input
        type="email"
        inputMode="email"
        autoComplete="email"
        placeholder={placeholder}
        value={email}
        onChange={(e) => {
          setEmail(e.target.value)
          if (state === 'error') setState('idle')
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            void submit()
          }
        }}
        disabled={state === 'submitting'}
        style={inputStyle(variant)}
      />
      <button
        onClick={() => void submit()}
        disabled={state === 'submitting' || email.trim().length === 0}
        style={buttonStyle(variant, state)}
      >
        {buttonText}
      </button>
    </div>
  )
}

function rowStyle(variant: 'landing' | 'wall'): CSSProperties {
  if (variant === 'wall') {
    return {
      display: 'flex',
      flexDirection: 'column',
      gap: '8px',
      width: '100%',
      maxWidth: '280px',
      margin: '0 auto',
    }
  }
  return {
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    width: '100%',
  }
}

function inputStyle(variant: 'landing' | 'wall'): CSSProperties {
  const base: CSSProperties = {
    background: 'oklch(0.08 0.005 30)',
    border: '1px solid oklch(0.22 0.02 30)',
    borderRadius: '10px',
    padding: variant === 'wall' ? '10px 12px' : '14px 16px',
    font: `500 ${variant === 'wall' ? '13px' : '14px'} Sora, sans-serif`,
    color: 'oklch(0.95 0.01 30)',
    outline: 'none',
    width: '100%',
    boxSizing: 'border-box',
  }
  return base
}

function buttonStyle(
  variant: 'landing' | 'wall',
  state: State,
): CSSProperties {
  const disabled = state === 'submitting'
  return {
    border: 'none',
    borderRadius: '10px',
    padding: variant === 'wall' ? '10px 14px' : '14px 18px',
    font: `700 ${variant === 'wall' ? '13px' : '15px'} Sora, sans-serif`,
    cursor: disabled ? 'wait' : 'pointer',
    background: state === 'error' ? 'oklch(0.6 0.14 40)' : 'oklch(0.74 0.17 350)',
    color: 'oklch(0.12 0.01 30)',
    opacity: disabled ? 0.7 : 1,
    transition: 'opacity 0.15s ease, background 0.15s ease',
  }
}

function doneTextStyle(variant: 'landing' | 'wall'): CSSProperties {
  return {
    font: `600 ${variant === 'wall' ? '13px' : '14px'} Sora, sans-serif`,
    color: 'oklch(0.78 0.13 160)',
    textAlign: variant === 'wall' ? 'center' : 'left',
    display: 'block',
  }
}
