from __future__ import annotations

import os
import platform
import re
import shutil
import subprocess
import tempfile
import wave
from pathlib import Path
from typing import Protocol
from uuid import uuid4

import pymupdf
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

DATA = Path(os.environ.get("M2V_DATA_DIR", "../../data")).resolve()
VOICE_DIR = DATA / "voices"
AUDIO_DIR = DATA / "audio"
F5TTS_MODEL_DIR = Path(os.environ.get("F5TTS_MODEL_DIR", DATA / "models" / "f5-tts" / "F5TTS_v1_Base")).resolve()
F5TTS_VOCODER_DIR = Path(os.environ.get("F5TTS_VOCODER_DIR", DATA / "models" / "f5-tts" / "vocos-mel-24khz")).resolve()
_DLL_DIRECTORY_HANDLES: dict[str, object] = {}
VOICE_DIR.mkdir(parents=True, exist_ok=True)
AUDIO_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="M2V Local Services", version="0.1.0")
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:3000"], allow_methods=["*"], allow_headers=["*"])

def _register_dll_directory(path: Path) -> None:
    if not hasattr(os, "add_dll_directory") or not path.is_dir():
        return
    normalized = str(path.resolve())
    if normalized not in _DLL_DIRECTORY_HANDLES:
        _DLL_DIRECTORY_HANDLES[normalized] = os.add_dll_directory(normalized)

def _register_ffmpeg_dll_directory() -> None:
    executable = shutil.which("ffmpeg")
    if executable:
        _register_dll_directory(Path(executable).parent)

def _ffmpeg_version() -> str | None:
    executable = shutil.which("ffmpeg")
    if not executable:
        return None
    try:
        result = subprocess.run([executable, "-version"], capture_output=True, text=True, timeout=5, check=False)
        match = re.search(r"ffmpeg version\s+(?:n)?([0-9]+(?:\.[0-9]+)*)", result.stdout, re.IGNORECASE)
        return match.group(1) if match else None
    except (OSError, subprocess.SubprocessError):
        return None

def _prepare_reference_prompt(ref_file: Path, transcript: str):
    from pydub import AudioSegment, silence

    audio = AudioSegment.from_file(ref_file)
    if len(audio) <= 12_000:
        return audio, transcript.strip()

    # Keep a complete spoken sentence and its matching transcript. F5-TTS
    # otherwise clips the audio to about 12 seconds but keeps the full text.
    threshold = audio.dBFS - 16
    speech = silence.detect_nonsilent(audio, min_silence_len=200, silence_thresh=threshold, seek_step=10)
    if speech:
        audio = audio[max(0, speech[0][0] - 100):min(len(audio), speech[-1][1] + 100)]
    pauses = silence.detect_silence(audio, min_silence_len=200, silence_thresh=threshold, seek_step=10)
    total_chars = sum(not char.isspace() for char in transcript)
    if total_chars == 0:
        raise ValueError("参考音频转录文本不能为空")

    boundaries = [index + 1 for index, char in enumerate(transcript) if char in "。！？!?；;"]
    if not boundaries:
        boundaries = [index + 1 for index, char in enumerate(transcript) if char in "，,"]
    matches = []
    approximate_matches = []
    for boundary in boundaries:
        prefix = transcript[:boundary].strip()
        expected_ms = len([char for char in prefix if not char.isspace()]) / total_chars * len(audio)
        for pause_start, pause_end in pauses:
            clip_end = pause_start + min(100, (pause_end - pause_start) // 2)
            if not 4_000 <= clip_end <= 11_500:
                continue
            deviation = abs(clip_end - expected_ms)
            approximate_matches.append((deviation, clip_end, prefix))
            # A loose match can pair speech from the next sentence with an
            # earlier transcript boundary and reproduce the unwanted words.
            if deviation <= max(1_000, expected_ms * 0.15):
                matches.append((clip_end, -deviation, prefix))

    if matches:
        clip_end, _, matched_text = max(matches)
    elif approximate_matches:
        # Long recordings often lack a detectable pause exactly at the
        # transcript boundary. Use the closest available pause as a fallback.
        _, clip_end, matched_text = min(approximate_matches, key=lambda item: item[0])
    else:
        # With no usable pauses, truncate by duration and keep the nearest
        # transcript boundary instead of failing the entire voice generation.
        clip_end = min(10_000, len(audio))
        target_chars = total_chars * clip_end / len(audio)
        candidate_boundaries = boundaries or list(range(1, len(transcript) + 1))
        boundary = min(
            candidate_boundaries,
            key=lambda index: abs(sum(not char.isspace() for char in transcript[:index]) - target_chars),
        )
        matched_text = transcript[:boundary].strip()
    return audio[:clip_end], matched_text

def _narration_segments(text: str) -> list[str]:
    # The storyboard may contain Markdown headings from an imported document.
    # Feed complete sentences to F5-TTS instead of one long mixed paragraph.
    text = re.sub(r"\[([^]]+)\]\([^)]+\)", r"\1", text)
    text = re.sub(r"(?m)^\s{0,3}#{1,6}\s*", "", text)
    text = re.sub(r"#{1,6}\s+", "", text)
    text = text.replace("**", "").replace("__", "").replace("`", "")
    segments: list[str] = []
    for line in text.splitlines():
        line = re.sub(r"\s+", " ", line).strip()
        if not line:
            continue
        line = re.sub(r"([。！？!?])[。！？!?]+", r"\1", line)
        for sentence in re.findall(r"[^。！？!?；;]+[。！？!?；;]?", line):
            sentence = sentence.strip()
            if not sentence:
                continue
            if sentence[-1] not in "。！？!?；;":
                sentence += "。"
            if len(sentence.encode("utf-8")) <= 150:
                segments.append(sentence)
                continue
            # A long sentence may be divided at an existing clause boundary;
            # never split in the middle of a Chinese word.
            clauses = re.split(r"(?<=[，,、：:])", sentence)
            current = ""
            for clause in clauses:
                if current and len((current + clause).encode("utf-8")) > 150:
                    segments.append(current.rstrip("，,、：:") + "。")
                    current = ""
                current += clause
            if current.strip():
                segments.append(current.strip())
    if not segments:
        raise ValueError("旁白文本为空，无法生成语音")
    return segments

def _remove_leading_intro(audio, intro_text: str, generated_text: str):
    from pydub import silence

    # F5-TTS may swallow the first generated word. Prefer the pause after a
    # disposable lead-in, but do not fail when the model speaks continuously.
    intro_bytes = len(intro_text.encode("utf-8"))
    generated_bytes = len(generated_text.encode("utf-8"))
    expected_ms = round(len(audio) * intro_bytes / max(generated_bytes, 1))
    spoken_ranges = silence.detect_nonsilent(
        audio,
        min_silence_len=120,
        silence_thresh=audio.dBFS - 16,
        seek_step=5,
    )
    boundaries = [
        start
        for (_, end), (start, _) in zip(spoken_ranges, spoken_ranges[1:])
        if end <= expected_ms + 700
    ]
    if boundaries:
        boundary = min(boundaries, key=lambda start: abs(start - expected_ms))
        # Preserve a little of the onset so low-volume initial phonemes survive.
        offset_ms = max(0, boundary - 80)
    else:
        # The sampler allocates duration in proportion to UTF-8 text length.
        # This provides a stable fallback when no audible pause was generated.
        offset_ms = expected_ms
    offset_ms = min(offset_ms, max(0, len(audio) - 250))
    return audio[offset_ms:]

class TTSProvider(Protocol):
    def synthesize(self, *, ref_file: Path, ref_text: str, text: str, output: Path, speed: float) -> None: ...

class F5TTSProvider:
    def synthesize(self, *, ref_file: Path, ref_text: str, text: str, output: Path, speed: float) -> None:
        missing_tools = [tool for tool in ("ffmpeg", "ffprobe") if shutil.which(tool) is None]
        if missing_tools:
            missing = "、".join(f"{tool}.exe" for tool in missing_tools)
            raise RuntimeError(f"缺少 {missing}。F5-TTS 需要 FFmpeg 处理参考音频；请将 FFmpeg 的 bin 目录加入 PATH，并重启 Python 服务。")
        ffmpeg_version = _ffmpeg_version()
        ffmpeg_major = int(ffmpeg_version.split(".", 1)[0]) if ffmpeg_version else None
        if ffmpeg_major is not None and ffmpeg_major not in range(4, 9):
            raise RuntimeError(f"当前 FFmpeg 版本为 {ffmpeg_version}，TorchCodec 0.10 仅支持 FFmpeg 4–8。请安装 FFmpeg 8 full-shared，将其 bin 目录放到 PATH 最前面，并重启 Python 服务。")
        # Python 3.8+ does not reliably use PATH to resolve dependent DLLs.
        # TorchCodec needs FFmpeg's shared DLLs discoverable on Windows.
        _register_ffmpeg_dll_directory()
        import f5_tts.api as f5_api
        import torch
        _register_dll_directory(Path(torch.__file__).parent / "lib")
        device = "xpu" if hasattr(torch, "xpu") and torch.xpu.is_available() else "cpu"
        checkpoint = F5TTS_MODEL_DIR / "model_1250000.safetensors"
        vocab = F5TTS_MODEL_DIR / "vocab.txt"
        model_options = {"ckpt_file": str(checkpoint), "vocab_file": str(vocab)} if checkpoint.is_file() and vocab.is_file() else {}
        vocoder_config = F5TTS_VOCODER_DIR / "config.yaml"
        vocoder_weights = F5TTS_VOCODER_DIR / "pytorch_model.bin"
        if vocoder_config.is_file() and vocoder_weights.is_file():
            model_options["vocoder_local_path"] = str(F5TTS_VOCODER_DIR)
        from pydub import AudioSegment

        prompt_audio, prompt_text = _prepare_reference_prompt(ref_file, ref_text)
        # Match the Chinese sentence-ending punctuation used in the reference
        # transcript. Keep the generation seed fixed so a reviewed sample can
        # be reproduced when the scene is regenerated.
        prompt_text = prompt_text.rstrip().rstrip("。！？!?；;.").rstrip() + "。"
        segments = _narration_segments(text)
        with tempfile.TemporaryDirectory(dir=AUDIO_DIR) as temp_dir:
            prompt_path = Path(temp_dir) / "reference.wav"
            prompt_audio.export(prompt_path, format="wav")
            engine = f5_api.F5TTS(device=device, **model_options)
            combined = None
            for index, segment in enumerate(segments):
                segment_path = Path(temp_dir) / f"segment-{index}.wav"
                intro = "现在开始。"
                generated_text = intro + segment
                engine.infer(ref_file=str(prompt_path), ref_text=prompt_text, gen_text=generated_text, file_wave=str(segment_path), speed=speed, seed=42)
                spoken = AudioSegment.from_wav(segment_path)
                if len(spoken) == 0:
                    raise RuntimeError(f"第 {index + 1} 段旁白没有可用语音")
                spoken = _remove_leading_intro(spoken, intro, generated_text)
                # Preserve the entire model output. Low-volume initial phonemes
                # can be mistaken for silence and trimming may remove a word.
                combined = spoken if combined is None else combined + AudioSegment.silent(duration=120, frame_rate=spoken.frame_rate) + spoken
            combined.export(output, format="wav")

@app.get("/health")
def health():
    codec_available, codec_error = _torchcodec_status()
    ffmpeg_version = _ffmpeg_version()
    ffmpeg_major = int(ffmpeg_version.split(".", 1)[0]) if ffmpeg_version else None
    return {"ok": True, "python": platform.python_version(), "pdf": True, "tts": _tts_available(), "torchcodec": codec_available, "torchcodecError": codec_error, "ffmpeg": shutil.which("ffmpeg") is not None, "ffmpegVersion": ffmpeg_version, "ffmpegCompatible": ffmpeg_major in range(4, 9) if ffmpeg_major is not None else False, "ffprobe": shutil.which("ffprobe") is not None}

def _tts_available() -> bool:
    try:
        from f5_tts.api import F5TTS  # noqa: F401
        return True
    except ImportError:
        return False

def _torchcodec_status() -> tuple[bool, str | None]:
    try:
        _register_ffmpeg_dll_directory()
        import torch
        _register_dll_directory(Path(torch.__file__).parent / "lib")
        import torchcodec  # noqa: F401
        return True, None
    except Exception as exc:
        return False, str(exc)

@app.post("/extract/pdf")
async def extract_pdf(file: UploadFile = File(...)):
    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(400, "只支持 PDF 文件")
    raw = await file.read()
    if len(raw) > 100 * 1024 * 1024:
        raise HTTPException(413, "PDF 文件不能超过 100 MB")
    try:
        doc = pymupdf.open(stream=raw, filetype="pdf")
        parts = [f"## 第 {index + 1} 页\n{page.get_text('text')}" for index, page in enumerate(doc)]
        text = "\n\n".join(part for part in parts if part.strip())
    except Exception as exc:
        raise HTTPException(422, f"无法解析 PDF：{exc}") from exc
    if not text.strip():
        raise HTTPException(422, "未能从 PDF 提取文本；扫描件 OCR 暂不支持")
    return {"text": text, "pages": len(parts), "filename": file.filename}

@app.post("/voices")
async def create_voice(audio: UploadFile | None = File(None), transcript: str = Form(...), voice_id: str = Form("my-voice")):
    if not transcript.strip():
        raise HTTPException(400, "转录文本不能为空")
    safe_id = "".join(c for c in voice_id if c.isalnum() or c in "-_ ").strip().replace(" ", "-") or "my-voice"
    directory = VOICE_DIR / safe_id
    directory.mkdir(parents=True, exist_ok=True)
    if audio is not None:
        suffix = Path(audio.filename or "reference.wav").suffix.lower()
        if suffix not in {".wav", ".mp3", ".flac", ".ogg", ".m4a"}:
            raise HTTPException(400, "音频格式需为 WAV、MP3、FLAC、OGG 或 M4A")
        target = directory / f"reference{suffix}"
        for old_reference in directory.glob("reference.*"):
            old_reference.unlink(missing_ok=True)
        target.write_bytes(await audio.read())
    else:
        references = list(directory.glob("reference.*"))
        if not references:
            raise HTTPException(404, "请先上传通用参考音频")
        target = references[0]
    (directory / "transcript.txt").write_text(transcript, encoding="utf-8")
    return {"id": safe_id, "audioPath": str(target), "transcript": transcript, "provider": "f5-tts"}

@app.post("/synthesize")
async def synthesize(text: str = Form(...), voice_id: str = Form(...), speed: float = Form(1.0)):
    if not _tts_available():
        raise HTTPException(503, "未安装 F5-TTS，请使用 uv sync --extra tts，并安装受支持的 PyTorch/XPU 运行环境")
    safe_id = "".join(c for c in voice_id if c.isalnum() or c in "-_ ").strip().replace(" ", "-") or "my-voice"
    directory = VOICE_DIR / safe_id
    refs = list(directory.glob("reference.*"))
    transcript_file = directory / "transcript.txt"
    if not refs or not transcript_file.exists():
        raise HTTPException(404, "声音档案不存在")
    output = AUDIO_DIR / f"{uuid4()}.wav"
    try:
        F5TTSProvider().synthesize(ref_file=refs[0], ref_text=transcript_file.read_text(encoding="utf-8"), text=text, output=output, speed=speed)
    except Exception as exc:
        raise HTTPException(500, f"F5-TTS 生成失败：{exc}") from exc
    try:
        with wave.open(str(output), "rb") as audio_file:
            duration = audio_file.getnframes() / audio_file.getframerate()
    except (wave.Error, ZeroDivisionError):
        duration = 0
    return {"audioPath": str(output), "filename": output.name, "duration": duration}
