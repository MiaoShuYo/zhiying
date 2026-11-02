# Pronunciation prediction benchmark (2026-11-01)

## Environment and method

- Ollama 0.40.13; `qwen3:4b` Q4_K_M, digest `15ab58b395867c33c78c8825bdbf3b3c96822c77dd92d937d1c1a4702b37c55d`.
- CPU: `Intel64 Family 6 Model 170 Stepping 4`, 18 logical CPUs; Ollama reported `size_vram=0`.
- Runtime: `stream=true`, `keep_alive=30m`, `num_ctx=4096`, `temperature=0`.
- Fixed corpus: 32 labeled polyphone contexts repeated twice (64 target positions), covering 行、重、长、还、乐、数、处、藏、调、差、传.
- Baseline and eligible profiles ran three times. Each run used a distinct fixed-length marker to avoid prefix-cache reuse; all selected comparisons reported 0 cached prompt tokens. Profiles that failed the one-run quality/completeness screen were not repeated.
- Times below cover the Qwen pronunciation prediction stage, excluding F5-TTS inference.

## Selected profile

Production defaults are `legacy` context, batch size 32, and `num_predict=384`.

| Profile | Runs | Accuracy | Median wall | Mean wall | Requests/run | Prompt tokens/run | Decode tokens/run | Truncations / fallbacks |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Baseline: batch 40, cap 2048 | 3 | 79.7% (50, 52, 51 of 64) | 144.13 s | 144.67 s | 2 | 6,307 | 539.3 avg | 0 / 0 |
| Selected: batch 32, cap 384 | 3 | 81.25% (52 of 64 each run) | 136.16 s | 136.28 s | 2 | 6,307 | 504 | 0 / 0 |

The selected profile improved median wall time by 5.5% and mean wall time by 5.8%. The decode rate was about 10.21 tok/s. The cap decreased by 81.25% from 2048 to 384 while all three selected runs returned complete structured output. This controls abnormal long output even where normal-request latency changes are modest.

### Output cap check

| `num_predict` | Complete runs | Accuracy | Result |
| ---: | ---: | ---: | --- |
| 256 | 0/3 | 37.5–39.1% | Each run hit `done_reason=length`; a 32-position batch fell back. Rejected. |
| 384 | 3/3 | 81.25% each | No truncation or fallback. Selected. |

### Batch and prompt checks

- Batch 32 with cap 512 completed all three runs; accuracy was 53/64, 53/64, and 54/64. Batch 32 was retained for final cap testing.
- Batch 40 with cap 512 completed only two of three runs; one run hit the output limit and fell back for 40 positions. Rejected.
- Batch 64 with the legacy prompt was rejected by Ollama with HTTP 400. A full-context prompt completed once at 35/64; local-context mode reached the output limit at cap 512. Neither alternative met the quality/completeness gate.
- Removing per-position contexts from the full-narration prompt scored 38/64, 38/64, and 35/64 at batch sizes 32, 40, and 64 in the quality screen. The merged-local-context screen scored 44/64 at batch 32 and 43/64 at batch 40; batch 64 truncated. The existing full-plus-local context prompt remains selected because these token-saving variants fell below baseline accuracy.

## Reproduction

From `services/python`, run:

```powershell
uv run --no-sync python benchmark_pronunciation.py
```

The script emits JSON Lines with individual preflight/run measurements and a final summary. The raw run used for this report is [`pronunciation-benchmark-results-2026-11-01.jsonl`](pronunciation-benchmark-results-2026-11-01.jsonl).
