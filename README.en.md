<p align="center">
  <img src="apps/web/public/brand/zhiying-logo.svg" alt="Zhiying Local Studio" width="292">
</p>

# Zhiying: Local AI Knowledge Video Studio

Language: [简体中文](README.md) · [English](README.en.md) · [日本語](README.ja.md)

Zhiying (Local Studio) is a Windows desktop-local workspace for turning PDFs, PPTX files, Markdown, public webpages, and plain text into narrated videos. Ollama helps analyze source material and create storyboards; F5-TTS generates narration from a user-provided voice reference; Remotion and FFmpeg render landscape or portrait 1080p H.264 MP4 files. The app can check subtitles and narration, validate rendered files, and package the MP4, subtitles, cover, and project backup into a delivery ZIP. Project files and generated media are stored locally by default. The app accesses the internet only when the user chooses public webpage extraction or Wikimedia Commons search/download.

## Features

### Import and storyboard creation

- Import PDF, PPTX, Markdown (`.md` / `.markdown`), pasted text, and public webpages that do not require sign-in. Review, preview, and edit extracted text before generating a storyboard.
- Extract text from PDFs, with optional local Tesseract OCR for scanned pages. PPTX files can be rebuilt from extracted content or preserve original slide images; the latter requires PowerPoint or LibreOffice. Speaker notes can be prioritized for narration.
- Web extraction targets public articles, blocks localhost and private-network addresses, and reports errors. Pasting text is available as a fallback.
- Ollama runs locally to analyze sources and generate scripts and storyboards. Long documents are processed in batches with checkpoints and can resume when the input and settings have not changed.

### Storyboard and visuals

- Create title, bullet, diagram, comparison, chart, code, timeline, formula, and image scenes. Add, copy, delete, reorder, and edit narration, duration, and visual JSON; regenerate narration per scene.
- Preview storyboards live. Choose Minimal Tech, Clean Light, Academic, Social Short, or Whiteboard styles. Insert built-in or custom scene templates and save scenes as reusable templates.
- Use automatic, vertical, side-by-side, or compact layouts. Select multiple scenes to adjust duration or style, and get navigable layout warnings for dense content and portrait scenes.

### Narration, pacing, and subtitles

- Create a project voice profile with a reference recording and transcript. Local F5-TTS generates voice-matched narration; a general voice is available when no project voice is configured.
- Adjust project-wide or per-scene speed, sentence pauses, and gaps between scenes. Only affected scenes need to be regenerated. Preview a scene or a sentence/clip.
- Generate word-level subtitle timing with a local alignment model. Choose simple, background-panel, or emphasized styles; configure visibility, position, size, colors, and opacity. Export SRT, VTT, or ASS. If alignment data is unavailable, timing is estimated from scene duration.
- Define pronunciation corrections at scene, project, or global Chinese levels. A changed rule invalidates narration for affected scenes so it can be regenerated.

### Project assets

- Manage images, voice references, and background music in the project asset library. Preview, replace, and delete assets, and inspect source, license, and attribution information. Image scenes support contain/cover, zoom, and horizontal/vertical focal-point controls.
- Import local images or search Wikimedia Commons on demand. Review license and attribution details before using Commons images; source information is saved with the project and can appear in the rendered video.

### Preview, rendering, and export

- Preview with Remotion and export 16:9 (1920×1080) or 9:16 (1080×1920), 30 FPS H.264 MP4. A 540p draft option is available for faster review.
- Add local background music and adjust volume, fade-in, and fade-out. Render history reports queueing, resource preparation, rendering, encoding, and failure details. Running jobs can be canceled.
- Each export is stored as a separate video and can be downloaded from project history. Legacy V1.0 exports that shared and overwrote `final.mp4` cannot be restored; such records are marked unavailable and do not expose a misleading download.

### Project management, backup, and diagnostics

- Projects, storyboards, assets, audio, tasks, and export records are stored in local SQLite and project directories. Storyboards autosave and show save status, errors, and version conflicts; changes are saved before generation or export.
- Duplicate projects, create/download full `.m2v` project packages, create snapshots, lock important snapshots, and restore from a snapshot or package as a new project. Automatic snapshots are limited to one per project every five minutes and retain the latest ten unlocked snapshots; locked snapshots are not rotated.
- Project packages include source files, project assets, voice references, scene narration, and independent historical videos that still exist. Model weights are excluded. Overwritten videos that no longer exist cannot be restored.
- The home-page environment check diagnoses Python, Ollama and required models, FFmpeg/ffprobe, F5-TTS dependencies, OCR, and the render Worker. It provides guidance but does not automatically download models or install system dependencies.
- Long-form generation and render tasks retain status, progress, errors, and checkpoints. Suitable tasks can be resumed or retried from the project list or project page.

### V1.2–V1.5 highlights

- **V1.2 — Recovery and control:** edit subtitle text/timing on a shared timeline; review extraction page by page; locate storyboard scenes by source page; retry tasks with actionable failure states; run export preflight and navigate to affected scenes; inspect unused assets and validate snapshots.
- **V1.3 — Quality and delivery:** run subtitle and voice QC, validate rendered MP4 resolution/duration/tracks, create ZIP delivery packages containing MP4, SRT/VTT/ASS, cover, `.m2v` backup, and notes; save reusable export presets.
- **V1.4 — Reliability:** track QC status against project revisions; distinguish intentional silence from missing narration; identify stale, missing, or failed outputs and packages; report recovery and delivery failures with actionable reasons.
- **V1.5 — Production efficiency and final-cut refinement:** group preflight issues and navigate to affected scenes; resume from the first failed export step; refine subtitles against a real MP4; preview batch-edit impact before applying; identify referenced, unused, missing, duplicate, and archived assets; replace selected scene assets while retaining the original; save reusable production plans for voice, pacing, aspect ratio, subtitles, transitions, music volume, and export quality.

V1.5 browser verification on 2026-10-23 covered subtitle seeking/playback and timing, native file-picker upload and missing-asset repair, caption text edits, scene-duration adjustment, a new render, QC, MP4 validation, and delivery-package consistency. The batch-impact preview was opened and canceled in the UI. Batch application and production-plan save/copy/apply behavior are covered by integration tests, but have not been recorded as browser-click acceptance. See [the V1.5 manual acceptance checklist](doc/V1.5_manual_acceptance.md) for detailed scenarios and scope.

The app is designed for local use and does not provide cloud generation or complex collaboration. Public webpage extraction and Wikimedia Commons search/download access the internet only after the user initiates those actions.

## Typical workflow

1. Create a project, import source material or paste text, review the extracted content, and choose aspect ratio, visual style, and PPTX handling.
2. Edit the storyboard, scene content, layout, order, and duration. Use templates, batch edits, or local/Commons images as needed.
3. Configure a voice reference and transcript, generate and preview narration, then adjust speed, pauses, scene gaps, subtitles, and pronunciation rules.
4. Review visuals and layout in live preview; optionally add local background music or render a 540p draft.
5. Export MP4, monitor or cancel the render, and download the result from export history. Create snapshots or backups when needed.
6. Before delivery, run subtitle/narration QC, validate the MP4, and create a delivery ZIP. Save common aspect ratio, subtitle, intro, and outro settings as export presets.

## System requirements

These are recommendations for local development and video generation, not hard application gates. CPU inference works but narration generation is slower.

| Component | Recommended minimum |
| --- | --- |
| OS | 64-bit Windows 10 22H2 or Windows 11 |
| CPU | Modern 4-core processor; more cores help generation |
| Memory | 16 GB; 32 GB recommended when running Ollama and F5-TTS together |
| Disk | Reserve at least 25 GB for dependencies, models, and caches; exports need additional space |
| GPU | Optional. Intel Arc/XPU can accelerate F5-TTS; 8 GB or more dedicated/shared memory is recommended. CPU fallback is used when XPU is unavailable. |
| Video encoding | Intel Quick Sync is optional; FFmpeg uses libx264 when hardware encoding is unavailable. |

The Python dependencies use a PyTorch XPU build, and the speech acceleration path targets Intel XPU. NVIDIA and AMD GPUs do not use this XPU path; speech runs on CPU. Ollama GPU support depends on Ollama and the installed driver.

## Required software and models

| Software | Version / purpose |
| --- | --- |
| Git and Git LFS | Clone the repository and retrieve model weights |
| Node.js | 20.19+ for Next.js and the Remotion Worker |
| Corepack and pnpm | Repository pins pnpm 11.25.0 |
| Python | 3.13.x for document parsing and speech services |
| uv | Create the Python environment and install locked dependencies |
| Ollama for Windows | Local LLM service, default API `http://localhost:11434` |
| FFmpeg | 8.x full-shared, including `ffmpeg.exe`, `ffprobe.exe`, and shared DLLs |
| Chrome/Chromium | Remotion uses local Chrome or downloads a render browser if needed |
| PowerPoint or LibreOffice | Optional; required only to preserve original PPTX slide images |

FFmpeg must be discoverable on `PATH` by both Python and the Worker. FFmpeg 8 full-shared is recommended; FFmpeg 9 is not recommended for the locked TorchCodec version. Tesseract and language packs are optional for scanned-PDF OCR.

| Purpose | Model |
| --- | --- |
| Source analysis, scripts, and storyboards | Ollama `qwen3:4b` |
| Voice cloning | [SWivid/F5-TTS](https://huggingface.co/SWivid/F5-TTS) |
| F5-TTS vocoder | [charactr/vocos-mel-24khz](https://huggingface.co/charactr/vocos-mel-24khz) |

F5-TTS weights are about 1.35 GB and Vocos about 55 MB. The F5-TTS model is marked CC BY-NC 4.0; check the model card and license before use. Model weights are distributed via Git LFS and are not included in `.m2v` project backups.

## Windows setup

### 1. Clone and install JavaScript dependencies

```powershell
git clone https://github.com/MiaoShuYo/zhiying.git
cd zhiying
git lfs install
git lfs pull
corepack enable
corepack prepare pnpm@11.25.0 --activate
Copy-Item apps\web\.env.example apps\web\.env
pnpm install
pnpm db:generate
pnpm db:push
```

Install Node.js 20.19+, Git, and Git LFS first. Use Corepack for pnpm; do not install project dependencies with `npm install`.

### 2. Install Ollama and the local LLM

Install and launch Ollama for Windows, then run:

```powershell
ollama pull qwen3:4b
ollama list
```

Ollama listens on `http://localhost:11434` by default. Change `OLLAMA_MODEL` or `OLLAMA_BASE_URL` in `apps/web/.env` if needed.

### 3. Install the Python speech service

Install Python 3.13.x and [uv](https://docs.astral.sh/uv/), then from the repository root run:

```powershell
cd services\python
uv sync --python 3.13 --extra tts
```

The `tts` extra installs the locked F5-TTS, PyTorch XPU, TorchAudio, and TorchCodec dependencies. Omit `--extra tts` if only PDF parsing is needed. Word-level subtitle alignment downloads its Chinese or English wav2vec2 model from Hugging Face on first use. PPTX original-slide rendering requires PowerPoint or LibreOffice.

### 4. Start the application

Return to the repository root and run:

```powershell
cd ..\..
.\start.ps1
```

This starts the Python service, Next.js app, and render Worker, and writes logs to `logs`. Open [http://127.0.0.1:3000](http://127.0.0.1:3000). The script does not start Ollama; keep Ollama running for storyboard generation. Stop the services with `.stop.ps1`.

To start only the Web app and Worker, run `pnpm dev` from the repository root. To run the Python service separately, from `services\python` run:

```powershell
uv run uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload --reload-dir app
```

Check service health at [http://localhost:8000/health](http://localhost:8000/health). Set `M2V_DATA_DIR` to move project media/models, `HF_HOME` to move Hugging Face cache, or `OLLAMA_MODELS` to move Ollama models. Restart the relevant terminal/services after changing environment variables.

If PowerShell blocks scripts, use `pwsh -ExecutionPolicy Bypass -File .\start.ps1`.

## Common commands

```powershell
pnpm dev
.\start.ps1
.\stop.ps1
pnpm build
pnpm typecheck
pnpm test
pnpm test:v15
pnpm test:v15:integration
```

The V1.5 validation record reports TypeScript checks and V1.1–V1.5 unit/integration suites passing on 2026-10-23. Integration tests use temporary data where documented; some V1.3/V1.4 media-package integration paths require FFmpeg.

## Data and limitations

- The SQLite database and media are local. Backups can be large because they include project media and available historical exports.
- `.m2v` packages exclude model weights. An overwritten legacy `final.mp4` cannot be restored if the file no longer exists.
- CPU speech inference is supported but slower. Intel XPU acceleration is Intel-specific.
- Public webpage extraction does not access sign-in content. If extraction fails, paste the text instead.
- Commons images require the user to review license and attribution details. Model and source-media licenses remain applicable.

For detailed version history and implementation notes, see the [Chinese README](README.md). For V1.5 browser acceptance scenarios, see [doc/V1.5_manual_acceptance.md](doc/V1.5_manual_acceptance.md).
