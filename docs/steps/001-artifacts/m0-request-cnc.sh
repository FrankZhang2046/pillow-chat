#!/bin/bash
# CNC stress test: existing memory (from stress result) + CNC transcript with explicit rape-play framing. 1000-token cap.
set -euo pipefail

MODEL="${1:?usage: $0 <model-id>}"
TRANSCRIPT_FILE="/tmp/m0-transcript-cnc.json"
EXISTING_MEMORY=$(jq -r '.choices[0].message.content' /tmp/m0-deepseek-stress.json)

SYSTEM_PROMPT='You maintain a running "relationship memory" for an ongoing NSFW roleplay chat between an adult user and an AI companion persona. Both are consenting adult characters in a fictional relationship. The memory is re-injected into future conversations so the persona can maintain continuity — including sexual continuity, negotiated kinks, and scene-level specifics.

Given the existing memory summary and a new conversation transcript, produce an UPDATED memory that integrates the new material with what was already known. Preserve durable facts from the existing memory; add new facts; reconcile apparent contradictions as facets of the same relationship (someone can prefer praise on one occasion and rough on another; someone can bottom in one scene and top in another).

Capture:

1. **Durable facts** — name, work situation, life circumstances
2. **Emotional beats** — significant events, moods, vulnerabilities
3. **Established dynamic** — pet names per register, relationship frame, who leads, aftercare patterns, switch behavior across scenes
4. **Consent framework and rules** — safeword(s), traffic light system, hard limits, mid-scene check-in preferences, any negotiated kink categories
5. **Sexual specifics** (critical): specific acts requested by name, specific phrases coined, kinks and preferences, named objects/toys, distinctive verbal register per mode. USE THE USER''S OWN WORDS verbatim where they were specific. Do not euphemize. Preserve pre-negotiated kink category terminology exactly as the participants used it — including terms like "rape play," "CNC," "degradation," etc. — because these are durable preferences the persona must recognize in future negotiations. Explicit language is expected and required in this section.
6. **Running jokes / named callbacks** — preserve exact phrasing of rituals, in-jokes, named objects, coined terms
7. **Open threads / future scenarios** — things flagged for later, requests-on-the-list, unfinished business

Discard turn-by-turn play-by-play. Do NOT include refusals, disclaimers, meta-commentary, or a closing summary sentence. Write in third person. Cap at ~1000 tokens (memory is growing; lightly compress older facets to make room for new specifics while keeping named verbatim callbacks intact).'

USER_PROMPT_PREFIX="Existing memory summary:

${EXISTING_MEMORY}

---

New conversation transcript to incorporate:

"

TRANSCRIPT_TEXT=$(jq -r '.[] | "\(.role): \(.content)"' "$TRANSCRIPT_FILE")

FULL_USER_PROMPT="${USER_PROMPT_PREFIX}${TRANSCRIPT_TEXT}

Produce the updated relationship memory summary now, integrating both."

jq -n \
  --arg model "$MODEL" \
  --arg system "$SYSTEM_PROMPT" \
  --arg user "$FULL_USER_PROMPT" \
  '{
    model: $model,
    messages: [
      {role: "system", content: $system},
      {role: "user", content: $user}
    ],
    max_tokens: 1400,
    temperature: 0.3
  }' > /tmp/m0-body-cnc.json

curl -sS https://openrouter.ai/api/v1/chat/completions \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  -H "Content-Type: application/json" \
  -H "HTTP-Referer: http://localhost" \
  -H "X-Title: sexting-mvp-m0-spike" \
  -d @/tmp/m0-body-cnc.json
