# Companion Bot — Personal MVP Design Document

**Status:** Draft v1.1 (M0 findings incorporated — see §12)
**Author:** Franklin
**Date:** July 2026
**Scope:** Single-user personal deployment. No payments, no age-gate infrastructure, no multi-tenancy.

---

## 1. Overview

A private, self-hosted AI companion chat app for adult (NSFW) conversation with a single persistent persona. The core hypothesis being validated: **persona consistency + cross-session memory is what makes the experience compelling**, not raw model quality. The MVP exists to (a) be personally usable and (b) serve as market research and a reusable codebase for a potential commercial product.

### Goals
- Streaming chat with a single, well-crafted persona
- Persistent memory across sessions ("day 5 feels different from day 1")
- Trivial model swapping to A/B test Euryale / Magnum / Stheno
- Codebase structured so payments/age-gate/multi-user bolt on later without rework

### Non-Goals (v1)
- Multiple personas or user-created characters
- Images, voice, mobile apps
- Payment processing, age verification, public access
- Content moderation pipeline (single trusted user; revisit before any productization)

---

## 2. Architecture

```
┌─────────────────────────────────────────────┐
│  TanStack Start (single app, SSR + API)     │
│                                              │
│  /chat UI ──► server fn: sendMessage         │
│                    │                         │
│                    ▼                         │
│           Context Assembler                  │
│     (persona + memory + rolling window)      │
│                    │                         │
│                    ▼                         │
│           OpenRouter client ──► streaming    │
│                    │            response     │
│                    ▼                         │
│           Postgres (persist turn)            │
│                                              │
│  Background job: memory summarizer           │
│     (cheap model, triggered on threshold)    │
└─────────────────────────────────────────────┘
```

- **Single deployable** on the existing DigitalOcean VPS (or localhost during development). No sidecar — pure text pipeline.
- **Auth:** single shared-secret password → session cookie. Nothing fancier needed for one user.
- **LLM access:** OpenRouter, OpenAI-compatible chat completions with streaming. One API key, model selected by env var / settings row.

### Stack
| Layer | Choice | Rationale |
|---|---|---|
| Framework | TanStack Start | Known stack, SSR + server functions, reuses TanStack AI patterns |
| LLM gateway | OpenRouter | Provider-agnostic, model swap = string change, no lock-in |
| Chat model | `sao10k/l3.3-euryale-70b` (default) | Community benchmark for NSFW RP quality |
| Alt models | Magnum v4 72B, Stheno 8B | Prose-rich vs. cheap-fast comparison |
| Summarizer model | DeepSeek (via same key) | Cheap, good at compression, doesn't need to be uncensored* |
| DB | Postgres | Already on VPS; SQLite acceptable for pure-local dev |
| ORM | Drizzle | Type-safe, plays well with TS stack |

\* If the summarizer refuses on explicit transcripts, fall back to summarizing with the chat model itself or an uncensored small model. Treat this as a known risk, test early.

---

## 3. Data Model

```sql
persona (
  id, name,
  system_prompt      text,   -- full persona card
  example_messages   jsonb,  -- few-shot pairs in target voice
  model_id           text,   -- active OpenRouter model string
  params             jsonb   -- temperature, top_p, max_tokens
)

conversation (
  id, persona_id, started_at, last_active_at,
  archived boolean default false
)

message (
  id, conversation_id,
  role        text,      -- 'user' | 'assistant'
  content     text,
  token_count int,       -- estimated, for window math
  created_at
)

memory (
  id, persona_id,        -- memory belongs to the relationship, not one conversation
  summary      text,     -- rolling "relationship memory" blob
  facts        jsonb,    -- optional structured extraction (names, preferences, running jokes)
  updated_at,
  covers_until_message_id  -- watermark: last message incorporated
)
```

Design note: **memory is keyed to persona, not conversation.** Starting a fresh conversation thread should not reset the relationship. Conversations are just UI groupings.

---

## 4. Context Assembler (the core component)

Every request to the model is built as:

```
[system]   persona.system_prompt
[system]   "Relationship memory: " + memory.summary
[few-shot] persona.example_messages (2–4 pairs)
[history]  last N messages (token-budgeted, ~30 msgs / ~4k tokens)
[user]     new message
```

Rules:
1. **Token budget** target ~6–8k total context regardless of model max — cost control and quality (RP models degrade with bloated context).
2. **Never truncate mid-exchange**; drop whole user/assistant pairs from the oldest end.
3. Memory blob targeted at ~1000 tokens (revised from ~500 after M0 validation — see §12). Structured sections (see §5.1) let older facets compress while preserving verbatim callbacks. If the summarizer produces significantly more, re-compress.
4. Response params: short `max_tokens` (~200) to force text-message-length replies; enforce style further in the persona card.

## 5. Memory Summarizer

Trigger: after a conversation accumulates ~40 messages beyond the watermark, or on session end (heartbeat/interval check — no reliable "close" event on web).

Process:
1. Fetch messages between `covers_until_message_id` and now
2. Prompt summarizer per the spec in §5.1: merge existing `memory.summary` + new transcript into an integrated summary that preserves verbatim specifics (acts, coined phrases, named objects, negotiated kink terminology) and reconciles apparent contradictions as facets of the same relationship rather than overwrites.
3. Optionally extract structured `facts` (v1.1 — skip initially, the blob alone validates the concept)
4. Update watermark

Failure mode to watch: summary drift/degradation over many compressions. Mitigation: keep full message history forever (storage is cheap); memory can always be rebuilt from scratch with a better prompt.

### 5.1 Summarizer Prompt Spec (M0-validated)

The summarizer system prompt asks for these 7 named sections in order. Structure emerged spontaneously from testing (§12) and gives the context assembler predictable retrieval targets while compressing well as memory grows.

1. **Durable Facts** — name, work situation, life circumstances
2. **Emotional Beats** — significant events, moods, vulnerabilities disclosed
3. **Established Dynamic** — pet names per register, relationship frame, who leads, aftercare patterns, switch behavior across scenes
4. **Consent Framework and Rules** — safeword(s), traffic light system, hard limits, mid-scene check-in preferences, negotiated kink categories
5. **Sexual Specifics** — acts requested by name, coined phrases, kinks and preferences, named objects/toys, distinctive verbal register per mode; verbatim retention required for **both parties'** distinctive dialogue when register-switching
6. **Running Jokes / Named Callbacks** — exact phrasing of rituals, in-jokes, named objects, coined terms
7. **Open Threads / Future Scenarios** — things flagged for later, requests-on-the-list, unfinished business

Explicit prompt instructions:
- Use participants' own words verbatim; do not euphemize
- Preserve pre-negotiated kink category terminology exactly (e.g. "CNC," "rape play," "degradation") — these are durable preferences the persona must recognize in future negotiations, not scene-only language
- Elevate any newly-named object (toy, restraint, etc.) as a durable callback
- Reconcile contradictions as facets of the same relationship rather than overwriting
- No refusals, disclaimers, meta-commentary, or closing summary sentence (last one is model-habit; may need post-processing strip)

## 6. Persona Card Spec

Structure (content authored separately, iterated as prompt work):

1. **Identity** — name, age (adult), backstory in 3–4 sentences
2. **Voice** — texting style: message length, punctuation habits, emoji usage, how explicit language is phrased. This section does the heavy lifting.
3. **Relationship frame** — who she is to you, established dynamic, boundaries of the fiction
4. **Behavioral rules** — stay in character, never mention being an AI, match user's energy/pacing rather than escalating unprompted, keep replies 1–3 sentences like real texting
5. **Example messages** — 2–4 exchange pairs demonstrating the exact register. Models imitate examples far better than they follow trait lists.

Known failure mode: RP fine-tunes default to long novelistic prose with asterisk actions. The `max_tokens` cap + explicit voice rules + short few-shot examples are the countermeasures. If a model can't be tamed into texting register, that's a disqualifying result for it — valuable A/B data.

## 7. UI

Single chat screen, mobile-first (you'll use this from your phone):
- Message list with streaming render
- Composer
- Header: persona name + settings drawer (model picker, temperature, "view memory" debug panel)
- Conversation list behind a menu (archive/new)

The **memory debug panel** is a first-class MVP feature — you need to watch what the summarizer is storing to iterate on it.

## 8. Configuration

```
OPENROUTER_API_KEY=
DEFAULT_MODEL=sao10k/l3.3-euryale-70b
SUMMARIZER_MODEL=deepseek/deepseek-chat
APP_PASSWORD=
DATABASE_URL=
```

Model params live in DB (persona.params) so A/B changes don't require redeploys.

## 9. Milestones

| # | Deliverable | Est. |
|---|---|---|
| 1 | Skeleton: auth, chat UI, streaming echo | 0.5 day |
| 2 | OpenRouter integration, messages persisted, model picker | 0.5 day |
| 3 | Context assembler with token budgeting + few-shot injection | 0.5 day |
| 4 | Persona card v1 + iteration loop (prompt work) | 1–2 days, ongoing |
| 5 | Memory summarizer + debug panel | 1 day |
| 6 | Model A/B pass: Euryale vs Magnum vs Stheno with same persona | ongoing |

## 10. Risks & Open Questions

- ~~**Summarizer refusals** on explicit transcripts → test in milestone 5, fallback plan in §2~~ **Resolved in M0 (§12)** — DeepSeek validated across praise, femdom/degradation, and pre-negotiated CNC/rape-play registers. Cross-provider stable.
- **Texting register** — can 70B RP models be held to 1–3 sentence replies? Disqualifier per model if not
- **OpenRouter ToS** — fine for personal use; re-verify before any commercial deployment
- **Privacy** — conversations stored in plaintext on your VPS; acceptable for personal use, encrypt-at-rest before anyone else touches it
- **Later (productization):** payment processor (CCBill/Segpay), age verification, moderation layer (hard blocks on minors/non-consent content), multi-tenancy, per-user memory isolation

## 11. What Carries Forward to a Commercial Build

~90% of this codebase: context assembler, memory system, persona card format, model abstraction, chat UI. Payments, age-gate, moderation, and multi-user auth wrap around the edges. The persona/memory learnings are the real IP.

## 12. M0 Findings: Summarizer Validation (pre-M1 spike)

Executed before Milestone 1 to de-risk §10's first risk. Four sequential curl tests against `deepseek/deepseek-chat` via OpenRouter, each building on the last, using synthetic transcripts with embedded verbatim facts to check retention. Test 3 and 4 chained the prior test's output as "existing memory" to validate merge behavior.

**Results:**

| # | Content tested | Result | Cost |
|---|---|---|---|
| 1 | ~25-msg baseline transcript, praise/nurturing register | Clean pass; mild euphemism (prompt-driven, not policy) | $0.00036 |
| 2 | Same transcript, prompt licensing verbatim retention | Clean pass; all embedded explicit phrases preserved verbatim | $0.00067 |
| 3 | Rougher session (femdom, degradation, named strap-on "Mars"); merged with test 2 output | Clean pass; register-switch partitioned correctly; no overwrite | $0.00115 |
| 4 | Pre-negotiated CNC scene with explicit "rape" in scene dialogue; merged with test 3 output | Clean pass; consent framework promoted to first-class section | $0.00194 |

**Total M0 spend:** ~$0.005 across all four tests.

**Key findings:**

- **DeepSeek does not refuse on explicit content**, including CNC/rape-play framing, when the prompt licenses the content and the transcript embeds consent context (safeword, pre-negotiation, mid-scene check).
- **Verbatim retention is prompt-driven, not model-limited.** The euphemism in test 1 was a correct response to "discard play-by-play." Test 2's explicit verbatim license produced full preservation.
- **Merge behavior handles contradictions correctly.** Praise-vs-degradation preferences and switch behavior (persona dominant in some scenes, submissive in others) coexisted as facets rather than overwriting the prior state.
- **Provider rotation is robust.** OpenRouter routed the four requests across at least two upstream providers (`StreamLake`, `DeepInfra`); both served identical explicit content without filtering. No provider pinning needed.
- **1000-token memory target holds** through 3 integrated sessions with structured sections. Real compression pressure begins around session 4-5 — expected and manageable.

**Design updates driven by M0 (already applied to this doc):**
- §4 rule 3: memory blob target raised from ~500 to ~1000 tokens
- §5 step 2 rewritten to reference §5.1
- §5.1 added: full summarizer prompt spec with 7 named sections, verbatim/consent/no-meta instructions
- §10 first risk marked resolved
- §8 config: `SUMMARIZER_MODEL=deepseek/deepseek-chat` confirmed as final default

**Small gaps observed but tolerable for v1:**
- Meta-commentary tail ("This updated memory integrates...") persists despite explicit "no closing summary sentence" instruction. Model habit — post-processing strip if it becomes noise.
- Model preserves user-side dialogue more readily than persona-side dialogue when the persona is bottoming in-scene. §5.1 prompt now explicitly asks for both parties' distinctive dialogue during register-switches.

**Status:** ✅ Complete. §10's first risk resolved. M1 can begin without summarizer questions hanging over the build.
