# Qwen3 4B CPU A/B 基准

- 日期：2026-11-01T08:47:15.362Z
- 环境：{"timestamp":"2026-11-01T08:47:15.362Z","os":"win32 x64","cpu":"Intel(R) Core(TM) Ultra 5 125H","logicalCpuCount":18,"physicalMemoryBytes":33786552320,"powerScheme":"Balanced (GUID 381b4222-f694-41f0-9685-ff5bb260df2e)","ollamaVersion":"ollama version is 0.40.13","baseUrl":"http://localhost:11434","defaults":{"stream":true,"keep_alive":"30m","num_ctx":4096,"maxConcurrency":1,"think":false},"models":[{"name":"qwen3:4b","model":"qwen3:4b","modified_at":"2026-10-08T23:33:14.6960227+08:00","size":2740938005,"digest":"15ab58b395867c33c78c8825bdbf3b3c96822c77dd92d937d1c1a4702b37c55d","details":{"parent_model":"qwen3-4b.gguf","format":"gguf","family":"qwen35","families":["qwen35"],"parameter_size":"4.2B","quantization_level":"Q4_K_M","context_length":262144,"embedding_length":2560,"runner":"llamacpp"},"capabilities":["tools","thinking","completion"]},{"name":"qwen3:4b-instruct-2507-q4_K_M","model":"qwen3:4b-instruct-2507-q4_K_M","modified_at":"2026-11-01T16:36:34.3289457+08:00","size":2497293803,"digest":"0edcdef34593eac1aa2be9c7d06c432dcf81945adca5eca2f27662c18f168ba0","details":{"parent_model":"","format":"gguf","family":"qwen3","families":["qwen3"],"parameter_size":"4.0B","quantization_level":"Q4_K_M","context_length":262144,"embedding_length":2560,"runner":"ggml"},"capabilities":["tools","thinking","completion"]}]}
- Warm run 数：3；两模型交错顺序；每条 prompt 首部写入唯一缓存标记。
- 普通/HTML 故事板每批最多 3 章；重生成 20 个固定案例；PPT Preserve 10 页（奇数页有演讲者备注）；Pronunciation 使用 Python 基准脚本的 64 个固定目标，单独运行并汇入结果。
- 原始调用输出与 Ollama 指标：同目录 qwen3-4b-cpu-raw.jsonl；生成文本仅来自固定基准资料。

## Web 工作负载结果

| 工作负载 | 模型 | 阶段 | wall ms | 请求 | retry | fallback | 无效场景 | 截断 | 汇总指标 |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| storyboard-standard | qwen3:4b | cold 0 | 296395 | 7 | 0 | 0 | 0 | 0 | {"prompt_eval_count":2317,"prompt_eval_cached_count":0,"prompt_eval_duration_ns":35504759000,"eval_count":2378,"eval_duration_ns":256060049000,"load_duration_ns":4428889800,"decode_tok_s":9.2868841089693} |
| storyboard-standard | qwen3:4b-instruct-2507-q4_K_M | cold 0 | 282061 | 7 | 0 | 0 | 0 | 0 | {"prompt_eval_count":2433,"prompt_eval_cached_count":34,"prompt_eval_duration_ns":35414516999,"eval_count":2321,"eval_duration_ns":239080899000,"load_duration_ns":7193318500,"decode_tok_s":9.708011010950733} |
| storyboard-standard | qwen3:4b-instruct-2507-q4_K_M | warm 1 | 230453 | 7 | 0 | 0 | 0 | 0 | {"prompt_eval_count":2432,"prompt_eval_cached_count":41,"prompt_eval_duration_ns":35452245000,"eval_count":1965,"eval_duration_ns":194566379000,"load_duration_ns":55818800,"decode_tok_s":10.09938104465623} |
| storyboard-standard | qwen3:4b | warm 1 | 291611 | 7 | 0 | 0 | 0 | 0 | {"prompt_eval_count":2310,"prompt_eval_cached_count":0,"prompt_eval_duration_ns":33852148000,"eval_count":2610,"eval_duration_ns":257374223000,"load_duration_ns":37116400,"decode_tok_s":10.140875685130288} |
| storyboard-standard | qwen3:4b | warm 2 | 253382 | 7 | 0 | 0 | 0 | 0 | {"prompt_eval_count":2312,"prompt_eval_cached_count":0,"prompt_eval_duration_ns":33757898000,"eval_count":2223,"eval_duration_ns":219184288000,"load_duration_ns":37143900,"decode_tok_s":10.14215033515541} |
| storyboard-standard | qwen3:4b-instruct-2507-q4_K_M | warm 2 | 221455 | 7 | 0 | 0 | 0 | 0 | {"prompt_eval_count":2426,"prompt_eval_cached_count":40,"prompt_eval_duration_ns":34877279000,"eval_count":1958,"eval_duration_ns":186139829000,"load_duration_ns":44446600,"decode_tok_s":10.518973883875224} |
| storyboard-standard | qwen3:4b-instruct-2507-q4_K_M | warm 3 | 230600 | 7 | 0 | 0 | 0 | 0 | {"prompt_eval_count":2442,"prompt_eval_cached_count":42,"prompt_eval_duration_ns":34901858000,"eval_count":2037,"eval_duration_ns":195236209000,"load_duration_ns":46806000,"decode_tok_s":10.43351543462924} |
| storyboard-standard | qwen3:4b | warm 3 | 265376 | 7 | 0 | 0 | 0 | 0 | {"prompt_eval_count":2315,"prompt_eval_cached_count":0,"prompt_eval_duration_ns":33934342000,"eval_count":2337,"eval_duration_ns":230901001000,"load_duration_ns":38999200,"decode_tok_s":10.121220739099352} |
| storyboard-html | qwen3:4b-instruct-2507-q4_K_M | cold 0 | 308078 | 7 | 0 | 0 | 0 | 0 | {"prompt_eval_count":3134,"prompt_eval_cached_count":35,"prompt_eval_duration_ns":46063014000,"eval_count":2227,"eval_duration_ns":255334304000,"load_duration_ns":6339290700,"decode_tok_s":8.721898958002917} |
| storyboard-html | qwen3:4b | cold 0 | 436677 | 7 | 0 | 0 | 0 | 0 | {"prompt_eval_count":2994,"prompt_eval_cached_count":0,"prompt_eval_duration_ns":45093149000,"eval_count":3109,"eval_duration_ns":385309732000,"load_duration_ns":5876884500,"decode_tok_s":8.068833309406262} |
| storyboard-html | qwen3:4b | warm 1 | 425398 | 7 | 0 | 4 | 4 | 0 | {"prompt_eval_count":2991,"prompt_eval_cached_count":0,"prompt_eval_duration_ns":45355527000,"eval_count":3062,"eval_duration_ns":379477314000,"load_duration_ns":47353000,"decode_tok_s":8.068993552536845} |
| storyboard-html | qwen3:4b-instruct-2507-q4_K_M | warm 1 | 295319 | 7 | 0 | 0 | 0 | 0 | {"prompt_eval_count":3134,"prompt_eval_cached_count":40,"prompt_eval_duration_ns":44894689000,"eval_count":2295,"eval_duration_ns":249885713000,"load_duration_ns":51416000,"decode_tok_s":9.184198537993247} |
| storyboard-html | qwen3:4b-instruct-2507-q4_K_M | warm 2 | 299283 | 7 | 0 | 0 | 0 | 0 | {"prompt_eval_count":3137,"prompt_eval_cached_count":41,"prompt_eval_duration_ns":44710988000,"eval_count":2367,"eval_duration_ns":254069964999,"load_duration_ns":47856000,"decode_tok_s":9.316331428664999} |
| storyboard-html | qwen3:4b | warm 2 | 385226 | 7 | 0 | 0 | 0 | 0 | {"prompt_eval_count":2991,"prompt_eval_cached_count":0,"prompt_eval_duration_ns":43505510000,"eval_count":3073,"eval_duration_ns":341248154000,"load_duration_ns":37898800,"decode_tok_s":9.005176918847157} |
| storyboard-html | qwen3:4b | warm 3 | 366378 | 7 | 0 | 3 | 3 | 0 | {"prompt_eval_count":2995,"prompt_eval_cached_count":0,"prompt_eval_duration_ns":43452475000,"eval_count":2905,"eval_duration_ns":322402695999,"load_duration_ns":42348400,"decode_tok_s":9.010470557631473} |
| storyboard-html | qwen3:4b-instruct-2507-q4_K_M | warm 3 | 335644 | 7 | 0 | 0 | 0 | 0 | {"prompt_eval_count":3146,"prompt_eval_cached_count":46,"prompt_eval_duration_ns":44769186000,"eval_count":2701,"eval_duration_ns":290358553000,"load_duration_ns":44249900,"decode_tok_s":9.302291846040438} |
| regenerate | qwen3:4b | cold 0 | 346372 | 20 | 0 | 0 | 0 | 0 | {"prompt_eval_count":6558,"prompt_eval_cached_count":0,"prompt_eval_duration_ns":99563036000,"eval_count":2224,"eval_duration_ns":239909067999,"load_duration_ns":5889516100,"decode_tok_s":9.270178983018976} |
| regenerate | qwen3:4b-instruct-2507-q4_K_M | cold 0 | 256816 | 20 | 0 | 0 | 0 | 0 | {"prompt_eval_count":6701,"prompt_eval_cached_count":131,"prompt_eval_duration_ns":99421867000,"eval_count":1466,"eval_duration_ns":147411871999,"load_duration_ns":9238039800,"decode_tok_s":9.944924924431765} |
| regenerate | qwen3:4b-instruct-2507-q4_K_M | warm 1 | 252955 | 20 | 0 | 0 | 0 | 0 | {"prompt_eval_count":6722,"prompt_eval_cached_count":138,"prompt_eval_duration_ns":99195255000,"eval_count":1511,"eval_duration_ns":152731909000,"load_duration_ns":179164200,"decode_tok_s":9.893152059010799} |
| regenerate | qwen3:4b | warm 1 | 357730 | 20 | 0 | 0 | 0 | 0 | {"prompt_eval_count":6539,"prompt_eval_cached_count":0,"prompt_eval_duration_ns":98160943000,"eval_count":2453,"eval_duration_ns":258176586998,"load_duration_ns":118127000,"decode_tok_s":9.501248848792793} |
| regenerate | qwen3:4b | warm 2 | 348164 | 20 | 0 | 0 | 0 | 0 | {"prompt_eval_count":6553,"prompt_eval_cached_count":0,"prompt_eval_duration_ns":102514434000,"eval_count":2235,"eval_duration_ns":244171880000,"load_duration_ns":117763400,"decode_tok_s":9.153388178851717} |
| regenerate | qwen3:4b-instruct-2507-q4_K_M | warm 2 | 245304 | 20 | 0 | 0 | 0 | 0 | {"prompt_eval_count":6717,"prompt_eval_cached_count":136,"prompt_eval_duration_ns":99590394000,"eval_count":1495,"eval_duration_ns":144657786000,"load_duration_ns":164000600,"decode_tok_s":10.334735801915288} |
| regenerate | qwen3:4b-instruct-2507-q4_K_M | warm 3 | 251305 | 20 | 0 | 0 | 0 | 0 | {"prompt_eval_count":6719,"prompt_eval_cached_count":138,"prompt_eval_duration_ns":97719760999,"eval_count":1539,"eval_duration_ns":152405529000,"load_duration_ns":151146700,"decode_tok_s":10.098058844046268} |
| regenerate | qwen3:4b | warm 3 | 356650 | 20 | 0 | 0 | 0 | 0 | {"prompt_eval_count":6564,"prompt_eval_cached_count":0,"prompt_eval_duration_ns":100258355000,"eval_count":2365,"eval_duration_ns":254334458000,"load_duration_ns":157925900,"decode_tok_s":9.298779326236636} |
| ppt-preserve | qwen3:4b-instruct-2507-q4_K_M | cold 0 | 79220 | 4 | 0 | 0 | 0 | 0 | {"prompt_eval_count":1576,"prompt_eval_cached_count":21,"prompt_eval_duration_ns":22945137000,"eval_count":460,"eval_duration_ns":46733787000,"load_duration_ns":9386064100,"decode_tok_s":9.842985761029809} |
| ppt-preserve | qwen3:4b | cold 0 | 102123 | 4 | 0 | 0 | 0 | 0 | {"prompt_eval_count":1517,"prompt_eval_cached_count":0,"prompt_eval_duration_ns":22979427000,"eval_count":669,"eval_duration_ns":72074605999,"load_duration_ns":6901761800,"decode_tok_s":9.282048659541504} |
| ppt-preserve | qwen3:4b | warm 1 | 98931 | 4 | 0 | 0 | 0 | 0 | {"prompt_eval_count":1513,"prompt_eval_cached_count":0,"prompt_eval_duration_ns":22720638000,"eval_count":732,"eval_duration_ns":75986453000,"load_duration_ns":25925800,"decode_tok_s":9.633296082395109} |
| ppt-preserve | qwen3:4b-instruct-2507-q4_K_M | warm 1 | 66796 | 4 | 0 | 0 | 0 | 0 | {"prompt_eval_count":1575,"prompt_eval_cached_count":27,"prompt_eval_duration_ns":22932871000,"eval_count":450,"eval_duration_ns":43681473000,"load_duration_ns":26189400,"decode_tok_s":10.301850397764747} |
| ppt-preserve | qwen3:4b-instruct-2507-q4_K_M | warm 2 | 71827 | 4 | 0 | 0 | 0 | 0 | {"prompt_eval_count":1579,"prompt_eval_cached_count":27,"prompt_eval_duration_ns":23279366000,"eval_count":473,"eval_duration_ns":48353336000,"load_duration_ns":23469800,"decode_tok_s":9.782158567094523} |
| ppt-preserve | qwen3:4b | warm 2 | 99333 | 4 | 0 | 0 | 0 | 0 | {"prompt_eval_count":1511,"prompt_eval_cached_count":0,"prompt_eval_duration_ns":23161993000,"eval_count":713,"eval_duration_ns":75931503000,"load_duration_ns":21955400,"decode_tok_s":9.39004196980007} |
| ppt-preserve | qwen3:4b | warm 3 | 101836 | 4 | 0 | 0 | 0 | 0 | {"prompt_eval_count":1519,"prompt_eval_cached_count":0,"prompt_eval_duration_ns":22878008000,"eval_count":730,"eval_duration_ns":78710066000,"load_duration_ns":21027700,"decode_tok_s":9.27454437657313} |
| ppt-preserve | qwen3:4b-instruct-2507-q4_K_M | warm 3 | 72347 | 4 | 0 | 0 | 0 | 0 | {"prompt_eval_count":1579,"prompt_eval_cached_count":26,"prompt_eval_duration_ns":23765975000,"eval_count":469,"eval_duration_ns":48336686000,"load_duration_ns":41476500,"decode_tok_s":9.702775237839019} |

## 冷启动与 warm 汇总

JSON
[
  {
    "workload": "storyboard-standard",
    "model": "qwen3:4b",
    "cold_ms": 296395,
    "warm_p50_ms": 265376,
    "warm_p95_ms": 291611,
    "warm_runs": 3
  },
  {
    "workload": "storyboard-standard",
    "model": "qwen3:4b-instruct-2507-q4_K_M",
    "cold_ms": 282061,
    "warm_p50_ms": 230453,
    "warm_p95_ms": 230600,
    "warm_runs": 3
  },
  {
    "workload": "storyboard-html",
    "model": "qwen3:4b",
    "cold_ms": 436677,
    "warm_p50_ms": 385226,
    "warm_p95_ms": 425398,
    "warm_runs": 3
  },
  {
    "workload": "storyboard-html",
    "model": "qwen3:4b-instruct-2507-q4_K_M",
    "cold_ms": 308078,
    "warm_p50_ms": 299283,
    "warm_p95_ms": 335644,
    "warm_runs": 3
  },
  {
    "workload": "regenerate",
    "model": "qwen3:4b",
    "cold_ms": 346372,
    "warm_p50_ms": 356650,
    "warm_p95_ms": 357730,
    "warm_runs": 3
  },
  {
    "workload": "regenerate",
    "model": "qwen3:4b-instruct-2507-q4_K_M",
    "cold_ms": 256816,
    "warm_p50_ms": 251305,
    "warm_p95_ms": 252955,
    "warm_runs": 3
  },
  {
    "workload": "ppt-preserve",
    "model": "qwen3:4b",
    "cold_ms": 102123,
    "warm_p50_ms": 99333,
    "warm_p95_ms": 101836,
    "warm_runs": 3
  },
  {
    "workload": "ppt-preserve",
    "model": "qwen3:4b-instruct-2507-q4_K_M",
    "cold_ms": 79220,
    "warm_p50_ms": 71827,
    "warm_p95_ms": 72347,
    "warm_runs": 3
  }
]


## 多音字 warm 结果

| 模型 | 正确率（192 个目标） | wall P50 / P95（ms） | prompt / decode tokens | fallback / 截断 |
| --- | ---: | ---: | ---: | ---: |
| qwen3:4b | 80.73% | 159921 / 171850 | 19059 / 1512 | 0 / 0 |
| qwen3:4b-instruct-2507-q4_K_M | 79.69% | 241939 / 244523 | 19383 / 2164 | 0 / 0 |

每轮使用 64 个固定目标，冷启动另行记录，完整结果见 `services/python/tests/qwen-pronunciation-qwen3-4b.json` 和 `services/python/tests/qwen-pronunciation-qwen3-4b-instruct-2507-q4_K_M.json`。Instruct warm 正确率低 1.04 个百分点，wall P50 高约 51.3%。

## 质量复核

- Web 请求均成功解析 JSON/schema。20 章分镜与重生成 warm 样本中，两模型都没有不受源文支持的数字声明，也没有“这一页可以讲”等元话语。
- HTML warm run：qwen3:4b 有 7/60 个场景因 comparison/chart/timeline 视觉结构不完整而 fallback；Instruct 为 0/60。两模型都没有重试或长度截断。
- Preserve：本地 `media` 场景组装、图片映射、fullBleed 和页码校验全部通过。逐页数字与固定页文案对照后，qwen3:4b 有 7/40 页数字不符；3 轮 warm 的第 7–9 页还重复相同的跨页旁白。Instruct 有 2/40 页数字不符（两次都是第 1 页把“400 公里”写成“40 及公里”）；warm 第 1、2 轮逐页数字一致，未发现相邻页重复旁白。
- 各项复核可从固定 fixture、逐页 narration 和 Ollama 指标重算：Web 原始调用在 `qwen3-4b-cpu-raw.jsonl`，发音原始请求数据在上述两个 JSON 文件。

## 结论与限制

Instruct 在四类 Web workload 的 warm wall P50 均较低：普通分镜快 13.2%，HTML 快 22.3%，重生成快 29.5%，PPT Preserve 快 27.7%。主要收益来自生成 token 更少，decode tok/s 仅小幅提高；多音字任务则更慢且准确率略低。

当前只在一台 Intel Core Ultra 5 125H CPU 电脑完成测试，不能代表其他 CPU 类别。按 issue 的两类 CPU 机器门槛，默认仍为 `qwen3:4b`；README 已提供 instruct 可选配置。待至少两类 CPU 机器的结果方向一致后，再考虑调整通用默认值。

## 复现

在仓库根目录运行 Web workload：

```powershell
$env:QWEN_BENCHMARK_WARM_RUNS = '3'
pnpm exec tsx apps/web/test/qwen-model-benchmark.ts
```

在 `services/python` 目录分别运行多音字基准（每个模型执行一次冷启动和 3 次 warm）：

```powershell
uv run --no-sync python benchmark_pronunciation.py --comparison-profile --model qwen3:4b --output tests/qwen-pronunciation-qwen3-4b.json --trials 3
uv run --no-sync python benchmark_pronunciation.py --comparison-profile --model qwen3:4b-instruct-2507-q4_K_M --output tests/qwen-pronunciation-qwen3-4b-instruct-2507-q4_K_M.json --trials 3
```
