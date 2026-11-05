# P1 Ollama benchmark results

Machine-local Ollama, model `qwen3:4b`; measurements ran sequentially against the same service. The benchmark source is `p1-ollama-benchmark.ts`.

## Twenty chapter storyboard

Three runs of seven batches compared the legacy `format: "json"` contract with JSON Schema output. The legacy run had 8/21 batch shape failures; schema output had 0/21. Neither variant returned `done_reason=length`.

| Metric | Legacy JSON | JSON Schema |
| --- | ---: | ---: |
| Requests | 21 | 21 |
| Shape failures | 8 | 0 |
| `eval_count` total | 10,295 | 10,514 |
| `eval_count` per shape-valid batch | 585.8 | 500.7 |
| Total wall time | 960.2 s | 984.6 s |

Per valid batch, the schema output used 14.5% fewer generated tokens. The raw totals include malformed legacy responses that would require the existing chapter retry path; retries were not included in this direct model comparison, so the raw totals and wall times do not demonstrate a full-job reduction.

## First token for long documents

The final short production prompt was measured on the first batch of a 20 chapter source. Each trial used a unique leading marker to prevent prompt-cache reuse; the three pairs alternated order. All six requests reported zero cached prompt tokens.

| Trial | Legacy JSON | JSON Schema | Change |
| --- | ---: | ---: | ---: |
| 1 | 8.680 s | 7.132 s | -17.8% |
| 2 | 9.094 s | 7.025 s | -22.7% |
| 3 | 9.037 s | 7.008 s | -22.5% |
| Median | 9.037 s | 7.025 s | -22.3% |
| Mean | 8.937 s | 7.055 s | -21.1% |

Prompt input was 562 tokens per legacy request and 449 per schema request. All three schema responses passed shape validation; the legacy responses failed shape validation in all three samples.

## Markdown table narration

The paired six-case run measured `eval_count` of 1,706 legacy tokens and 450 narration-only schema tokens (73.6% fewer). Cases were 3x3, 10x5, 31x4, bilingual, numeric formats, and surrounding prose. The legacy 10x5 output changed table data; all schema outputs used the exact locally parsed table. A subsequent run through the final local narration validator kept all six visuals exact and contained no unsupported numeric values. A unit regression also verifies model numbers such as `16.7` and `10` that do not exist in the table are replaced with safe narration.

## Limits

The full 21-request storyboard comparison used the earlier, longer instruction wording. The final shorter wording was then measured in the three-pair first-token run above, and its schema shape passed all three times. Benchmark results are from this local model and fixture and can vary with Ollama version, prompt cache, or hardware load.
