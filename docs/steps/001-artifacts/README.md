# M0 Summarizer Test Scripts

Four sequential summarizer prompts used to validate `deepseek/deepseek-chat` in M0 (see `../001-m0-summarizer-refusal-spike.md` and design doc §12).

Each script embeds a system prompt that evolved across the four tests. Reading them in order tells the story of how §5.1's prompt spec was derived:

| Script | Prompt evolution | Cap |
|---|---|---|
| `m0-request.sh` | Baseline: "discard play-by-play, bias toward durable facts" | 500 target |
| `m0-request-v2.sh` | Adds explicit verbatim license for sexual specifics | 500 target |
| `m0-request-stress.sh` | Adds merge instructions, register-partitioning, register-specific pet name capture | 600 target |
| `m0-request-cnc.sh` | Adds consent framework as first-class section, pre-negotiated kink category terminology preservation | 1000 target — final spec |

## Running

Each script reads from `/tmp/*` scratch files (synthetic transcripts + prior response JSONs) that were not archived — the explicit test content is intentionally not preserved in the repo. To re-run any test you'd need to regenerate a synthetic transcript at the expected path.

## Purpose of keeping these

The **prompts themselves** are the durable artifact — future summarizer swaps (Sonnet 4.6, Kimi, etc.) can be evaluated against the same prompt structure to isolate model behavior from prompt behavior. The final prompt shape is also codified in design doc §5.1.
