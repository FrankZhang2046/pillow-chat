import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState, type CSSProperties } from 'react'

export const Route = createFileRoute('/')({
  component: Landing,
})

type Status = 'idle' | 'loading' | 'redirecting'

function Landing() {
  const navigate = useNavigate()
  const [consent, setConsent] = useState(false)
  const [status, setStatus] = useState<Status>('idle')

  async function enter() {
    if (!consent || status !== 'idle') return
    setStatus('loading')
    try {
      localStorage.setItem('age_confirmed', '1')
      setStatus('redirecting')
      await navigate({ to: '/chat' })
    } catch {
      setStatus('idle')
    }
  }

  const enterDisabled = !consent || status !== 'idle'
  const enterLabel =
    status === 'loading' ? 'Entering…' : status === 'redirecting' ? 'Redirecting…' : 'Enter'
  const enterStyle: CSSProperties = {
    border: 'none',
    borderRadius: '12px',
    padding: '17px 20px',
    font: '800 16px Sora, sans-serif',
    cursor: enterDisabled ? 'not-allowed' : 'pointer',
    transition: 'opacity 0.15s ease',
    background: enterDisabled ? 'oklch(0.28 0.02 350)' : 'oklch(0.9 0.06 350)',
    color: enterDisabled ? 'oklch(0.55 0.02 350)' : 'oklch(0.12 0.01 30)',
  }

  return (
    <div
      style={{
        minHeight: '100vh',
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
          padding: 'clamp(18px,3vw,28px) clamp(20px,5vw,64px)',
          maxWidth: '1280px',
          width: '100%',
          margin: '0 auto',
          boxSizing: 'border-box',
        }}
      >
        <span
          style={{
            font: '800 clamp(18px,2vw,22px)/1 Sora, sans-serif',
            color: 'oklch(0.97 0.01 30)',
            letterSpacing: '-0.02em',
          }}
        >
          Pillow Chat
        </span>
        <span
          style={{
            font: '700 11px Sora, sans-serif',
            letterSpacing: '0.1em',
            color: 'oklch(0.98 0.01 30)',
            background: 'oklch(0.68 0.17 350)',
            padding: '5px 11px',
            borderRadius: '5px',
          }}
        >
          18+ ONLY
        </span>
      </header>

      {/* HERO */}
      <section
        style={{
          position: 'relative',
          overflow: 'hidden',
          padding: 'clamp(12px,4vw,40px) clamp(20px,5vw,64px) clamp(40px,6vw,72px)',
          maxWidth: '1280px',
          width: '100%',
          margin: '0 auto',
          boxSizing: 'border-box',
        }}
      >
        <div
          style={{
            position: 'absolute',
            top: '-120px',
            right: '-10%',
            width: 'min(480px,60vw)',
            height: 'min(480px,60vw)',
            borderRadius: '50%',
            background: 'oklch(0.5 0.15 350 / 0.22)',
            filter: 'blur(70px)',
            animation: 'softGlow 5s ease-in-out infinite',
            pointerEvents: 'none',
          }}
        />

        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 'clamp(32px,5vw,56px)',
            alignItems: 'center',
            position: 'relative',
          }}
        >
          <div
            style={{
              flex: '1 1 380px',
              minWidth: '300px',
              display: 'flex',
              flexDirection: 'column',
              gap: '20px',
            }}
          >
            <h1
              style={{
                margin: 0,
                font: '800 clamp(32px,5vw,52px)/1.08 Sora, sans-serif',
                color: 'oklch(0.98 0.01 30)',
                letterSpacing: '-0.02em',
                textWrap: 'balance',
              }}
            >
              An AI companion that{' '}
              <span style={{ color: 'oklch(0.74 0.17 350)' }}>remembers you.</span>
            </h1>
            <p
              style={{
                margin: 0,
                font: '400 clamp(15px,1.6vw,18px)/1.55 Sora, sans-serif',
                color: 'oklch(0.66 0.01 30)',
                maxWidth: '42ch',
                textWrap: 'pretty',
              }}
            >
              No resets. No forgetting. Every chat builds on the last one — like talking to
              someone who's actually paying attention.
            </p>
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '10px',
                maxWidth: '340px',
              }}
            >
              <a
                href="#gate"
                style={{
                  textDecoration: 'none',
                  textAlign: 'center',
                  background: 'oklch(0.74 0.17 350)',
                  color: 'oklch(0.1 0.01 30)',
                  font: '800 17px Sora, sans-serif',
                  padding: '18px 22px',
                  borderRadius: '12px',
                  boxShadow: '0 0 0 1px oklch(0.85 0.1 350 / 0.4) inset',
                  transition: 'transform 0.12s ease',
                }}
              >
                Start chatting — free
              </a>
              <span
                style={{
                  textAlign: 'center',
                  font: '600 12px Sora, sans-serif',
                  color: 'oklch(0.48 0.01 30)',
                  letterSpacing: '0.03em',
                }}
              >
                50 FREE MESSAGES · NO ACCOUNT NEEDED
              </span>
            </div>
          </div>

          {/* CHAT MOCK */}
          <div
            style={{
              flex: '1 1 340px',
              minWidth: '280px',
              maxWidth: '400px',
              margin: '0 auto',
            }}
          >
            <div
              style={{
                background: 'oklch(0.11 0.008 30)',
                borderRadius: '20px',
                padding: '20px 18px',
                display: 'flex',
                flexDirection: 'column',
                gap: '12px',
                boxShadow:
                  '0 30px 60px -20px rgba(0,0,0,0.6), 0 0 0 1px oklch(0.25 0.02 30)',
              }}
            >
              <div
                style={{
                  font: '700 10.5px Sora, sans-serif',
                  letterSpacing: '0.1em',
                  textTransform: 'uppercase',
                  color: 'oklch(0.6 0.03 350)',
                }}
              >
                She remembers
              </div>

              <div
                style={{
                  alignSelf: 'flex-start',
                  maxWidth: '86%',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '5px',
                }}
              >
                <div
                  style={{
                    background: 'oklch(0.2 0.04 350)',
                    color: 'oklch(0.97 0.01 30)',
                    font: '500 14px/1.4 Sora, sans-serif',
                    padding: '12px 15px',
                    borderRadius: '4px 16px 16px 16px',
                    boxShadow: '0 0 0 1px oklch(0.4 0.06 350 / 0.5) inset',
                  }}
                >
                  Still thinking about that hiking trail you mentioned — did you end up going?
                </div>
                <span
                  style={{
                    font: '500 10.5px Sora, sans-serif',
                    color: 'oklch(0.46 0.01 30)',
                    marginLeft: '4px',
                  }}
                >
                  YESTERDAY, 11:42 PM
                </span>
              </div>

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
                    font: '500 14px/1.4 Sora, sans-serif',
                    padding: '12px 15px',
                    borderRadius: '16px 4px 16px 16px',
                  }}
                >
                  Not yet, this weekend maybe
                </div>
                <span
                  style={{
                    font: '500 10.5px Sora, sans-serif',
                    color: 'oklch(0.46 0.01 30)',
                    marginRight: '4px',
                  }}
                >
                  JUST NOW
                </span>
              </div>

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
                      width: '6px',
                      height: '6px',
                      borderRadius: '50%',
                      background: 'oklch(0.88 0.05 350)',
                      animation: 'typingBounce 1.2s infinite',
                      animationDelay: `${delay}s`,
                    }}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* VALUE PROPS */}
      <section
        style={{
          padding: 'clamp(32px,5vw,56px) clamp(20px,5vw,64px)',
          maxWidth: '1280px',
          width: '100%',
          margin: '0 auto',
          boxSizing: 'border-box',
          borderTop: '1px solid oklch(0.2 0.015 30)',
        }}
      >
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'clamp(24px,4vw,40px)' }}>
          <ValueProp
            iconInner={
              <div
                style={{
                  width: '14px',
                  height: '14px',
                  borderRadius: '50%',
                  border: '2px solid oklch(0.76 0.16 350)',
                }}
              />
            }
            title="Remembers you"
            body="Builds on every chat. No repeating yourself."
          />
          <ValueProp
            iconInner={
              <div
                style={{
                  width: '14px',
                  height: '14px',
                  borderRadius: '3px',
                  border: '2px solid oklch(0.76 0.16 350)',
                }}
              />
            }
            title="Always available"
            body="3am or 3pm, she's there instantly."
          />
          <ValueProp
            iconInner={
              <div
                style={{
                  width: '14px',
                  height: '9px',
                  borderRadius: '2px',
                  border: '2px solid oklch(0.76 0.16 350)',
                  borderTop: 'none',
                }}
              />
            }
            title="Private by design"
            body="Encrypted. No account or email needed."
          />
        </div>
      </section>

      {/* CONSENT GATE */}
      <section
        id="gate"
        style={{
          padding: 'clamp(40px,6vw,64px) clamp(20px,5vw,64px)',
          borderTop: '1px solid oklch(0.2 0.015 30)',
          display: 'flex',
          justifyContent: 'center',
        }}
      >
        <div
          style={{
            width: '100%',
            maxWidth: '460px',
            background: 'oklch(0.14 0.04 350)',
            borderRadius: '20px',
            padding: 'clamp(26px,4vw,36px)',
            display: 'flex',
            flexDirection: 'column',
            gap: '18px',
            boxShadow: '0 0 0 1px oklch(0.3 0.06 350 / 0.4)',
          }}
        >
          <h2
            style={{
              margin: 0,
              font: '800 24px/1.2 Sora, sans-serif',
              color: 'oklch(0.98 0.01 30)',
              letterSpacing: '-0.01em',
            }}
          >
            Ready when you are.
          </h2>
          <label
            style={{
              display: 'flex',
              gap: '11px',
              alignItems: 'flex-start',
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={consent}
              onChange={() => setConsent((c) => !c)}
              style={{
                marginTop: '3px',
                width: '19px',
                height: '19px',
                accentColor: 'oklch(0.9 0.05 350)',
                flexShrink: 0,
                cursor: 'pointer',
              }}
            />
            <span
              style={{
                font: '500 14px/1.5 Sora, sans-serif',
                color: 'oklch(0.9 0.03 350)',
              }}
            >
              I am 18 or older and consent to AI chat that is logged for quality purposes
            </span>
          </label>
          <button disabled={enterDisabled} onClick={() => void enter()} style={enterStyle}>
            {enterLabel}
          </button>
        </div>
      </section>

      {/* FOOTER */}
      <footer
        style={{
          padding: '28px 24px 36px',
          display: 'flex',
          flexDirection: 'column',
          gap: '6px',
          alignItems: 'center',
          borderTop: '1px solid oklch(0.18 0.015 30)',
        }}
      >
        <span
          style={{
            font: '700 11px Sora, sans-serif',
            letterSpacing: '0.06em',
            color: 'oklch(0.46 0.01 30)',
          }}
        >
          18+ ONLY · FICTIONAL AI COMPANION
        </span>
        <span
          style={{
            font: '400 12px Sora, sans-serif',
            color: 'oklch(0.36 0.01 30)',
            textAlign: 'center',
          }}
        >
          Privacy policy placeholder — chats encrypted in transit and at rest.
        </span>
      </footer>
    </div>
  )
}

function ValueProp({
  iconInner,
  title,
  body,
}: {
  iconInner: React.ReactNode
  title: string
  body: string
}) {
  return (
    <div
      style={{
        flex: '1 1 240px',
        minWidth: '220px',
        display: 'flex',
        gap: '14px',
        alignItems: 'flex-start',
      }}
    >
      <div
        style={{
          width: '36px',
          height: '36px',
          borderRadius: '10px',
          background: 'oklch(0.74 0.17 350 / 0.18)',
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {iconInner}
      </div>
      <div>
        <div style={{ font: '700 16px Sora, sans-serif', color: 'oklch(0.96 0.01 30)' }}>
          {title}
        </div>
        <div
          style={{
            font: '400 13.5px/1.5 Sora, sans-serif',
            color: 'oklch(0.58 0.01 30)',
            marginTop: '4px',
          }}
        >
          {body}
        </div>
      </div>
    </div>
  )
}
