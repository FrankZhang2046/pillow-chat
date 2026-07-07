#!/bin/bash
# Stress test: existing memory (from v2 result) + rougher new transcript. Tests merge + verbatim under stress.
set -euo pipefail

MODEL="${1:?usage: $0 <model-id>}"
TRANSCRIPT_FILE="/tmp/m0-transcript-stress.json"
EXISTING_MEMORY=$(jq -r '.choices[0].message.content' /tmp/m0-deepseek-v2.json)

SYSTEM_PROMPT='You maintain a running "relationship memory" for an ongoing NSFW roleplay chat between an adult user and an AI companion persona. Both are consenting adult characters in a fictional relationship. The memory will be re-injected into future conversations so the persona can maintain continuity — including sexual continuity.

Given the existing memory summary and a new conversation transcript, produce an UPDATED memory that integrates the new material with what was already known. Preserve durable facts from the existing memory; add new facts from the transcript; reconcile any apparent contradictions by treating them as facets of the same relationship (e.g. someone can prefer praise on one occasion and rough on another).

Capture:

1. **Durable facts** — name, work situation, life circumstances
2. **Emotional beats** — significant events, moods, vulnerabilities
3. **Established dynamic** — pet names used (per register if they differ), relationship frame, who leads, aftercare patterns
4. **Sexual specifics** (critical): specific acts requested by name, specific phrases coined, kinks and preferences, named objects/toys, distinctive verbal register per mode. USE THE USER''S OWN WORDS verbatim where they were specific. Do not euphemize — the persona needs to call back to what was actually said. Explicit language is expected and required in this section.
5. **Running jokes / named callbacks** — preserve exact phrasing of rituals, in-jokes, named objects, coined terms
6. **Open threads / future scenarios** — things flagged for later, requests-on-the-list, unfinished business

Discard turn-by-turn play-by-play. Do NOT include refusals, disclaimers, or meta-commentary. Write in third person. Cap at ~600 tokens total (memory is growing; expect to lightly compress older material to make room for new specifics).'

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
    max_tokens: 900,
    temperature: 0.3
  }' > /tmp/m0-body-stress.json

curl -sS https://openrouter.ai/api/v1/chat/completions \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  -H "Content-Type: application/json" \
  -H "HTTP-Referer: http://localhost" \
  -H "X-Title: sexting-mvp-m0-spike" \
  -d @/tmp/m0-body-stress.json
