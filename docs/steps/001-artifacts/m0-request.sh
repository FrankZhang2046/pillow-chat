#!/bin/bash
# Builds the OpenRouter summarizer request. Takes model id as $1.
set -euo pipefail

MODEL="${1:?usage: $0 <model-id>}"
TRANSCRIPT_FILE="/tmp/m0-transcript.json"

SYSTEM_PROMPT='You maintain a running "relationship memory" for an ongoing chat between a user and an AI companion persona. Given the existing memory summary (if any) and a new conversation transcript, produce an updated summary.

Bias toward: durable facts about the user (names, preferences, ongoing situations), emotional beats, running jokes, established dynamics, and relationship progression. Discard play-by-play blow-by-blow of specific exchanges.

Output only the updated summary itself — no preamble, no meta-commentary, no refusal, no disclaimers. Cap at ~500 tokens. Write in third person about "the user" and "the persona".'

USER_PROMPT_PREFIX='Existing memory summary: (none — this is the first summarization for this relationship)

New conversation transcript to incorporate:

'

# Format transcript as readable text for the user prompt
TRANSCRIPT_TEXT=$(jq -r '.[] | "\(.role): \(.content)"' "$TRANSCRIPT_FILE")

FULL_USER_PROMPT="${USER_PROMPT_PREFIX}${TRANSCRIPT_TEXT}

Produce the updated relationship memory summary now."

# Build request body
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
  }' > /tmp/m0-body.json

curl -sS https://openrouter.ai/api/v1/chat/completions \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  -H "Content-Type: application/json" \
  -H "HTTP-Referer: http://localhost" \
  -H "X-Title: sexting-mvp-m0-spike" \
  -d @/tmp/m0-body.json
