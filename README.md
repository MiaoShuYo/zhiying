# 本地 AI 知识视频生成器

Windows 本地优先的 PDF/Markdown/文本讲解视频工作台。当前提供 Next.js 项目界面、结构化分镜、Remotion 预览、SQLite 持久化、Ollama 分镜生成 API，以及 Python 文档/TTS 服务骨架。

## 环境

- Node.js 20.19+（当前 Node 24 可用）与 pnpm 10+
- Python 3.11、3.12 或 3.13
- Ollama 和一个本地聊天模型（默认 `qwen3:4b`）
- FFmpeg；Intel QSV 可选，软件编码会自动作为后备
- F5-TTS 可选的独立 Python 环境与模型权重

## 启动

```powershell
pnpm install
Copy-Item apps\web\.env.example apps\web\.env
pnpm db:generate
pnpm db:push
pnpm dev
```

打开 http://localhost:3000。`npm` 不在本机完整安装时直接使用随 Node 配套的 `corepack pnpm`，或安装 pnpm 后运行上述命令。

Python 服务：

```powershell
cd services\python
uv sync
uv run uvicorn app.main:app --reload --reload-dir app --port 8000
```

需要克隆声音时运行 `uv sync --extra tts`。该 extra 固定 F5-TTS 1.1.22 与 PyTorch 2.10.0 XPU wheels，并固定 TorchCodec 0.10 以兼容 Python 3.13，适配 Python 3.13 和 Intel Arc；若 Intel XPU 驱动不可用，服务会回退 CPU 推理。可将 F5-TTS 权重放到 `data/models/f5-tts/F5TTS_v1_Base`，将 Vocos 声码器文件放到 `data/models/f5-tts/vocos-mel-24khz`，服务会优先读取本地文件；模型缺失时也会尝试从 Hugging Face 下载到缓存（可用 `HF_HOME` 指向 D 盘）。FFmpeg 需单独安装并加入 PATH；F5-TTS 读取参考音频还需要 `ffprobe.exe`，启动 Python 服务的终端必须能找到 `ffmpeg` 和 `ffprobe`。可访问 `http://localhost:8000/health` 检查返回值中的 `ffmpeg`、`ffprobe` 是否均为 `true`。Intel Quick Sync 可选。Remotion 导出也需要可用的 Chromium，首次渲染前按 Remotion 指引准备浏览器。

在 `apps/web/.env` 设置 `PYTHON_SERVICE_URL=http://127.0.0.1:8000`。Markdown 和粘贴文本可直接处理；PDF 解析和 F5-TTS 请求需要 Python 服务。

## 本地模型

```powershell
ollama pull qwen3:4b
```

Web 服务通过 Ollama `/api/chat` 请求 JSON 格式结果。也可在 `.env.local` 设置 `OLLAMA_BASE_URL` 和 `OLLAMA_MODEL`。

## 当前范围

PDF/文本输入；六种结构化场景；四种样式；场景编辑、排序、单场景再生成；参考音频配置及逐场景 TTS API；Remotion Player 预览和 MP4 渲染作业。PPT/URL、字幕逐词对齐、复杂资产生成暂不包含。
