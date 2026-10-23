<p align="center">
  <img src="apps/web/public/brand/zhiying-logo.svg" alt="知影 Local Studio" width="292">
</p>

# 知影：本地 AI 知识视频生成器

知影（Local Studio）是一个运行在 Windows 本机的 PDF、PPTX、Markdown、公开网页和文本讲解视频工作台。它使用 Ollama 整理内容和生成分镜，用 F5-TTS 根据用户提供的声音参考生成旁白，最后由 Remotion 和 FFmpeg 导出横屏或竖屏 1080p H.264 MP4。导出后还能检查字幕与语音问题、校验成片文件，并把 MP4、字幕、封面和项目备份打包成交付 ZIP。项目源文件、声音参考、图片素材、生成音频和视频默认保存在本地；网页抽取和 Wikimedia Commons 搜索/下载仅在用户主动操作时访问互联网。

## 功能

### 资料导入与故事板生成

- 支持 PDF、PPTX、Markdown（`.md` / `.markdown`）、粘贴文本和无需登录的公开网页正文。导入后先显示抽取结果，允许检查页序、预览和编辑正文，再继续生成故事板。
- PDF 可提取文本；扫描页可选用本地 Tesseract OCR（需自行安装程序和语言包）。PPTX 支持提取内容重建或保留原页画面；保留原页需要本机安装 PowerPoint 或 LibreOffice，备注可优先作为旁白依据。
- 网页抽取面向公开文章，不访问登录内容；会阻止本机和私有网络地址，并在抽取失败时提供错误信息，用户可改用粘贴文本。
- 本地 Ollama 分析资料、生成讲稿与故事板。长文按章节/批次生成并保存检查点；输入和配置未变时可从失败步骤继续。

### 分镜编辑与画面

- 提供标题、要点、图示、对比、图表、代码、时间线、公式和图片场景；支持添加、复制、删除、排序、编辑旁白、时长和画面 JSON，并可逐场景重新生成语音。
- 故事板可实时预览。支持 Minimal Tech、Clean Light、Academic、Social Short 和 Whiteboard 风格；可从内置或自建模板插入场景，保存当前场景为可复用模板。
- 场景支持自动、纵向、并排和紧凑版式；可批量选择场景并调整时长或应用样式。长文本、密集内容和竖屏布局会自动适配，并显示可跳转到问题场景的排版提示。

### 旁白、节奏与字幕

- 可建立项目声音档案，上传参考音频并填写对应转录；本地 F5-TTS 根据声音参考生成语音。没有项目专属声音时可使用通用声音。
- 支持调整全项目生成语速和单场景语速、句间停顿、场景结束后的间隔；编辑后只重新生成受影响场景，也可单独重生成或强制重生成全部场景。支持场景试听和单句/片段试听。
- 逐词字幕由本地对齐模型生成时间轴。可选择简洁、底板或醒目预设，并设置字幕开关、位置、字号、文字颜色、底板颜色及透明度；支持导出 SRT、VTT 和 ASS。缺少对齐数据时会按场景时长估算时间。
- 提供场景、项目及全局中文读音纠正规则；规则变化会使包含受影响词语的场景语音失效，供重新生成。

### 图片与项目素材

- 项目素材库保存图片、参考音频和背景音乐，可预览、替换、删除并查看来源、许可与署名信息。图片场景支持完整显示或裁切填充、缩放及水平/垂直焦点调整。
- 可导入本地图片，或主动搜索 Wikimedia Commons。选用 Commons 图片前会展示许可、署名和注意事项供确认；素材及其来源信息随项目保存，并可在成片中显示署名。

### 预览、渲染与导出

- Remotion 实时预览和导出 16:9（1920×1080）或 9:16（1080×1920）、30 FPS H.264 MP4；支持 540p 草稿导出，以较低分辨率快速审片。
- 可添加本地背景音乐，调整音量、淡入和淡出。渲染记录显示排队、资源准备、画面渲染、编码等阶段进度及失败原因；运行中的任务可以取消。
- 每次新导出保存为独立视频并在项目历史记录中提供下载。V1.0 多次导出共用的 `final.mp4` 被覆盖后无法还原，对应记录会标记为不可用且不提供错误下载。

### 项目管理、备份与环境诊断

- 项目、故事板、素材、音频、任务和导出记录保存在本地 SQLite/项目目录。故事板自动保存，并提供保存状态、错误和版本冲突提示；生成或导出前也会先保存。
- 可复制项目、创建并下载完整 `.m2v` 项目包、手动创建快照、锁定重要快照，以及从快照或项目包恢复为新项目。自动快照每项目每 5 分钟最多创建一次，保留最近 10 份未锁定版本；锁定版本不参与轮转。
- 项目包包含源文件、项目素材、参考音频、场景旁白及仍存在的独立历史视频，不包含模型权重。恢复会保留可用导出及其记录；已被覆盖且不存在的旧视频无法从备份恢复。
- 首页环境自检检查 Python 服务、Ollama 服务及所需模型、FFmpeg/ffprobe、F5-TTS 模型与依赖、OCR 和渲染 Worker，并给出诊断及修复提示；不会自动下载模型或安装系统依赖。
- 长文生成和渲染任务会保留状态、进度、错误或检查点；可在项目列表或项目页面查看并继续/重试适用的任务。

### V1.2 可控性与恢复

- 字幕时间轴上可直接编辑每条字幕的文本与起止时间，修改后立即在预览生效；SRT、VTT、ASS 导出与画面字幕共用同一份时间轴。旁白、语速或停顿变化后手动时间轴自动失效，回到自动切分。
- 抽取复核按页显示 OCR 状态与识别质量，可只重跑选定页面；表格、列表和页序各有独立复核视图（表格检查列数与空单元格、列表检查编号与层级、页序检查重复/缺页/乱序），均可定位到对应页面；故事板场景卡片显示来源页（如“第 2 页”），点击后打开该页只读正文并可前后翻页，方便回查和修改。旧版记录没有逐页状态时会按页数补齐「需复核」行，重跑一页不会让其它页面从列表中消失。
- 「任务中心」集中列出长文生成、语音生成与渲染的进度、失败原因和可执行的重试方式；长文任务标出已完成与待处理章节，重试不会重复入队。失败渲染的「重新渲染」会先跑导出前检查，发现问题时列出具体场景并要求确认风险后才入队，同时按当前分镜重新渲染。
- 导出前检查缺失图片、无音频场景、字幕溢出与时长不足，可跳转到对应场景；面板同时显示预计时长、分辨率和导出档位，存在错误时需显式确认才能入队。
- 片头、片尾与场景转场为可选设置，字幕偏移与预计时长与其自动对齐。
- 素材库新增占用统计与“未被场景引用的素材”清单，删除前会再校验引用关系（仍被引用则拒绝），只清理 `projects/<id>/assets` 下的文件；快照支持逐文件校验并报告缺失或损坏项。
- 项目列表支持按名称或正文搜索、按状态筛选，以及按更新时间、创建时间或名称排序。

### V1.3 成片质检与交付

- 项目页新增「质检交付」标签页，集中完成成片质检、成片文件校验、打包交付与导出预设四件事。
- 字幕质检检查过长、停留时间不足、时间重叠、超出场景时长与空字幕；每条问题标明场景和「第几条字幕」，可一键定位回分镜的字幕精修面板；修正保存后重新检查即可确认清零。
- 语音质检逐场景用 FFmpeg 测量旁白，报告缺失、静音、异常偏短以及时长与场景差异过大的问题，可试听或直接重新生成该场景语音；本机没有 FFmpeg 时只跳过语音测量并说明原因，字幕检查照常可用。
- 成片文件校验读取导出文件的分辨率、时长与音视频轨道：无法读取、空文件、缺少视频轨道为阻断问题，分辨率与时长偏差、缺少音频轨道只作提醒。导出记录会显示「成片校验：通过 / 文件不可用 / N 项提醒」及分辨率、时长与音频轨道，并提供「校验成片文件 / 重新校验成片」；文件不可用时在「质检交付」里给出原因与「重新渲染成片」入口。
- 交付包一键把成片 MP4、SRT/VTT/ASS 字幕、封面图、项目备份（`.m2v`）与交付说明打成 ZIP，文件名带项目名与时间戳；字幕取自该次渲染的分镜快照，与成片使用同一时间轴。存在阻断问题时拒绝打包并提示先处理或重新渲染；质检结论为阻断时「生成交付包 ZIP」按钮直接置灰并说明还差几项，服务端也会拒绝打包。封面优先从成片截帧，缺少 FFmpeg 时回退到项目图片。
- 导出预设保存画幅、字幕样式与片头片尾设置，可保存、复用与删除；应用预设只修改这三类设置，不改动分镜、旁白与素材。

### V1.4 稳定性与交付体验

- 质检结论改为四态（待检查 / 通过 / 提醒 / 阻断）并写入 `data/projects/<id>/qc-report.json`；分镜修改后自动回到「待检查」但保留上次摘要，不再把过期结论当成通过。
- 补齐质检边界：关闭字幕显示时只统计条目、背景音乐缺失/静音/无音轨、场景低于最短播放时长、最近一次渲染失败（带失败原因与「前往渲染导出」入口）；没有 FFmpeg 时只跳过音频测量并说明原因。
- 语音质检区分「没写台词」与「写了台词却没有音频」：前者是刻意的静音场景（纯图注页、纯图表页），计入 `AudioQc.silent` 且不报任何问题，面板写明「另有 N 个场景没有写台词，按有意静音处理」；后者才报 `audio_missing` 阻断。所以本该无声的场景清空台词即可通过门禁，不必为了消除阻断去合成一段没有意义的旁白。
- 校验失败后可直接重新渲染；导出记录用 `videoState` 区分「本次成片 / 已被后续导出覆盖 / 文件缺失」，最新一次的失败不会把更早的成功标成最新，历史记录的旧结论仍可查看。
- 交付包生成结果落到 `data/projects/<id>/delivery/<jobId>.json`：记录状态、文件名、体积、文件数与重试次数，失败时按「成片渲染 / 成片校验 / 视频文件 / 字幕时间轴 / 封面图 / 项目备份 / 打包 ZIP」列出缺失环节；导出记录可再次下载或重新生成，ZIP 被清理后明确提示需重新生成。
- 备份恢复加固：损坏包、缺媒体、重复名称与中断恢复都有明确报错与清理，恢复永远新建项目（`（恢复）`、`（恢复 2）`…），失败时原项目保持不变。
- 导出预设支持重命名、复制与设为默认；应用前先列出「会修改哪些导出设置」的前后对照，取消则完全不写入。
- 任务中心给出可操作的失败原因（渲染失败 / 语音失败 / 内容生成取消 / 渲染取消 / 疑似中断），并按任务类型提供「从中断处继续」「从头执行」「重新渲染」「重新生成语音」等动作。
- 人工验收清单见 `doc/V1.4_manual_acceptance.md`。

### V1.5 制作效率与成片精修

- 导出前检查改成可操作清单：缺失的图片、语音、字幕与素材文件按「文件」归并，一行就能看清影响到几个场景，每个场景都能直接跳到分镜处理；检查结果的分类计数与列表一致，可只筛选某一类。
- 面板会说清“这次修好了几项、又新增了几项”，两个版本之间用 `preflightDelta` 对比，不用自己数。
- 导出拆成「检查 → 渲染 → 校验 → 打包」四步，`resumeFrom` 永远指向第一个没通过的步骤；已通过的步骤不会重做，分镜改动后检查自动作废并说明原因。
- 「成片精修」标签页在真实 MP4 上对照字幕时间：点轨道上的字幕块跳到那一刻复看，改起止时间或文本后播放器立刻按新时间显示，并可一键跳回所属场景；成片接口支持 `Range` 与 `HEAD`，拖动进度条返回 206 而不是重下整段。
- 字幕改动只影响时间与文本，保存后 SRT / VTT / ASS 与交付包同步更新；已经烧进画面的字幕才需要重新导出，面板把这条差别写在提示里。
- 「批量选择与调整」先给影响范围再动手：影响表逐行列出「场景 / 字段 / 现在 / 之后」，可批量改字幕样式、语速、句间停顿、场景时长、场景间隔与版式；改语速会明确提示语音需要重新生成，并支持撤销上一次批量修改。
- 素材管理分区显示被引用、未使用、缺失、重复与归档；重复项按内容 sha256 判定，缺失项直接指出引用它的场景。
- 「替换素材」只改勾选的场景，未勾选的保持原样、旧素材不会被归档；全部替换完才归档，归档区可恢复或彻底删除（删除需二次确认，仍被引用时服务端拒绝）。
- 「制作方案」把声音、语速与停顿、场景间隔、画幅、字幕样式、片头片尾、转场、背景音乐音量与导出画质组成一份可复用方案，可保存、重命名、复制、设为默认，上限 30 份；旁白、分镜内容、素材与发音规则不会被修改。
- 应用方案前先看前后对照（区分项目级与场景级），一致项不再报改动；语速或停顿有变化的场景会清掉旧语音与旧字幕时间，返回里列出受影响场景数。

应用以本地服务为主，不提供云端生成或复杂协作。公开网页抽取和 Commons 搜索/下载仅在用户主动操作时访问互联网。

## 基本使用流程

1. 新建项目，导入资料或粘贴文本，检查并编辑抽取结果；选择画幅、视觉风格及 PPTX 处理方式。
2. 检查并编辑故事板，调整场景内容、版式、顺序和时长；按需使用模板、批量调整或添加本地/Commons 图片。
3. 配置声音参考音频和转录，生成并试听旁白；设置语速、停顿和场景间隔，检查字幕及中文读音规则。
4. 在实时预览中检查画面和排版，设置可选的本地 BGM；需要时先导出 540p 草稿审片。
5. 导出 MP4，查看阶段进度或取消任务；完成后从导出记录下载视频，并按需创建项目快照或备份。
6. 交付前在「质检交付」检查字幕与语音问题、校验成片文件，再生成交付包 ZIP；常用的画幅、字幕样式和片头片尾可保存为导出预设复用。

## 系统与硬件要求

下表是本地开发和生成视频的建议配置，不是应用的硬性检测门槛。CPU 推理可以运行，但语音生成会明显变慢。

| 项目 | 最低/建议 |
| --- | --- |
| 操作系统 | Windows 10 22H2 或 Windows 11，64 位 |
| CPU | 现代 4 核处理器；生成时 CPU 核心越多越好 |
| 内存 | 16 GB 起步；同时运行 Ollama 和 F5-TTS 建议 32 GB |
| 磁盘空间 | 为依赖、模型和缓存预留至少 25 GB；导出视频另占空间 |
| 图形设备 | 可选。Intel Arc/XPU 可加速 F5-TTS；建议有 8 GB 或更多显存/共享显存。无可用 XPU 时会回退 CPU |
| 视频编码 | Intel Quick Sync 可选；没有可用硬件编码器时由 FFmpeg 使用 libx264 |

当前 Python 依赖锁定 PyTorch XPU 版本，语音加速路径针对 Intel XPU。NVIDIA 或 AMD 显卡不会启用此 XPU 路径，语音服务会按 CPU 路径运行。Ollama 是否能使用图形设备由 Ollama 和对应驱动决定。

## 所需软件

| 软件 | 版本/用途 |
| --- | --- |
| Git 与 Git LFS | 克隆仓库和获取 Git LFS 中的大模型权重 |
| Node.js | 20.19 或更高版本；运行 Next.js 和 Remotion Worker |
| Corepack 与 pnpm | 仓库固定使用 pnpm 11.25.0 |
| Python | **3.13.x**；Python 文档解析和语音服务 |
| uv | 创建 Python 虚拟环境并按锁文件安装依赖；TTS extra 使用 F5-TTS 1.1.22、PyTorch/TorchAudio 2.10.0+xpu 和 TorchCodec 0.10.x |
| Ollama for Windows | 本地大语言模型服务，默认 API 地址 `http://localhost:11434` |
| FFmpeg | **8.x full-shared**，需包含 `ffmpeg.exe`、`ffprobe.exe` 和共享 DLL |
| Chromium/Chrome | Remotion 会优先使用本机 Chrome；找不到时会下载渲染所需浏览器 |
| PowerPoint 或 LibreOffice | 可选；用于 PPTX“保留原页画面”导出。未安装时仍可使用内容重建模式 |
| Intel Graphics Driver | 使用 Intel Arc/XPU 或 Quick Sync 时需要；建议安装设备厂商提供的当前稳定驱动 |

Remotion 渲染及 F5-TTS 音频处理都需要 FFmpeg。Python 服务必须能通过 `PATH` 找到 `ffmpeg` 和 `ffprobe`。TorchCodec 0.10 与 FFmpeg 4–8 兼容，因此此项目建议使用 FFmpeg 8 full-shared；不建议使用 FFmpeg 9。

## 使用的本地模型

| 用途 | 模型 ID/文件 | 放置位置 |
| --- | --- | --- |
| 分析资料、生成讲稿和分镜 | Ollama `qwen3:4b` | Ollama 管理；用 `ollama pull qwen3:4b` 下载 |
| F5-TTS 声音克隆 | [`SWivid/F5-TTS`](https://huggingface.co/SWivid/F5-TTS)：`F5TTS_v1_Base/model_1250000.safetensors`、`F5TTS_v1_Base/vocab.txt` | `<仓库>\data\models\f5-tts\F5TTS_v1_Base\` |
| F5-TTS 声码器 | [`charactr/vocos-mel-24khz`](https://huggingface.co/charactr/vocos-mel-24khz)：`config.yaml`、`pytorch_model.bin` | `<仓库>\data\models\f5-tts\vocos-mel-24khz\` |
| 可选 Qwen GGUF 副本 | `data/models/qwen3-4b/qwen3-4b.gguf` | 仓库提供 Git LFS 分片；运行 `scripts\restore-qwen-model.ps1` 还原 |

F5-TTS 基础模型权重约 1.35 GB，Vocos 权重约 55 MB；首次 Ollama 模型下载还需要额外空间。F5-TTS 模型仓库标注为 CC BY-NC 4.0，使用前请查看模型卡中的许可条件。

目录示例：

```text
M2V/
└─ data/
   └─ models/
      └─ f5-tts/
         ├─ F5TTS_v1_Base/
         │  ├─ model_1250000.safetensors
         │  └─ vocab.txt
         └─ vocos-mel-24khz/
            ├─ config.yaml
            └─ pytorch_model.bin
```

F5-TTS、Vocos 和可选 Qwen GGUF 权重随仓库通过 Git LFS 提交，合计约 4 GB；Hugging Face 下载缓存、用户素材和生成媒体不会提交。首次克隆前安装 Git LFS，克隆后执行 `git lfs pull` 获取权重。Qwen GGUF 被拆为两个 LFS 文件以满足 GitHub 单文件大小限制；如需完整 GGUF，运行 `scripts\restore-qwen-model.ps1`。模型权重许可仍适用，F5-TTS 模型仓库标注为 CC BY-NC 4.0，请勿将其用于违反许可的场景。

## Windows 环境变量

克隆项目并进入仓库根目录后，把模型、缓存和项目数据放到 D 盘或其他有足够空间的磁盘。下面以 FFmpeg 安装在 `D:\Tools\ffmpeg-8.1.2-full-shared\bin` 为例。用普通 PowerShell 执行：

```powershell
# 将兼容 TorchCodec 的 FFmpeg 8 放在当前 Windows 用户 PATH 最前面
$ffmpegBin = 'D:\Tools\ffmpeg-8.1.2-full-shared\bin'
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$pathEntries = @($userPath -split ';' | Where-Object { $_ -and $_.TrimEnd('\') -ne $ffmpegBin.TrimEnd('\') })
[Environment]::SetEnvironmentVariable('Path', (@($ffmpegBin) + $pathEntries -join ';'), 'User')

# 把大型模型与 Hugging Face 缓存放到 D 盘
[Environment]::SetEnvironmentVariable('OLLAMA_MODELS', 'D:\AI\Ollama\models', 'User')
[Environment]::SetEnvironmentVariable('HF_HOME', 'D:\AI\huggingface', 'User')

# 明确将 Python 服务数据放在当前仓库的 data 目录（可选）
$repoRoot = (Get-Location).Path
[Environment]::SetEnvironmentVariable('M2V_DATA_DIR', (Join-Path $repoRoot 'data'), 'User')
```

执行后退出并重新打开终端。若 Ollama 已在系统托盘运行，还要从托盘退出并重新启动 Ollama，之后再下载模型。`OLLAMA_MODELS` 是 Ollama 模型目录；`HF_HOME` 是 Hugging Face 下载缓存；`M2V_DATA_DIR` 是 Python 服务的媒体、项目数据和模型根目录。若仓库移动到其他位置，请更新 `M2V_DATA_DIR`。不设置 `M2V_DATA_DIR` 时，Python 服务会使用默认的仓库 `data` 目录。

确认 FFmpeg 已生效：

```powershell
where.exe ffmpeg
where.exe ffprobe
ffmpeg -version
ffprobe -version
```

若输出为空或找不到命令，请确认 `PATH` 指向包含这两个 exe 的 `bin` 目录，并重新启动服务终端。启动 Python 服务后可查看 [`http://localhost:8000/health`](http://localhost:8000/health)；应确认 `ffmpeg`、`ffprobe` 和所需的 `tts` 状态为 `true`。

## 初始化项目

### 1. 安装 Node.js、Corepack 和 pnpm

安装 Git、Git LFS 和 Node.js 20.19+ 后，在 PowerShell 执行：

```powershell
git clone https://github.com/MiaoShuYo/zhiying.git
cd zhiying
git lfs install
git lfs pull
corepack enable
corepack prepare pnpm@11.25.0 --activate
node --version
pnpm --version
```

如果 `npm` 命令异常，仓库仍可通过 Corepack 调用 pnpm；不要用 `npm install` 安装项目依赖。

### 2. 安装 Ollama 和分析模型

安装并启动 Ollama for Windows，然后执行：

```powershell
ollama pull qwen3:4b
ollama list
```

Ollama 默认监听 `http://localhost:11434`。如需调整模型 ID 或服务地址，在 `apps/web/.env` 中修改 `OLLAMA_MODEL` 或 `OLLAMA_BASE_URL`。

### 3. 安装 Web 和 Worker 依赖

在仓库根目录执行：

```powershell
Copy-Item apps\web\.env.example apps\web\.env
pnpm install
pnpm db:generate
pnpm db:push
```

`apps/web/.env` 默认连接仓库 `data` 目录里的 SQLite 数据库，并配置 Ollama 和 Python 服务地址。仅在使用不同端口或服务主机时才需要编辑它。

### 4. 安装 Python 3.13 语音服务

安装 Python 3.13.x 和 uv。可用 WinGet 安装 uv：

```powershell
winget install --id=astral-sh.uv -e
```

然后在仓库根目录执行：

```powershell
cd services\python
uv sync --python 3.13 --extra tts
```

`--extra tts` 会在 Python 文档服务依赖外安装锁定版本的 F5-TTS、PyTorch XPU、TorchAudio 和 TorchCodec。若只需要 PDF 解析、不需要语音克隆，可以省略 `--extra tts`。

逐词字幕对齐复用 `tts` extra 中的 PyTorch/TorchAudio/Transformers 依赖。首次使用时会从 Hugging Face 下载中文或英文 wav2vec2 对齐模型；模型随后缓存在本机。PPT 保留原页模式需要安装 PowerPoint 或 LibreOffice。网页抽取和 Commons 图片搜索会在用户主动导入/搜索时访问互联网。

### 一键启动和停止

完成上述依赖安装并配置 `apps\web\.env` 后，在仓库根目录运行：

```powershell
.\start.ps1
```

脚本会使用 FFmpeg 8 full-shared，同时启动 Python 服务、Next.js 界面和渲染 Worker，并将日志写入 `logs`。网页地址为 [`http://127.0.0.1:3000`](http://127.0.0.1:3000)。如果 FFmpeg 8 安装在其他位置，运行 `.\start.ps1 -FFmpegBin 'D:\你的路径\bin'`。脚本不会自动启动 Ollama；生成分镜前仍需确保 Ollama 正在运行。停止这些服务时运行 `.\stop.ps1`。

如果 PowerShell 禁止执行脚本，可使用 `pwsh -ExecutionPolicy Bypass -File .\start.ps1`。下面的命令也可用于分别启动服务。

在 `services\python` 目录单独启动 Python 服务：

```powershell
uv run uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload --reload-dir app
```

`--reload-dir app` 限定热重载监视应用源码，避免虚拟环境里的模型库文件变化反复触发服务重启。打开 `http://localhost:8000/health` 查看服务状态。

### 5. 单独启动 Web 和渲染 Worker

在仓库根目录的另一个 PowerShell 窗口执行：

```powershell
pnpm dev
```

此命令会同时启动 Next.js 界面和本地渲染 Worker。打开 [`http://localhost:3000`](http://localhost:3000)。导出 MP4 时请保持 Ollama、Python 服务和 Worker 终端运行。

## 环境变量参考

Web 配置位于 `apps/web/.env`；可复制 `apps/web/.env.example` 后修改：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DATABASE_URL` | `file:../../../data/m2v.db` | Prisma SQLite 数据库地址 |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama 本地 API |
| `OLLAMA_MODEL` | `qwen3:4b` | 资料分析和分镜模型 |
| `PYTHON_SERVICE_URL` | `http://127.0.0.1:8000` | PDF 解析和 TTS 服务 |

Python 服务可使用 Windows 用户环境变量：

| 变量 | 默认/示例 | 说明 |
| --- | --- | --- |
| `M2V_DATA_DIR` | `<仓库>\data` | SQLite 以外的项目媒体、模型和音频数据根目录 |
| `HF_HOME` | `D:\AI\huggingface` | Hugging Face 模型缓存目录 |
| `F5TTS_MODEL_DIR` | `$M2V_DATA_DIR\models\f5-tts\F5TTS_v1_Base` | 可选，覆盖 F5-TTS 模型目录 |
| `F5TTS_VOCODER_DIR` | `$M2V_DATA_DIR\models\f5-tts\vocos-mel-24khz` | 可选，覆盖 Vocos 声码器目录 |
| `OLLAMA_MODELS` | `D:\AI\Ollama\models` | 可选，将 Ollama 模型存储到其他磁盘 |
| `Path` | 加入 FFmpeg 的 `bin` 目录 | 让 Python 和 Worker 都能找到 `ffmpeg.exe` / `ffprobe.exe` |

设置 Windows 用户环境变量后需重启相关终端；修改 `OLLAMA_MODELS` 后需完全退出并重启 Ollama。Python 服务默认从启动目录推导仓库 `data`，所以通常不必单独设置 `M2V_DATA_DIR`。

## 常用命令

```powershell
pnpm dev          # 启动 Web 和 Worker
.\start.ps1       # 同时启动 Python、Web 和 Worker
.\stop.ps1        # 停止 start.ps1 启动的服务
pnpm build        # 构建所有 TypeScript 工作区
pnpm typecheck    # 类型检查
pnpm test         # 共享 Schema 测试
pnpm test:v13     # V1.3 质检与交付测试（含面板渲染检查）
pnpm test:v13:integration  # V1.3 集成测试（真实 MP4 与 ZIP 需 FFmpeg）
pnpm test:v14     # V1.4 稳定性测试（四态质检、交付包记录、导出记录渲染）
pnpm test:v14:integration  # V1.4 全链路集成测试（含真实 MP4 与 ZIP，需 FFmpeg）
pnpm test:v15     # V1.5 制作效率与成片精修测试（导出检查归并、导出流程、批量、制作方案、Range 解析）
pnpm test:v15:integration  # V1.5 集成测试（真实路由与数据库，无需 FFmpeg）
pnpm db:generate  # 生成 Prisma Client
pnpm db:push      # 同步 SQLite 数据库结构
```

## 本地数据与 Git

项目数据库、上传素材、参考音频、生成旁白、渲染视频、模型缓存和日志均保存在本机。`.gitignore` 会排除这些内容，以及 `.env`、虚拟环境和构建缓存；只提交 `.env.example` 作为无密钥的配置模板。交付包 ZIP 保存在 `data/projects/<id>/delivery/`（每个项目保留最近 5 个），导出预设保存在 `data/settings/export-presets.json`，二者同样不纳入 Git。请勿把私人参考录音、转录文本或生成视频手动加入 Git。

## 支持范围与限制

当前支持 PDF/PPTX/Markdown/公开文章 URL/粘贴文本输入，16:9 与 9:16 输出，title/bullets/diagram/comparison/chart/code/timeline/math/media 场景，Minimal Tech、Clean Light、Academic、Social Short 和 Whiteboard 五种风格，PPTX 双模式，场景编辑与重试，声音克隆、逐词字幕与字幕时间轴精修、Commons 图片、本地 BGM、实时预览、导出前检查、片头片尾与转场、任务中心恢复入口、素材占用与快照校验、项目搜索筛选排序、成片质检（字幕与语音）、成片文件校验、交付包 ZIP、导出预设和 MP4 导出。旧项目默认保持 16:9。品牌套件和云端模型 Provider 暂不支持。

- **PDF**：优先读取可选择的文本；扫描页使用本地 Tesseract OCR，需要 chi_sim 与 eng 语言包及 TESSDATA_PREFIX。环境自检会显示缺失项；也可粘贴已识别的文字。
- **网页**：仅支持无需登录的公开文章；本机、内网或非公开网络地址会被拒绝。页面抽取失败时可粘贴正文。
- **PPTX**：内容重建不依赖演示软件；保留原页画面依赖本机 PowerPoint 或 LibreOffice。两者都不可用时，该模式会被禁用并显示提示。
- **网络与模型**：分镜及语音在本机处理。网页导入、Commons 搜索和素材下载需要网络；首次逐词对齐会下载对应语言的模型并缓存到本机。
- **音乐与图片许可**：不附带 BGM 曲库，需自行导入音频。Commons 图片由用户主动搜索和选择；使用时请检查素材许可及其署名信息。
- **生成结果**：AI 分镜和语音需要人工检查。读音纠正规则可覆盖中文多音字的自动判断；修改规则后需重新生成受影响场景的语音，并重新导出视频。
- **PPTX 抽取的旁白需人工清理**：从 PPTX 导入时，页面上的版面文字、页码（如 `1 / 2`）和图片署名会一并写进场景旁白。质检只判断“有没有音频”，不判断台词是否适合朗读，所以这类场景直接生成语音会把页码念出来。导出前应改写或清空这些台词——清空后该场景按有意静音处理，不再报缺失旁白。


### 中文多音字与人工纠音

生成语音前，系统使用现有的本机 Ollama 模型（`OLLAMA_BASE_URL`、`OLLAMA_MODEL`）结合完整旁白选择多音字读音，并校验输出只能采用该字的候选读音。随后把确定的逐字拼音直接接入 F5-TTS 的分段合成，避免内部再次分词猜音。该适配针对项目锁定的 F5-TTS 1.1.22。参考音频与旁白分别处理；字幕仍显示原文。

在故事板的旁白下方展开“中文读音纠正”，填写汉字和带声调数字的拼音，例如 `几行代码` / `ji3 hang2 dai4 ma3`。可以先在旁白中选中文字，只标注该处，也可保存为场景、项目或所有项目的词组规则。`v` 表示 ü，5 表示轻声。位置标注优先，其次为场景、项目、通用规则，最后才由模型和词典判断。修改旁白会清除位置标注，避免错位。

场景和项目规则随故事板保存；通用词典保存在 `data/settings/pronunciation.json`。添加或删除规则后，保存分镜并重新生成受影响场景的语音。全局规则对其他项目的已有音频不会自动重写，需要在对应项目重新生成。新音频使用独立文件名避免浏览器复用旧缓存；重新导出才能更新已有视频。

自动判断无法保证所有语境都正确。本机模型连接失败、超时或返回无效结果时，保留人工规则并回退词典，界面会显示具体回退提示。不会为读音判断调用云端服务或自动下载模型。更新后需要重启 Python 服务；生产模式的 Web 需要重新构建和启动。

### Windows 上重新生成 Prisma Client

若 `prisma generate` 报 `EPERM ... rename ... query_engine-windows.dll.node`，说明运行中的 Web 或 Worker 正占用引擎 DLL。等待当前任务结束后，在项目根目录执行：

```powershell
.\stop.ps1
pnpm db:generate
.\start.ps1
```

只有 Client 生成成功后再检查 Web 类型。不要通过删除类型或添加 `any` 来绕过缺失的 Prisma Client。长文分镜现在按批保存到项目目录的 `storyboard-checkpoint.json`；选择“从失败步骤重试”会在输入和配置未改变时继续已完成的批次。旧版本失败任务没有该文件，需要重新生成。

### 开发模式下 `UnhandledSchemeError` 与端口占用

`next dev` 会无条件额外创建 edge 编译器并重新编译 `src/instrumentation.ts`，即使本项目没有任何 edge 代码。该编译器的 `externalsPresets.node` 是关闭的，所以 instrumentation 里 `@/lib/backups` 引入的 `node:crypto`、`node:fs` 等内置模块会报 `UnhandledSchemeError: Reading from "node:crypto" is not handled by plugins`。这个错误会让所有路由（包括首页）返回 500，`next build` 却不会复现，因为生产构建会跳过空的 edge instrumentation 入口。`apps/web/next.config.ts` 为 edge 编译器打开 `externalsPresets.node`，让这段永远不会执行的 instrumentation 能编译通过；修改该文件后需要重启 `pnpm dev` 或 `.\start.ps1` 才生效。

上一条报错会连带表现为 `.\start.ps1` 卡住：脚本等的是 `http://127.0.0.1:3000` 返回 2xx–4xx，500 会让它一直等到 120 秒超时。现在超时信息会说明是「已监听但返回 HTTP 500」，并指出该看哪个日志文件，而不再只报“等待服务启动超时”。真正的端口冲突也会直接列出端口和占用进程，例如 `端口已被其他进程占用：3000（占用进程：node (PID 1234)）`；`.\stop.ps1` 结束后若仍有非脚本启动的监听者，也会给出同样的提示。就绪探测用 `System.Net.Http.HttpClient` 取状态码，而不是 `Invoke-WebRequest`：`-SkipHttpErrorCheck` 只有 PowerShell 6+ 才有，Windows PowerShell 5.1 遇到非 2xx 会直接抛异常，于是健康检查会被误判成超时。`start.ps1` 与 `stop.ps1` 在 5.1 和 7 上都能运行。

`next dev` 运行时不要执行 `pnpm build`（或 `apps/web` 的 `pnpm build`）：两者共用 `apps/web/.next`，生产构建会覆盖开发服务器正在使用的 server chunk，之后项目页会返回 500 并报 `Cannot find module './vendor-chunks/zod@<version>.js'`。遇到该报错先 `.\stop.ps1` 停掉服务，删除 `apps/web/.next`，再用 `.\start.ps1` 启动即可；需要生产构建时先停服务、构建完再重启开发服务。

## V1.5：制作效率与成片精修

V1.5 的目标不是加新页面，而是把“改多个场景 → 修正字幕与成片同步 → 处理素材缺失 → 重新导出 → 交付包与最新成片一致”这条路径补顺，全程让用户看清修改范围和失败原因。五个标签页的位置不变：导出前检查与导出步骤在「渲染导出」，字幕对照在「成片精修」，批量调整在「故事板」，素材与制作方案分别在「故事板」素材区和「质检交付」。

导出前检查由 `packages/schema/src/preflight.ts` 的 `preflightGroups` 与 `preflightDelta` 支撑。`PreflightIssue` 现在带上 `sceneTitle`、`assetPath` 与 `assetKind`，`preflightGaps` 用 `path:`（按文件）或 `kind:sceneId`（按场景）做去重键，于是“三个场景引用同一张丢失的图”合成一行、写成 `scenes[]` 而不是三行；`PreflightGapKind` 把问题归到「缺失语音 / 缺失图片 / 字幕 / 素材文件 / 旁白 / 导出设置」，面板的分类计数直接来自分组结果。`preflightDelta(previous, current)` 用同一套键比较前后两次检查，返回 `{ fixed, added, remaining }`，所以面板能说“已修好 3 项、新增 0 项”，而不是只说还剩几项。缺失素材的修复动作也分成两种：文件根本没上传给 `upload_asset`（补充素材），上传了但没登记或不在项目目录给 `open_assets`（打开素材）。

导出流程是 `packages/schema/src/export-flow.ts` 的四步状态机：`preflight` / `render` / `validate` / `package`。每一步由输入推导 `state`（`passed` / `pending` / `running` / `failed` / `blocked`）与一句可操作的话，`resumeFrom` 取第一个非 `passed` 的步骤，`passed[]` 列出已通过的步骤供界面承诺“不会重做”，`invalidated` 在中间某步未通过时把后面的 `passed` 降级。检查通过的时间与 `revision` 存在 `data/projects/<id>/preflight.json`（`preflight-state.ts`），所以“分镜改了就要重新检查”是拿 `revision` 比出来的，不需要重跑检查。路由 `GET /api/projects/<id>/export-flow` 通过 `projectExportFlow` 汇总最近一次渲染任务、成片状态与交付记录，**返回扁平结构**（`{ projectId, headline, canExport, resumeFrom, passed, steps, revision, jobId, checkedAt }`），不再把结果藏在 `flow` 字段里。

成片精修要能在播放器里拖动，所以 `apps/web/src/lib/video-range.ts` 的 `parseByteRange` 负责解析 `Range`，`videoStreamResponse` 负责 206 / 416 / 200 与 `accept-ranges`；`output` 路由的 GET 支持 `Range`、HEAD 只回头不回体，`dispositionFor(found, inline)` 区分下载与内联播放。字幕时间轴从视频包搬到 `packages/schema/src/captions.ts`（视频包保留再导出的 shim），除原有的切分与校验外新增 `subtitleCues`（给每条 cue 标上 `sceneIndex` 与 `cueIndex`）、`cueAt`（按成片绝对时间取当前 cue）、`cueSceneIndex`（同一时刻属于哪个场景）、`sceneStartTimes`（各场景在成片里的起始时间），所以点一条字幕既能跳到那一刻，也能跳回它所属的场景。

批量精修拆成“先算、再写”两步：`batchImpact(board, selection, changes)` 只返回会变的行（`{ sceneIndex, sceneTitle, field, label, current, next }`），`applyBatch` 才真正改，界面因此可以先展示影响范围。字幕类改动是项目级的（一行 `全部场景`），语速、句间停顿、场景时长与场景间隔是场景级的；语速、停顿变化会清掉 `audioSrc`、`audioDuration`、`wordTimings` 与手动 `subtitleCues`，并在影响表里单独提示“语音需要重新生成”。`sentencePause` 的默认值统一为 `0.12`（此前 `batch.ts` 用了 `0`，导致“没改停顿也报改动”，已修）。

素材清单由 `apps/web/src/lib/asset-usage.ts` 的 `scanAssetUsage` 生成：`assetDirs` 同时看 `data/projects/<id>/assets`、其下的 `archive` 与 `public/projects/<id>/assets`，`storyboardReferences` 收集每个文件的引用场景（`{ index, title }`）与背景音乐标记，重复项按内容 sha256（缓存键为 `size+mtimeMs`）分组，结果归为 `referenced` / `unused` / `archived` / `missing` / `duplicates`。`POST /api/projects/<id>/assets` 支持 `replace` + `scenes`（JSON 数组）：只替换调用方勾选的场景，`parseScenes` 反序列化并去重，没有图片的场景进入 `skipped` 不会被凭空补上引用；只有换了之后没有场景再引用时才归档——归档是把文件挪到 `assets/archive/` 并从 `public` 删掉，渲染 Worker 会跳过这些文件，但记录与字节都保留，可以 `restore` 或 `purge`（`purge` 要 `confirm === true`，仍被引用返回 409）。

制作方案在 `packages/schema/src/production-template.ts`：`templateFromProject` 取当前项目的众数（声音、语速、停顿、间隔）与项目级设置，`templateChanges` 生成 11 行前后对照并标注 `scope` 是项目级还是场景级，`templateSummary` 给列表一行摘要。存盘在 `data/settings/production-templates.json`（`production-templates.ts`，最多 30 份），接口为 `GET/POST /api/settings/production-templates` 与 `PATCH/DELETE`（`rename` / `duplicate` / `default`）；应用到项目走 `POST /api/projects/<id>/production-template`，按 `applyVoice` / `applyScenes` / `applyExport` 三组开关写入，语速或停顿真的变化时清空 `audioSrc`、`audioKey`、`audioDuration`、`wordTimings`、`subtitleCues`，并把受影响的场景与 `renderPreset` 一起返回，前端据此更新默认画质与提示重新生成语音。

### V1.5 验证命令

~~~powershell
pnpm typecheck
pnpm test:v15
pnpm test:v15:integration
pnpm test:v11
pnpm test:v12
pnpm test:v13
pnpm test:v13:integration
pnpm test:v14
pnpm test:v14:integration
~~~

`pnpm test:v15` 是 V1.5 的单元测试（39 项）：`preflight-gaps` 覆盖归并键（同文件合并、语音按场景、分类映射、`delta` 的修好/新增/剩余）、`export-flow` 覆盖四步状态机（阻断、未检查、改动作废、渲染中、失败带原因、覆盖/缺失、`resumeFrom`、`passed`、全部通过）、`batch` 覆盖影响表（字幕项目级行、语速与停顿的场景级行、默认 `0.12` 不误报、版式与时长、撤销）、`production-template` 覆盖保存与应用的往返（一致时不报改动、混合语速只报受影响场景、只改字幕时不清语音）、`video-range` 覆盖 `parseByteRange` 的越界与后缀边界。字幕时间轴警告（`caption_overflow` / `caption_overtime`）不计入“缺失文件”，由 `preflightGapCounts()` 单独统计，最后一项测试锁定该计数口径。`apps/web/test/preflight-panel-render.tsx` 再把面板本身渲染出来，断言“没有缺失素材时「缺失文件」为 0、字幕问题单独显示 1、缺图时两路各自计数、干净项目不显示字幕分组”，并对“点选素材替换当前场景画面”“缺失素材关联已有素材”“质检页等到最新成片”三处修复做了源码级防回归断言。

`pnpm test:v15:integration` 在临时数据库里跑通 V1.5 的关键路径：同一个缺失文件在两个场景引用时只出现一行并给出两个场景、修好后 `delta` 报告全部已修且无新增、检查通过后 `resumeFrom` 为渲染、分镜改一次后检查作废回到 `pending`、渲染完成后从校验继续；手动字幕改时间后成片上的显示时刻立刻改变且仍能定位到所属场景；缺失素材的两条修复路径都走一遍——登记过但文件丢了的素材报 `missing_file`（`fix: upload_asset`，`replace + scenes` 就地换字节并把原记录归档），引用了却没登记的素材报 `missing_image`（`fix: open_assets`，补齐上传后把场景指向新素材），两条都修好后导出检查不再出现任何缺图条目、只剩待配音；批量精修先 `batchImpact` 预览（只列选中场景、字幕样式单列为项目级、语速变化标出要重配音）再 `applyBatch` 落盘，落盘后只改选中场景的版式/语速/间隔，字幕样式对全项目生效，被改场景的旧配音、旧词时间与旧手动字幕时间一并作废，未选中的场景音频与字幕时间原样保留，旁白与时长不受影响；素材上传后分清未使用与重复、`replace + scenes` 只改勾选场景并跳过无图场景、仍被引用时拒绝归档、归档保留字节、恢复回两份目录、`purge` 缺确认返回 400 且仍被引用返回 409；制作方案能保存、应用、再次应用时报“没有变化”、只换声音时不清语音、重命名/复制/默认/删除；成片接口的 206 / 416 与 HEAD 200，以及未渲染时的 404。

2026-10-21 验收记录：`pnpm typecheck` 五个工作区通过；`pnpm test:v15` 38 项全部通过；`pnpm test:v15:integration` 通过并打印一行 `PASS:` 摘要；`pnpm test:v11` / `test:v12` / `test:v13` / `test:v14` 及其集成测试作为回归一并通过。人工验收清单见 `doc/V1.5_manual_acceptance.md`。

2026-10-21 缺陷修复：`GET /api/projects/<id>/export-flow` 之前把 `projectExportFlow` 的结果整块塞进 `data.flow` 再返回，而前端按扁平字段读取，于是「导出步骤」一直拿不到 `steps`、只显示“无法读取导出步骤”。现在路由直接把 `flow` 的字段摊平到响应顶层，前端与集成测试都按扁平结构断言。

2026-10-21 缺陷修复：`batch.ts` 的 `batchImpact` 用 `0` 作为 `sentencePause` 的默认比较值，而全仓（`voice/generate`、`voice/preview`、编辑器、制作方案）都用 `0.12`，结果“只改字幕样式”也会多出一行“句间停顿 0 秒 → 0.12 秒”的假改动。现在统一引用同一个 `0.12` 默认值，并补了断言防回归。

2026-10-23 启动修复：此前用 `.\start.ps1` 打开应用时所有页面都是 500，脚本等不到可用的 Web 服务而超时，V1.5 的界面流程因此无法验收。根因是 `next dev` 额外创建的 edge 编译器会重新编译 `src/instrumentation.ts`，其 `node:` 内置模块在该编译器下没有处理器（`UnhandledSchemeError`）；`next build` 不建这个入口，所以生产构建一直是绿的。`apps/web/next.config.ts` 为 edge 编译器打开 `externalsPresets.node` 后，`.\start.ps1` 能正常启动并打印服务地址。`start.ps1` 同时补了诊断：端口冲突会列出端口与占用进程，超时会区分“端口没起来”和“已监听但返回 HTTP 500”。随后又修了脚本自身的一个 bug：就绪探测原先用 `Invoke-WebRequest -SkipHttpErrorCheck`，该参数只在 PowerShell 6+ 存在，Windows PowerShell 5.1 每轮都抛“找不到与参数名称匹配的参数”，被 `catch` 吞掉后等满 90 秒再误报 Python 超时并杀掉健康服务；现改用 `System.Net.Http.HttpClient` 取状态码，两个版本行为一致，并已在 5.1 下实测正常启动、重跑提示“服务已运行”、`.\stop.ps1` 干净退出。

2026-10-23 启动后的实测（不是人工验收结论）：`.\start.ps1` 启动后 `http://127.0.0.1:3000` 首页、`/settings`、`/project/<id>` 与 `http://127.0.0.1:8000/health` 均返回 200；V1.5 的五个页签（故事板 / 声音设置 / 渲染导出 / 成片精修 / 质检交付）与「批量精修」「预览影响范围」都出现在项目页；`preflight` 返回带 `sceneIndex`、`sceneId`、`fix` 的可定位问题；`export-flow` 在成片已渲染、交付包未生成时给出 `resumeFrom: 'package'` 与“不会重做已通过步骤”的说明；`assets/usage` 同时列出 `referenced` / `unused` / `duplicates`；`output` 的 `Range: bytes=0-1023` 返回 206 + `video/mp4` + `bytes 0-1023/1682834`，成片预览的拖动依赖这条。仍需按 `doc/V1.5_manual_acceptance.md` 由人工逐项操作确认。

2026-10-23 试用反馈的四处修正：

1. 导出前检查把“字幕过长/超时”也算进了「缺失文件」。字幕警告本来就要留在清单里（它带 `fix: 'open_captions'` 可以直接跳去改字幕），但它不是缺文件，所以 `packages/schema/src/preflight.ts` 新增 `preflightGapCounts()` 把清单拆成“文件类”和“字幕类”两路计数，面板顶部显示「缺失文件」与「字幕问题」两个数字，清单也分成「缺失语音、图片与素材文件」和「字幕时间轴问题」两组。没有缺失素材时「缺失文件」为 0。
2. 故事板素材区里点选项目图片会新建一个场景。现在点选图片是“用作当前场景的画面”：当前场景是 `media` 时原地替换 `visual`（保留 fit/zoom 等其余字段），不新增场景；当前场景放不下图片（漫画/对比/图表/时间轴/公式）时才追加一个画面场景并在提示里说明原因。两个图片入口的标题也写明“点选后用作场景 N 的画面”，避免再被理解成追加。新增场景仍由「＋ 添加场景」负责。
3. 缺失素材的「补充并关联」入口只有上传，浏览器里不好判断文件选择框是否可用。缺失行现在同时给两条路：`上传补齐`（已登记素材，只换字节）或 `上传并关联`（新文件登记后改引用），并列出一个「关联到已有素材」下拉，选中后点「关联」把引用从缺失路径改到已有素材，保留原素材条目与字节，提示里说明改了几处引用（含 BGM）。
4. 刚渲染完进「质检交付」会先看到“还没有渲染完成的成片”，点「开始检查」后才认出最新成片。原因是成片列表只在挂载时读一次，而 `QualityDelivery` 只在切到该页签时才挂载；现在挂载读取失败会重试一次并给出错误提示（不再静默吞掉），只要有未结束的渲染任务就每 4 秒轮询一次 `exports`，`开始检查` 拿到质检结果后也会重新读一次成片列表。

以上均为代码级修复与自动化验证（`pnpm typecheck`、`pnpm test:v15` 39 项、`pnpm test:v14` 45 项含质检面板渲染、`apps/web` 构建、V1.5 集成测试全部通过）；界面上的实际点击仍需按清单人工确认。

2026-10-23 第五处修正：批量精修不会作废旧字幕时间。`saveStoryboard` 在一句旁白的语速/停顿/纠音变化时只清 `audioSrc`、`wordTimings` 等，没有清 `subtitleCues`；单场景编辑里 `updateScene` 自己补了这一步，因此从编辑器改语速没问题，而「批量精修」走的是 `applyBatch` → 保存，不经过那段前端逻辑。结果是语音被作废、重新配音后，旧的手动字幕时间仍然生效（`caption-editor` 只要 `subtitleCues` 非空就按手动时间走），成片里字幕会和新的配音错位。现在把清 `subtitleCues` 并入 `saveStoryboard` 的作废规则，所有保存路径行为一致；未改语速的场景（含批量里没选中的场景）字幕时间照旧保留。

2026-10-23 交付包一致性实测：对现成项目 `POST /api/projects/<id>/delivery` 生成交付包，记录为 7 个文件、5,110,773 字节、`attempts: 1`，`?probe=1` 预检返回 200 且不给 `stale`；用 `System.IO.Compression.ZipFile` 解开后，包内 `-成片-20261023-2259.mp4`（1,682,834 字节）与该项目 `output/<job>.mp4` 的 SHA256 完全相同（`d9aaf87b56ca0e3a880ce1fd875ee199eaf116781664322cd37f500f60b70d8c`），包内同时有 SRT/VTT/ASS 字幕、封面、`.m2v` 项目备份与交付说明，即“交付包与最新成片一致”成立。之后改动项目会让旧记录变成 `project-changed` 并拒绝下载，重新生成即可（不重渲染，重新打包同一条最新成片）。

2026-10-23 补的自动化断言：`test:v14:integration` 增加“解开 ZIP 后包内成片与渲染输出逐字节一致、同时带项目备份与交付说明”，以及“项目改动 → `project-changed` 拒绝下载 → 重新生成 → 版本号跟上、恢复可下载、包内仍是同一条最新成片”；`test:v15:integration` 增加缺失素材的两条修复路径（文件丢失走 `replace + scenes`、未登记走补齐上传再改引用，修好后导出检查不再拦缺图）与批量精修的应用落盘（只改选中场景、字幕样式对全项目生效、旧配音与旧字幕一并作废、未选中场景不受影响）。ZIP 目录解析抽到 `apps/web/test/zip-reader.ts`，与 `zip.test.ts` 共用。

2026-10-23 本轮自动化验证结果：`pnpm typecheck` 五个工作区通过；单元测试 `pnpm test:v11` 6 项、`pnpm test:v12` 47 项、`pnpm test:v13` 38 项、`pnpm test:v14` 45 项、`pnpm test:v15` 39 项全部通过；`pnpm test:v11:integration` / `test:v12:integration` / `test:v13:integration` / `test:v14:integration` / `test:v15:integration` 全部 PASS（各自打印一行 `PASS:` 摘要）。当时尚待浏览器人工确认的操作，见下方 2026-10-23 复验记录。人工验收清单见 `doc/V1.5_manual_acceptance.md`。

2026-10-23 浏览器人工复验：在本机项目 `复验-竖屏-20261013` 实际操作「成片精修」字幕定位、播放与时间微调，随后撤销测试时间改动；通过浏览器原生文件选择框上传测试图片，验证缺失素材补齐并关联成功，然后恢复原素材引用并删除测试素材；在实际 MP4 上修改两条字幕文本、将场景 2 延长至 3.2 秒并重新渲染。最终成片质检为通过（错误 0、提醒 0），MP4 校验通过（1080×1920、10.2 秒、含音轨），交付包生成 7 个文件，包内 MP4 与最新成片 SHA256 一致。批量精修的影响范围预览在浏览器中实际打开并取消，确认取消不写入；批量应用及制作方案保存/复制/跨项目应用由 V1.5 集成测试覆盖，尚未作为浏览器点击用例验收。测试上传文件已清理。

## V1.4：稳定性与交付体验

V1.4 不新增功能页，而是把 V1.3 已有的质检、校验、打包、备份、预设与任务中心补成“异常时有明确说法、不会留下误导性成功状态”的形态。因为项目没有 Prisma 迁移工具，新增的运行时状态全部用 JSON 记录，而不是改表结构：质检结论在 `data/projects/<id>/qc-report.json`，交付包记录在 `data/projects/<id>/delivery/<jobId>.json`，恢复中断标记在 `data/projects/.restore-<id>.json`。

质检状态由 `packages/schema/src/qc.ts` 的 `qcStatusFor` 统一推导：从未检查或没有摘要为 `pending`，有错误为 `blocking`，只有提醒为 `warning`，其余为 `passed`。报告与项目 `revision` 绑定，`GET /api/projects/<id>/qc?cached=1` 只读缓存视图（未检查 / 分镜已修改 / 结论有效三种返回），`refresh=1` 才强制重测音频与背景音乐。引擎层补齐了 `scene_too_short`（低于渲染器最短播放时长时只作提醒，且不再重复判停留时间）、`bgm_missing`（引用存在但文件缺失/静音/无音轨）与 `render_failed`（最近一次渲染失败，`fix: 'open_render'`），前端把这三类问题分别定位到分镜或导出页。语音质检还区分“没写台词”和“写了台词却没音频”：前者是刻意的静音场景（如纯图注页），计入 `AudioQc.silent` 且不产生任何问题，面板写明“另有 N 个场景没有写台词，按有意静音处理”；后者才报 `audio_missing` 阻断。所以场景本该无声时，清空台词即可让质检通过，不需要为了消除阻断去合成一段没有意义的旁白。

校验恢复的关键是导出记录不再用“最后一条 completed”代表最新状态：接口按 `createdAt desc` 返回全部记录，`videoState` 说明某条记录的成片文件是否仍属于它（`current` / `superseded` / `missing`），`ensureExportValidation` 在重新渲染后重算。因此最新的失败不会被更早的成功掩盖，旧记录的历史结论也不会被新结论覆盖。

交付包 `buildDelivery` 先生成项目备份再打包 ZIP，任一步失败都返回结构化 `missing: { step, message }[]`（步骤固定为 `render`、`validation`、`qc`、`video`、`subtitles`、`cover`、`backup`、`package`），并在 `delivery/<jobId>.json` 记一条 `failed` 记录；`nextDeliveryRecord` 累加 `attempts` 并保留首次生成时间。质检是打包前置条件：当前 `revision` 的质检结论为 `blocking` 时停在 `qc` 这一步并列出前 5 条阻断原因，从未检查过或分镜已改动（结论过期）则不拦截，避免把“还没测”当成失败。UI 用 `deliveryState` 归为五态（未生成 / 生成失败 / 已生成 / 文件已过期 / 包已过期），`GET /api/projects/<id>/delivery/<jobId>` 在文件被清理时返回 410 并要求重新生成。

成功记录会写下生成时的来源：`revision`（打包时的项目版本）与 `qc`（当时的质检结论与计数）。`deliveryStaleReason` 拿它们与项目当前状态比对，`deliveryRecordView` 把结果作为 `stale` 返回，所以“包是不是还能代表现在的项目”由服务端判断，而不是看记录里那条 `status: 'ready'`：当前质检为 `blocking` 时标为 `qc-blocking`，项目 `revision` 变了标为 `project-changed`，下载接口据此返回 409 并写明原因。旧版记录没有这两个字段，只能靠质检门禁判断，不会因为缺少来源信息就误报过期。

打包接口改为只返回结果（`{ ok, jobId, name, bytes, files, record }`），ZIP 由 `delivery/<jobId>` 单独下载：这样“打包成功但下载连接断了”不会再被显示成“打包失败”。前端在 POST 抛错时会重新读一次导出记录，如果记录已是 `ready` 且未过期就提示「已生成，点『再次下载』获取」，否则才报连接中断；自动下载失败也只是降级提示，不否定已生成的包。下载本身先请求 `delivery/<jobId>?probe=1` 拿到可用性与文件名，再用 `<a download>` 交给浏览器原生下载，14 MB 级的 ZIP 不经过 `fetch` + `blob()` 的页面内存。

备份恢复把失败点收敛为 `RestoreError(step, message, missing?)`，步骤为 `read`、`validate`、`files`、`database`；恢复前先 `cleanupInterruptedRestores` 清掉 60 秒前的 `.restore-*.json` 标记及其派生目录，恢复过程按派生路径排除 `project/output` 与校验缓存，逐文件比对 sha256，媒体缺失按 `missing` 汇总，数据库写入放在单个事务里。恢复永远新建项目，重名自动加后缀，源项目全程只读。

预设增加了 `isDefault` 与 `PATCH /api/settings/export-presets`（`rename` / `duplicate` / `default`）。复制名为 `<名称> 副本`、`<名称> 副本 2`…，重命名不区分大小写唯一（冲突返回 409）。应用前由 `presetChanges` 生成「画面比例 / 字幕样式 / 片头 / 片尾 / 转场 / 渲染质量」六行的前后对照，`changedPresetCount` 给出会修改的项数，取消则完全不写入。

任务恢复由 `task-actions.ts` 的 `failureInfo` 与放宽后的 `retryModeFor` 驱动：失败的渲染 / 语音 / 分镜分别给出 `render` / `voice` / `step`（仅在项目为 `failed` 时才允许 `restart`），取消的任务同样可重试，超过 15 分钟没有进度的任务提示 `recover`；`/api/tasks` 直接返回 `failure` 供任务中心渲染。

### V1.4 验证命令

~~~powershell
pnpm typecheck
pnpm test
pnpm test:v13
pnpm test:v13:integration
pnpm test:v14
pnpm test:v14:integration
~~~

`packages/video/test/qc.test.ts` 同时属于 `test:v13` 与 `test:v14`，改质检引擎时两套都要跑。

`pnpm test:v14` 覆盖质检四态推导与计数文案、质检引擎的新增边界（背景音乐四种状态、背景音乐缺失、场景过短不重复判停留、空字幕、渲染失败转阻断问题、空台词场景计入有意静音且不报缺失）、字幕时间轴校验（合法、重叠、超出显式时长、偏移按时间轴而非场景起点、三份导出共用同一 cue 列表）、交付包记录（`attempts` 累加、保留首次时间、`fileExists` 视图、不安全 ID 不越界、`revision`/`qc` 来源随记录写入、旧记录缺字段仍可读取、`deliveryStaleReason` 对阻断结论与版本变化的判定），以及「质检交付」面板与导出记录交付包五态（未生成 / 生成失败 / 已生成 / 文件已过期 / 包已过期）的服务端渲染文案，还覆盖任务恢复文案与重试路由（失败/取消/疑似中断三类任务的动作、每个动作都有对应接口、失败的分镜任务在项目未失败时只解释不提供按钮）。`pnpm test:v14:integration` 在临时数据库里跑全链路：四态在“未检查 → 阻断 → 修改后回到待检查”之间切换、渲染失败定位与恢复、最新失败不掩盖旧成功、交付包失败列出缺失步骤且重试累加、质检为阻断时拒绝打包（缺失步骤为 `qc` 并记 `failed`）、没写台词的场景按有意静音计为通过（不产生 `audio_missing`）、质检结论过期（分镜改动后）不拦截打包、真实 ZIP 再次下载（打包接口返回记录、ZIP 由下载接口提供并校验长度一致，`?probe=1` 预检返回与记录一致的文件名与体积、不搬运 ZIP；解开 ZIP 后包内成片与渲染出来的 MP4 逐字节一致，且同时带项目备份与交付说明）、ZIP 被清理后提示重新生成（预检同样 410）、质检重新变为阻断后旧包标为 `qc-blocking` 且拒绝下载（预检同样 409）、项目修改后旧包标为 `project-changed` 且拒绝下载、改完后重新生成交付包又恢复可下载且包内仍是同一条最新成片、成片丢失时指出缺少视频文件、备份恢复重名自动加后缀与损坏/缺媒体/中断三种失败及原项目不变、恢复后仍可编辑，最后覆盖预设的重命名/复制/默认/应用前预览。缺少 FFmpeg 时媒体段跳过并打印 SKIP。

2026-10-18 验收记录：V1.4 单元与渲染测试 44 项全部通过（`pnpm test:v14`），全链路集成测试通过（`pnpm test:v14:integration`）；`pnpm typecheck` 五个工作区通过；V1.3 的 37 项单元测试与渲染检查、V1.3 集成测试作为回归一并通过；V1.2 的 47 项单元测试与渲染检查作为回归一并通过。

2026-10-18 缺陷修复：集成测试发现重复恢复会产出同名项目。`nextRestoredName` 用 `startsWith('名称（恢复）')` 查重，而编号形式是 `名称（恢复 2）`，不以该前缀开头，因此第三次恢复仍返回「（恢复 2）」。现在改为按 `名称（恢复` 前缀查重，恢复依次得到「（恢复）」「（恢复 2）」「（恢复 3）」，并新增导入后的名称断言防回归。

2026-10-18 缺陷修复：验收时发现质检已判定 5 项阻断、面板也写着「修复后才能打包交付」，但「生成交付包 ZIP」按钮仍可点击并真的产出了 ZIP。原因是前端的可点状态只由成片校验结论推导，`buildDelivery` 也只检查了成片校验，质检结论根本没有参与打包判断——提示文案与实现不一致。现在前端由 `qcStatusFor` 推导 `qcBlocked`，为真时按钮置灰、`title` 与服务端均说明还差几项并禁止发起请求；服务端在 `buildDelivery` 的项目读取之后、分镜读取之前增加 `qc` 拦截，返回 409 且 `missing` 只列前 5 条阻断原因。拦截只认与当前 `revision` 匹配的报告，从未检查或分镜已改动时照常放行。集成测试补充了两条断言：阻断时打包被拒且记录为 `failed`，把 `qc-report.json` 的 `revision` 改旧后同样的项目可以打包。

2026-10-18 缺陷修复（旧包与下载报错）：上一轮门禁只拦住了新发起的打包，验收又发现两个问题。其一是门禁生效前生成的 ZIP 在质检变成阻断后仍显示「已生成」且「再次下载」可用，页面没有说明它是在阻断状态下生成的，也没有标为过期——交付记录里只有 `status`/`file`，既没有生成时的质检结论也没有版本，`deliveryState` 无从判断。其二是无阻断时反复重新打包，浏览器只报 `Failed to fetch`，而 `data/projects/<id>/delivery/` 里每次都多出一个 14 MB 的 ZIP、记录也已写成 `ready`：打包接口把 ZIP 塞在响应体里，连接中断时前端只能看到请求失败，于是把已经生成好的包报成失败。

改法是让记录带上来源、让下载与打包分离。`DeliveryRecord` 增加 `revision`（打包时的项目版本）与 `qc`（`{ status, errors, warnings }`），`nextDeliveryRecord` 原样保留，`isRecord` 对两个新字段只做“有则校验”以兼容旧记录；`deliveryStaleReason(record, { revision, qcStatus })` 返回 `null` / `'qc-blocking'` / `'project-changed'`，`deliveryRecordView` 把结果作为 `stale` 输出，`/exports` 与 `/delivery/<jobId>` 都用项目当前的 `revision` 与 `cachedQcView` 计算，后者对过期包返回 409 并说明原因。前端 `deliveryState` 因此多出第五态 `stale`：「质检交付」面板与导出记录都显示「交付包已过期」，写明是“生成时质检未通过”还是“生成之后项目又有修改”，并且不再提供「再次下载」。打包接口改为返回 JSON 记录，ZIP 统一走 `delivery/<jobId>` 下载；POST 抛错时前端重读导出记录，记录为 `ready` 且未过期就提示「已生成，点『再次下载』获取」，自动下载失败也降级为提示而不是错误。

另需注意环境：端口 3000 上同时跑着两个 Next dev server 共用同一个 `.next` 目录会让长请求更容易中断，排查 `Failed to fetch` 时应先只保留一个实例。

2026-10-18 缺陷修复（下载仍报 `Failed to fetch`）：打包与下载分离后又验了一次，页面提示「自动下载未启动」、点「再次下载」仍报 `Failed to fetch`，但服务端其实完全正常——同一份 ZIP 用 curl 和 Node `fetch`（undici，与浏览器同栈）都是 200、`content-length: 14137973`、字节完整，交付记录是 `ready`，目录里 5 个 ZIP 一个不少。真正的原因是前端把 14 MB 响应体先读进 `fetch` 的 `response.blob()` 再交给 `<a download>`，浏览器在缓冲这个体积时会放弃请求，于是已经生成好的包被报成网络失败。

改法是不让页面碰 ZIP 本体。`GET /api/projects/<id>/delivery/<jobId>?probe=1` 只做记录、文件与过期三项检查，返回 `{ ok, name, bytes, file }`，失败时复用原有的 404/409/410 与 `error`/`missing`，前端据此显示「文件已不存在」「质检阻断之后已过期」这类准确原因；探针通过后，前端用 `startDownload(url, name)` 生成一个带 `download` 属性的 `<a>` 元素并 `click()`，把传输完全交给浏览器原生下载栈（可流式、可续传、不占页面内存），因此大包失败也不会再变成 `Failed to fetch`。「质检交付」与导出记录两处都换成了这套流程，探针请求本身失败时仍按原样发起下载，不因为预检异常否掉可用的包。

2026-10-18 补充定位：上一轮把 `Failed to fetch` 归因于前端缓冲响应体，但继续用 curl 复现时 `curl` 反复以 `exit=23`（写盘失败）中止、只收到 3 MB 或 0 字节，查 `Win32_LogicalDisk` 才发现测试机 `C:` 可用空间为 0，浏览器与 curl 都无法把 14 MB 落盘。清理临时文件与崩溃转储后同一请求连续三次都是 `14137973` 字节、`exit=0`。也就是说服务端与下载流程一直是好的，真实瓶颈是宿主磁盘写满；`<a download>` 那套改动仍然保留，因为它本来就更省内存，只是它并不是这次报错的根因。验收时也确认了：质检报出的 5 项阻断确为场景真的没有旁白（不是误报），但当时没有“这个场景本来就要静音”的表达方式，只能去合成语音。

2026-10-20 验收记录：`pnpm typecheck` 五个工作区通过，`pnpm test:v13` 38 项、`pnpm test:v14` 45 项、`pnpm test:v13:integration` 与 `pnpm test:v14:integration` 全部通过。针对上一条提到的“只能说缺旁白、不能说有意静音”，`AudioQc` 增加 `silent` 计数，`checkAudio` 把空台词场景单独归类；单元测试补了两个空白台词场景加一个写了台词却没有音频的场景（`silent=2`、`measurable=0`、只有后者报 `audio_missing`），集成测试补了整项目全为有意静音的用例（`silent=2`、`errors=0`、`status='passed'`），面板渲染测试断言文案里出现“有意静音”。同时用真实项目复核：对 `复验-PPT-4x3-20261013（恢复）（恢复）` 走 `GET /api/projects/<id>/qc?refresh=1` 仍是 `blocking` / 5 条 `audio_missing` / `measurable=0` / `silent=0`，说明 5 项阻断属于“写了台词却没音频”，不会被静音规则放过。

## V1.3：成片质检与交付

项目页新增「质检交付」标签页，把交付前的检查与交付后的打包放在同一处：上方是成片质检（字幕与语音分两组问题），中间是最近一次成片的文件校验结论，然后是交付包清单与「生成交付包 ZIP」，最后是导出预设。

字幕质检按当前分镜的字幕时间轴检查过长、停留时间不足、时间重叠、超出所属场景时长和空字幕，每条问题都带场景标题、第几条字幕和建议处理方式；点「定位」会切回分镜的字幕精修面板并选中对应字幕，改完保存后再点「重新检查」，已修复的问题从列表消失。语音质检逐场景用 FFmpeg 测量旁白，报告缺失、静音、异常偏短以及音频时长与场景差异过大；报告标出问题场景，可试听或直接用「重新生成语音」重跑该场景。本机没有 FFmpeg/ffprobe 时报告会说明语音测量不可用，字幕质检不受影响。

成片文件校验在导出记录上执行：读取文件的分辨率、时长、视频轨道与音频轨道。无法读取、空文件、缺少视频轨道视为阻断，交付包会被拒绝生成；分辨率偏差（超过 2 像素）、时长偏差（超过 `max(1.5 秒, 2%)`）和缺少音频轨道只作提醒。校验结论写入 `Job.validationJson`，因此刷新后仍显示在导出记录与「质检交付」中。

交付包把成片 MP4、SRT/VTT/ASS 字幕、封面图、项目备份（`.m2v`）和交付说明一起打成单个 ZIP，文件名形如 `项目名-交付包-20261018-1530.zip`，条目名带时间戳。字幕使用该次渲染时的分镜快照生成，与成片共用一条时间轴；交付说明写明成片、字幕、封面、备份的来源与质检结果。封面优先从成片截帧，缺少 FFmpeg 时回退到项目首张图片。每个项目保留最近 5 个交付包，单包最多 100 个文件、4 GiB。

导出预设只保存画幅、字幕样式和片头片尾（含转场），可保存、复用和删除，最多 30 个、名称不区分大小写唯一，存放于 `data/settings/export-presets.json`。应用预设只覆盖这五类设置（`aspectRatio`、`subtitles`、`intro`、`outro`、`transition`），分镜内容、旁白和素材不受影响；预览面板会先显示「将保存：画幅 16:9 · 字幕底板 · 无片头 / 无片尾 · 转场 直切」这类摘要。

### V1.3 验证命令

~~~powershell
pnpm typecheck
pnpm test
pnpm test:v13
pnpm test:v13:integration
~~~

`pnpm test:v13` 覆盖字幕与语音质检引擎的阈值与定位（含字幕关闭时仍统计条目）、`evaluateRender` 的分辨率与时长容差和阻断规则、导出预设的默认值与非法输入、`presetBoardPatch` 只返回五类设置且不触碰分镜，以及 ZIP 写入器的结构校验（EOCD/中央目录/CRC32/UTF-8 标志/非法文件名/重复关闭/中止）和「质检交付」面板的服务端渲染文案。`pnpm test:v13:integration` 沿用 V1.1 的临时数据库方式，覆盖字幕四类问题的定位字段、空字幕、语音缺失与「修好后重新检查」、成片校验与导出记录联动、交付包在有阻断问题时被拒绝，然后用 FFmpeg 生成真实 MP4 走完校验与真实 ZIP 打包（校验条目、内容与交付说明），最后覆盖导出预设的增删查与重名/非法输入拒绝。缺少 FFmpeg 时媒体段会跳过并打印 SKIP。

2026-10-18 验收记录：V1.3 自动化测试 28/28 通过，渲染检查通过；集成验收通过，包含真实 MP4 的成片校验与真实 ZIP 交付包内容核对；Schema、Styles、Video、Web、Worker 五个工作区的 TypeScript 检查通过；共享 Schema 测试 30/30、V1.2 的 47 项单元测试与集成测试作为回归一并通过。

2026-10-18 缺陷修复：人工验收 SUB-10 发现关闭字幕显示后质检报告的字幕条数为 0。`checkSubtitles` 原在字幕关闭时整体短路，现在仍按 `resolveCaptionCues` 统计实际条目，只在关闭状态跳过逐条问题检查，因此报告会显示「字幕 N 条（当前已关闭显示）」。已补单元与接口两级回归（关闭字幕时条数与开启时一致且 `issues` 为空）。

## V1.2：可控性与任务恢复

故事板上方新增「任务中心」，集中展示长文生成、语音生成与渲染的进度、失败原因和可用重试方式，长文任务列出已完成与待处理章节。恢复接口复用既有重试路由，重试不会重复入队；失败渲染的重新渲染与项目页的导出按钮走同一套导出前检查，有错误时先返回问题清单，确认风险后才入队，并且按当前分镜重渲染而不是复用失败时的旧快照。

字幕与节奏页提供时间轴精修：可直接编辑每条字幕文本与起止时间并立即预览；旁白音频、语速或停顿变化后手动时间轴失效并回到自动切分。SRT、VTT、ASS 导出与画面字幕共用同一份时间轴，片头、片尾与场景转场也计入偏移。

抽取复核页按页显示 OCR 状态与识别质量，可只重跑选定页面；表格、列表与页序有独立复核视图，分镜场景卡片显示来源页并可打开该页只读正文回查。

导出前检查会列出缺失图片、无音频场景、字幕溢出和时长不足，并可跳转到对应场景；面板显示预计时长、分辨率与导出档位，存在错误时需勾选确认才会入队。素材库新增占用统计与未引用素材清单（删除前再次校验引用，只清理项目 assets 目录），快照支持逐文件校验。项目列表支持按名称/正文搜索、按状态筛选并按更新时间、创建时间或名称排序。

### V1.2 验证命令

~~~powershell
pnpm typecheck
pnpm test
pnpm test:v12
pnpm test:v12:integration
~~~

`pnpm test:v12:integration` 使用与 V1.1 相同的临时数据库方式，额外覆盖手动字幕落库与三种格式导出一致性、来源页与单页重跑、任务聚合与重试去重、导出前检查与 `allowIssues` 确认（含任务中心重新渲染的同一套拦截与当前分镜重渲染）、未引用素材清理与引用拒绝、快照校验以及项目列表搜索/筛选/排序。`pnpm test:v12` 里的 `structure.test.ts` 校验表格/列表/页序的检查规则（列数不一致、编号跳号、重复页码、缺页、乱序），`structure-render.tsx` 再按三种视图各渲染一次，确认复核结果确实出现在界面上。`extraction.test.ts` 覆盖场景来源页定位（含页码已不存在与无分页标记的来源），`source-peek-render.tsx` 确认来源页面板打开在场景对应的页码上。

2026-10-17 验收记录：V1.2 自动化测试 47/47 通过，集成验收通过，表格/列表/页序复核视图及场景来源页面板的渲染检查通过；Schema、Video、Styles、Web、Worker 五个工作区的 TypeScript 检查通过。回归覆盖旧版 PDF 逐页状态补齐、选定页重跑后保留其它页面，以及任务中心渲染重试必须先通过导出前检查或明确确认风险。

## V1.1：成片质量与制作效率

故事板上方新增“分镜精修 / 字幕与节奏 / 素材库 / 备份与恢复”。支持模板、复制场景、批量时长与风格、自动排版、字幕预设和 SRT/VTT/ASS 导出、场景语速与停顿、片段试听，以及图片裁切/缩放/焦点。Commons 图片需先确认许可与署名。

编辑停止约 1.2 秒后自动保存；保存失败或版本冲突会显示在页首，未保存时离开页面会提示。导出和语音生成前会保存当前分镜。音频按场景缓存，更新语音只重生成受影响的场景。

导出页支持 540p 草稿、阶段进度、取消渲染与历史下载。新成片使用独立文件；旧版本已被覆盖的 final.mp4 无法恢复，这类记录标记为“历史记录（视频不可用）”、不提供下载，并说明原因及重新导出入口。准备资源期间取消会在该阶段结束后停止，画面渲染和 FFmpeg 编码使用取消信号中止。

项目包使用 .m2v 格式，包含项目源文件、声音参考、图片、旁白及所有仍存在的独立历史导出视频，不包含模型权重。恢复会保留独立视频和对应导出记录；V1.0 被后续导出覆盖、已经不存在的视频无法从备份恢复，其记录会保留为不可下载的历史状态。首页“恢复项目包”会新建项目，保留原项目。自动快照在保存后创建，每五分钟最多一次，保留最近十份未锁定快照；锁定快照长期保留。备份会占用与项目媒体相应的磁盘空间。

浏览器验收已确认：新导出的草稿与旧版仍存在的最新成片可分别下载，下载文件与项目包中的独立文件校验值一致；从项目包恢复后，草稿仍可下载且内容校验值不变。被覆盖的旧版记录在刷新后仍明确标记为不可用，且不显示下载按钮。旧版已丢失的视频不在可恢复范围内。

首页“环境自检”检查 Python、Ollama 模型、FFmpeg/ffprobe、TTS 模型、TorchCodec、OCR 和 Worker。OCR 需自行安装 Tesseract 与中文简体/英文语言包；设置 TESSDATA_PREFIX 指向含 chi_sim.traineddata 和 eng.traineddata 的目录后重启 Python 服务。自检不会自动下载或安装。

### 升级现有数据库

先停止旧版 Web/Worker，再执行：

~~~powershell
pnpm db:generate
pnpm db:migrate:v11
~~~

迁移脚本在 data/database-backups 下保存升级前 SQLite 副本，再为旧表增量添加字段；可重复执行。start.ps1 会检查并执行该迁移。新安装仍先使用 pnpm db:push 初始化。

### V1.1 验证命令

~~~powershell
pnpm typecheck
pnpm test
pnpm test:v11
pnpm test:v11:integration
pnpm test:v11:render
cd services/python
.venv/Scripts/python.exe -m unittest discover -s tests -v
~~~

隔离集成测试使用 Node.js 22.13+ 的 node:sqlite 创建临时数据库，测试备份恢复、快照轮转、保存冲突、取消状态及导入预览；不修改真实项目。渲染冒烟测试位于 apps/worker/test/render-v11.ts，需要本机 Chromium/Edge 与 FFmpeg，可通过 REMOTION_BROWSER_EXECUTABLE 指定浏览器。

竖屏字幕预览受视口高度限制，整幅 1080 × 1920 画面只能缩到约 0.37 倍显示，密集正文在屏幕上仅约 8px。预览工具栏的「1:1 原始尺寸」按钮会按画布原始像素显示并可滚动，字号与成片一致，便于判断阅读效果。
