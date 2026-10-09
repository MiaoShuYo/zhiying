<p align="center">
  <img src="apps/web/public/brand/zhiying-logo.svg" alt="知影 Local Studio" width="292">
</p>

# 知影：本地 AI 知识视频生成器

知影（Local Studio）是一个运行在 Windows 本机的 PDF、Markdown 和文本讲解视频工作台。它使用 Ollama 生成内容和分镜，用 F5-TTS 克隆用户提供的声音，最后由 Remotion 和 FFmpeg 导出 1080p H.264 MP4。源文件、声音参考、生成音频和视频默认保存在本地。

## 功能

- 导入 PDF、Markdown 或粘贴文本，生成可编辑故事板。
- 编辑、排序、删除或单独重新生成场景。
- 通过参考音频和对应转录生成场景旁白，并试听。
- 使用 Remotion 预览并导出 16:9、1920 × 1080、30 FPS MP4。
- 使用 SQLite 保存项目和作业状态；Intel Quick Sync 可用时尝试硬件编码，否则使用 H.264 软件编码。

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
# 将 FFmpeg bin 加入当前 Windows 用户的 PATH，不覆盖已有 PATH
$ffmpegBin = 'D:\Tools\ffmpeg-8.1.2-full-shared\bin'
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$pathEntries = @($userPath -split ';' | Where-Object { $_ })
if ($pathEntries -notcontains $ffmpegBin) {
  [Environment]::SetEnvironmentVariable('Path', (($pathEntries + $ffmpegBin) -join ';'), 'User')
}

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

在 `services\python` 目录启动服务：

```powershell
uv run uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload --reload-dir app
```

`--reload-dir app` 限定热重载监视应用源码，避免虚拟环境里的模型库文件变化反复触发服务重启。打开 `http://localhost:8000/health` 查看服务状态。

### 5. 启动 Web 和渲染 Worker

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
pnpm build        # 构建所有 TypeScript 工作区
pnpm typecheck    # 类型检查
pnpm test         # 共享 Schema 测试
pnpm db:generate  # 生成 Prisma Client
pnpm db:push      # 同步 SQLite 数据库结构
```

## 本地数据与 Git

项目数据库、上传素材、参考音频、生成旁白、渲染视频、模型缓存和日志均保存在本机。`.gitignore` 会排除这些内容，以及 `.env`、虚拟环境和构建缓存；只提交 `.env.example` 作为无密钥的配置模板。请勿把私人参考录音、转录文本或生成视频手动加入 Git。

## 当前范围

首版支持 PDF/Markdown/文本输入、title/bullets/diagram/comparison/chart/code 六种场景、四种视频风格、场景编辑与重试、声音克隆、预览和 MP4 导出。PPT、URL、9:16 视频、逐词字幕高亮、BGM、品牌套件和云端模型 Provider 不在当前版本范围内。
