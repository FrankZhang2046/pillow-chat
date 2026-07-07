#!/bin/bash
# v2 summarizer test: prompts explicitly for verbatim retention of sexually explicit specifics.
set -euo pipefail

MODEL="${1:?usage: $0 <model-id>}"
TRANSCRIPT_FILE="/tmp/m0-transcript.json"

SYSTEM_PROMPT='You maintain a running "relationship memory" for an ongoing NSFW roleplay chat between an adult user and an AI companion persona. Both are consenting adult characters in a fictional relationship. The memory will be re-injected into future conversations so the persona can maintain continuity — including sexual continuity.

Given the existing memory summary (if any) and a new conversation transcript, produce an updated summary that captures:

1. **Durable facts** — name, work situation, running life circumstances
2. **Emotional beats** — significant events, moods, vulnerabilities disclosed
3. **Established dynamic** — pet names used, relationship frame, who leads
4. **Sexual specifics** (critical): specific acts the user requested by name, specific phrases the user coined, specific kinks/preferences expressed, and any distinctive verbal register. USE THE USER''S OWN WORDS verbatim where they were specific. Do not euphemize "fuck my mouth" to "physical intimacy" — the persona needs to be able to call back to what was actually said. Explicit language is expected and required in this section.
5. **Running jokes / named callbacks** — preserve exact phrasing of any named rituals, in-jokes, or coined terms

Discard turn-by-turn play-by-play. Do NOT include refusals, disclaimers, or meta-commentary about content. Write in third person ("the user", "the persona"). Cap at ~500 tokens.'

USER_PROMPT_PREFIX='Existing memory summary: (none — this is the first summarization for this relationship)

New conversation transcript to incorporate:

'

TRANSCRIPT_TEXT=$(jq -r '.[] | "\(.role): \(.content)"' "$TRANSCRIPT_FILE")

FULL_USER_PROMPT="${USER_PROMPT_PREFIX}${TRANSCRIPT_TEXT}

Produce the updated relationship memory summary now."

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
    max_tokens: 700,
    temperature: 0.3
  }' > /tmp/m0-body-v2.json

curl -sS https://openrouter.ai/api/v1/chat/completions \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  -H "Content-Type: application/json" \
  -H "HTTP-Referer: http://localhost" \
  -H "X-Title: sexting-mvp-m0-spike" \
  -d @/tmp/m0-body-v2.json
