from __future__ import annotations

import asyncio
import hashlib
import ipaddress
import json
import os
import platform
import posixpath
import re
import socket
import shutil
import subprocess
import tempfile
import wave
import zipfile
from html.parser import HTMLParser
from pathlib import Path
from typing import Protocol
from uuid import uuid4
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlparse
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener
import xml.etree.ElementTree as ET

import pymupdf
from app.presentation import converters, presentation_capabilities, MISSING_RENDERER
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from starlette.concurrency import run_in_threadpool

DATA = Path(os.environ.get("M2V_DATA_DIR", "../../data")).resolve()
VOICE_DIR = DATA / "voices"
AUDIO_DIR = DATA / "audio"
F5TTS_MODEL_DIR = Path(os.environ.get("F5TTS_MODEL_DIR", DATA / "models" / "f5-tts" / "F5TTS_v1_Base")).resolve()
F5TTS_VOCODER_DIR = Path(os.environ.get("F5TTS_VOCODER_DIR", DATA / "models" / "f5-tts" / "vocos-mel-24khz")).resolve()
_DLL_DIRECTORY_HANDLES: dict[str, object] = {}
_TTS_LOCK = asyncio.Lock()
_ALIGN_LOCK = asyncio.Lock()
_ALIGN_MODELS: dict[str, tuple[object, object]] = {}
VOICE_DIR.mkdir(parents=True, exist_ok=True)
AUDIO_DIR.mkdir(parents=True, exist_ok=True)
PROJECT_DIR = DATA / "projects"
PROJECT_DIR.mkdir(parents=True, exist_ok=True)
WEB_PUBLIC_ASSETS = Path(__file__).resolve().parents[3] / "apps" / "web" / "public" / "projects"

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

    # Match clause pauses as well as sentence ends. A clipped reference must
    # never retain transcript text that belongs to audio past the clip point.
    boundaries = [index + 1 for index, char in enumerate(transcript) if char in "。！？!?；;，,、：:"]
    if not boundaries:
        boundaries = list(range(1, len(transcript) + 1))
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
            # The boundary may be slightly after the measured pause because
            # speech duration is only estimated from character count. Exclude
            # later clauses so their words cannot leak into generated speech.
            if expected_ms > clip_end + 250:
                continue
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
        candidate_boundaries = [
            index for index in boundaries
            if sum(not char.isspace() for char in transcript[:index]) <= target_chars
        ]
        boundary = candidate_boundaries[-1] if candidate_boundaries else max(1, min(len(transcript), int(target_chars)))
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

class TTSProvider(Protocol):
    def synthesize(self, *, ref_file: Path, ref_text: str, text: str, output: Path, speed: float) -> None: ...

class F5TTSProvider:
    def synthesize(self, *, ref_file: Path, ref_text: str, text: str, output: Path, speed: float, sentence_pause: float = 0.12, pronunciation_scopes=None, pronunciation_base=None, pronunciation_model=None) -> list[str]:
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
        from app.pronunciation import resolve as resolve_pronunciation, f5_pronunciation

        prompt_audio, prompt_text = _prepare_reference_prompt(ref_file, ref_text)
        # Match the Chinese sentence-ending punctuation used in the reference
        # transcript. Keep the generation seed fixed so a reviewed sample can
        # be reproduced when the scene is regenerated.
        prompt_text = prompt_text.rstrip().rstrip("。！？!?；;,.，、：:").rstrip() + "。"
        segments = _narration_segments(text)
        normalized = ' '.join(segments)
        readings, pronunciation_warnings = resolve_pronunciation(
            normalized, pronunciation_scopes or [],
            pronunciation_base or os.environ.get('OLLAMA_BASE_URL', 'http://127.0.0.1:11434'),
            pronunciation_model or os.environ.get('OLLAMA_MODEL', 'qwen3:4b'),
        )
        with tempfile.TemporaryDirectory(dir=AUDIO_DIR) as temp_dir:
            prompt_path = Path(temp_dir) / "reference.wav"
            prompt_audio.export(prompt_path, format="wav")
            engine = f5_api.F5TTS(device=device, **model_options)
            combined = None
            offset = 0
            for index, segment in enumerate(segments):
                segment_path = Path(temp_dir) / f"segment-{index}.wav"
                with f5_pronunciation(segment, readings[offset:offset + len(segment)]):
                    engine.infer(ref_file=str(prompt_path), ref_text=prompt_text, gen_text=segment, file_wave=str(segment_path), speed=speed, seed=42)
                offset += len(segment) + 1
                spoken = AudioSegment.from_wav(segment_path)
                if len(spoken) == 0:
                    raise RuntimeError(f"第 {index + 1} 段旁白没有可用语音")
                # Keep the complete output: trimming by estimated text duration
                # could leave synthetic lead-in words or clip the real opening.
                combined = spoken if combined is None else combined + AudioSegment.silent(duration=round(sentence_pause * 1000), frame_rate=spoken.frame_rate) + spoken
            combined.export(output, format="wav")
        return pronunciation_warnings

def _tesseract_executable():
    executable = shutil.which("tesseract")
    if not executable and os.name == "nt":
        candidate = Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "Tesseract-OCR" / "tesseract.exe"
        if candidate.is_file():
            executable = str(candidate)
    if executable:
        directory = str(Path(executable).resolve().parent)
        path_entries = os.environ.get("PATH", "").split(os.pathsep)
        if directory.casefold() not in {entry.casefold() for entry in path_entries}:
            os.environ["PATH"] = os.pathsep.join([directory, *path_entries])
    return executable

def _ocr_data_dir():
    configured = os.environ.get("TESSDATA_PREFIX")
    executable = _tesseract_executable()
    directory = Path(configured) if configured else Path(executable).parent / "tessdata" if executable else None
    if directory and all((directory / f"{language}.traineddata").is_file() for language in ("chi_sim", "eng")):
        return str(directory)
    return None

@app.get("/health")
def health():
    codec_available, codec_error = _torchcodec_status()
    ffmpeg_version = _ffmpeg_version()
    ffmpeg_major = int(ffmpeg_version.split(".", 1)[0]) if ffmpeg_version else None
    return {"ok": True, "python": platform.python_version(), "pdf": True, "ocr": bool(_ocr_data_dir()), "ttsModels": all(path.is_file() for path in [F5TTS_MODEL_DIR / "model_1250000.safetensors", F5TTS_MODEL_DIR / "vocab.txt", F5TTS_VOCODER_DIR / "config.yaml", F5TTS_VOCODER_DIR / "pytorch_model.bin"]), "tts": _tts_available(), "torchcodec": codec_available, "torchcodecError": codec_error, "ffmpeg": shutil.which("ffmpeg") is not None, "ffmpegVersion": ffmpeg_version, "ffmpegCompatible": ffmpeg_major in range(4, 9) if ffmpeg_major is not None else False, "ffprobe": shutil.which("ffprobe") is not None}

def _tts_available() -> bool:
    try:
        from f5_tts.api import F5TTS  # noqa: F401
        return True
    except Exception:
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
    def parse():
        parts = []
        ocr_pages = []
        failed_pages = []
        with pymupdf.open(stream=raw, filetype="pdf") as doc:
            if doc.needs_pass:
                raise ValueError("PDF 已加密，请先解除密码保护")
            if len(doc) > 500:
                raise ValueError("单个 PDF 最多支持 500 页")
            for index, page in enumerate(doc):
                try:
                    text = page.get_text("text", sort=True).strip()
                    if len(re.sub(r"\s+", "", text)) < 30 and page.get_images():
                        tessdata = _ocr_data_dir()
                        if not tessdata:
                            raise ValueError("扫描页需要本地 Tesseract OCR，请安装 chi_sim、eng 语言包并设置 TESSDATA_PREFIX")
                        textpage = page.get_textpage_ocr(language="chi_sim+eng", dpi=150, full=True, tessdata=tessdata)
                        text = page.get_text("text", textpage=textpage, sort=True).strip()
                        ocr_pages.append(index + 1)
                    if text: parts.append(f"## 第 {index + 1} 页\n{text}")
                except Exception as exc:
                    # A single unreadable page must not discard the pages that did
                    # work, so record it and let the caller review the rest.
                    failed_pages.append({"page": index + 1, "error": str(exc)})
            pages = len(doc)
        text = "\n\n".join(parts)
        if failed_pages and len(failed_pages) >= pages:
            raise ValueError(f"全部 {pages} 页都无法提取，例如第 {failed_pages[0]['page']} 页：{failed_pages[0]['error']}")
        if len(re.sub(r"\s+", "", text)) < 30:
            raise ValueError("PDF 未提取到足够正文，请检查扫描质量或粘贴识别后的文字")
        return {"text": text, "pages": pages, "ocrPages": ocr_pages, "failedPages": failed_pages, "filename": file.filename}
    try:
        return await run_in_threadpool(parse)
    except Exception as exc:
        raise HTTPException(422, f"无法解析 PDF：{exc}") from exc

_HUGGING = set(",;:.!?)]}%\"'”’")
_OPENING = set("([{“‘")

def _needs_space(previous: str, following: str) -> bool:
    if following in _HUGGING: return False
    if previous in _OPENING: return False
    if not (previous.isascii() and following.isascii()): return False
    if following in _OPENING: return True
    if previous in _HUGGING: return True
    return previous.isalnum() and following.isalnum()

def _join_tokens(values: list[str]) -> str:
    # CJK is split across inline elements without separators, so spaces are only
    # inserted between latin text, and never on the wrong side of punctuation.
    out = ""
    for value in values:
        if out and _needs_space(out[-1], value[0]): out += " "
        out += value
    return out

class _ArticleText(HTMLParser):
    """Readable article text with site chrome removed.

    Pages rarely label navigation with <nav>: menus, sidebars, breadcrumbs, cookie
    bars and "related" lists are plain <div>s. Those are skipped by role/class/id,
    and anything still leaking through is dropped by link density, because chrome
    almost always renders as short paragraphs made mostly of link text.
    """
    SKIP_TAGS = {"script", "style", "noscript", "svg", "form", "template", "iframe", "select", "button", "nav", "footer", "aside", "menu"}
    BLOCK_TAGS = {"p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "blockquote", "br", "div", "section", "tr", "td", "th", "dd", "dt", "figcaption", "pre"}
    ROOT_TAGS = {"article", "main"}
    # Void elements have no closing tag, so remembering one in skip_stack would
    # swallow the rest of the page.
    VOID_TAGS = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}
    NEVER_DENY = {"html", "head", "body", "title", "meta", "link", "base"}
    # Class/id hints are only trusted on containers; an inline span can legally be
    # unbalanced, which would leave skip_stack stuck and truncate the article.
    CONTAINER_TAGS = {"div", "section", "header", "footer", "aside", "nav", "form", "ul", "ol", "dl", "li", "table", "thead", "tbody", "tfoot", "tr", "td", "th", "span", "p", "figure", "figcaption", "menu", "dialog", "details", "fieldset", "address"}
    DENY_ROLES = {"navigation", "banner", "complementary", "contentinfo", "search", "menu", "menubar", "dialog", "alert"}
    DENY_WORDS = {"nav", "navbar", "navigation", "menu", "menubar", "submenu", "sidebar", "breadcrumb", "breadcrumbs", "footer", "masthead", "toolbar", "pagination", "pager", "topbar", "bottombar", "offcanvas", "drawer", "comments", "share", "sharing", "social", "related", "recommended", "recommend", "advert", "advertisement", "ads", "adsense", "sponsor", "sponsored", "promo", "cookie", "cookies", "consent", "popup", "modal", "subscribe", "newsletter", "widget", "taglist", "dropdown", "references", "reference", "reflist", "footnotes", "navbox", "catlinks", "toc", "editsection", "printfooter", "noprint"}
    ROOT_HINTS = ("articlebody", "article-body", "article_body", "articlecontent", "article-content", "article_content", "post-content", "post_content", "post-body", "post_body", "entry-content", "entry_content", "rich_media_content", "markdown-body", "markdown_body", "story-body", "story_body", "main-content", "main_content", "content-body", "content_body", "prose")

    def __init__(self, heuristics: bool = True):
        super().__init__()
        self.heuristics = heuristics
        self.tokens: list[tuple[str, bool, bool]] = []
        self.title: list[str] = []
        self.in_title = False
        self.anchor_depth = 0
        self.root_stack: list[str] = []
        self.skip_stack: list[str] = []

    @staticmethod
    def _marker(attrs: dict) -> str:
        return f"{attrs.get('class') or ''} {attrs.get('id') or ''}".strip().lower()

    def _opens_root(self, tag: str, attrs: dict) -> bool:
        if tag in self.ROOT_TAGS: return True
        if (attrs.get("itemprop") or "").strip().lower() == "articlebody": return True
        marker = self._marker(attrs)
        return bool(marker) and any(hint in marker for hint in self.ROOT_HINTS)

    def _denies(self, tag: str, attrs: dict) -> bool:
        if tag in self.SKIP_TAGS: return True
        if not self.heuristics: return False
        if self._opens_root(tag, attrs): return False
        if tag in self.NEVER_DENY: return False
        if (attrs.get("role") or "").strip().lower() in self.DENY_ROLES: return True
        if tag not in self.CONTAINER_TAGS: return False
        marker = self._marker(attrs)
        if not marker: return False
        return bool(set(re.split(r"[^a-z0-9]+", marker)) & self.DENY_WORDS)

    @staticmethod
    def _close(stack: list[str], tag: str) -> None:
        for index in range(len(stack) - 1, -1, -1):
            if stack[index] == tag:
                del stack[index]
                return

    def _separate(self) -> None:
        if not self.tokens or self.tokens[-1][0] != "\n": self.tokens.append(("\n", False, False))

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if tag == "title": self.in_title = True
        if tag == "a": self.anchor_depth += 1
        if self._opens_root(tag, attributes): self.root_stack.append(tag)
        if self._denies(tag, attributes):
            if tag not in self.VOID_TAGS: self.skip_stack.append(tag)
            return
        if tag in self.BLOCK_TAGS and not self.skip_stack: self._separate()

    def handle_endtag(self, tag):
        if tag == "title": self.in_title = False
        if tag == "a" and self.anchor_depth: self.anchor_depth -= 1
        self._close(self.root_stack, tag)
        self._close(self.skip_stack, tag)
        # Unbalanced markup must not hide the rest of the document.
        if tag in {"body", "html"}: self.skip_stack.clear()
        if tag in self.BLOCK_TAGS and not self.skip_stack: self._separate()

    def handle_data(self, data):
        value = re.sub(r"\s+", " ", data).strip()
        if not value: return
        if self.in_title:
            self.title.append(value)
            return
        if self.skip_stack: return
        self.tokens.append((value, self.anchor_depth > 0, bool(self.root_stack)))

    def _paragraphs(self, article_only: bool) -> list[str]:
        groups: list[list[tuple[str, bool]]] = []
        current: list[tuple[str, bool]] = []
        for text, from_anchor, in_root in self.tokens:
            if text == "\n":
                if current: groups.append(current); current = []
                continue
            if article_only and not in_root: continue
            current.append((text, from_anchor))
        if current: groups.append(current)
        paragraphs: list[str] = []
        for group in groups:
            text = re.sub(r"\s*\[\d+\]", "", _join_tokens([item for item, _ in group])).strip()
            if not text: continue
            anchor_chars = sum(len(item) for item, anchored in group if anchored)
            if len(text) < 40 and anchor_chars / len(text) > 0.6: continue
            if paragraphs and paragraphs[-1] == text: continue
            paragraphs.append(text)
        return paragraphs

    @property
    def article_parts(self) -> list[str]:
        return self._paragraphs(True)

    @property
    def parts(self) -> list[str]:
        return self._paragraphs(False)

    def body(self) -> str:
        article = self.article_parts
        if len("".join(article)) >= 100: return "\n\n".join(article).strip()
        parts = self.parts
        if len("".join(parts)) >= 100: return "\n\n".join(parts).strip()
        return "\n\n".join(article or parts).strip()


def _headline(title: str, body: str) -> str:
    """Heading to prepend to the body, or "" when the body already opens with it.

    <title> carries the site name ("Water cycle - Wikipedia") while the article's own
    <h1> repeats just the topic, so prepending it blindly duplicates the first line.
    """
    if not title: return ""
    stem = re.split(r"\s+[-\u2013\u2014|_·]\s+", title)[0].strip()
    first = body.split("\n", 1)[0].strip()
    return "" if first and first == stem else title


def _validate_public_url(value: str) -> str:
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("只支持无需登录的公开 HTTP/HTTPS 网页")
    if parsed.port is not None and parsed.port != (443 if parsed.scheme == "https" else 80):
        raise ValueError("网页链接只能使用标准 HTTP/HTTPS 端口")
    host = parsed.hostname.rstrip(".").lower()
    if host in {"localhost", "localhost.localdomain"} or host.endswith(".local"):
        raise ValueError("不允许访问本机或内网地址")
    try:
        addresses = {ipaddress.ip_address(host)}
    except ValueError:
        try: addresses = {ipaddress.ip_address(item[4][0]) for item in socket.getaddrinfo(host, parsed.port or (443 if parsed.scheme == "https" else 80), type=socket.SOCK_STREAM)}
        except OSError as exc: raise ValueError("无法解析网页主机名") from exc
    if not addresses or any(not address.is_global for address in addresses):
        raise ValueError("不允许访问本机或内网地址")
    return value

class _SafeRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        _validate_public_url(urljoin(req.full_url, newurl))
        return super().redirect_request(req, fp, code, msg, headers, newurl)

@app.post("/extract/url")
async def extract_url(payload: dict):
    try:
        url = _validate_public_url(str(payload.get("url", "")))
        request = Request(url, headers={"User-Agent": "ZhiyingLocalStudio/1.0 (public article text extraction)", "Accept": "text/html,application/xhtml+xml"})
        def load() -> tuple[bytes, str]:
            try:
                with build_opener(ProxyHandler({}), _SafeRedirect()).open(request, timeout=45) as response:
                    if "text/html" not in response.headers.get("Content-Type", "").lower(): raise ValueError("链接不是 HTML 文章页面")
                    raw = response.read(5 * 1024 * 1024 + 1)
                    if len(raw) > 5 * 1024 * 1024: raise ValueError("网页超过 5 MB，无法导入")
                    return raw, response.headers.get_content_charset() or "utf-8"
            except HTTPError:
                raise
            except (TimeoutError, socket.timeout) as exc:
                raise ValueError("网页加载超过 45 秒仍未返回。请稍后重试，或改用「粘贴正文」导入。") from exc
            except URLError as exc:
                # urlopen wraps socket timeouts, and the raw text would leak the
                # internal error straight into the review panel.
                if isinstance(exc.reason, (TimeoutError, socket.timeout)):
                    raise ValueError("网页加载超过 45 秒仍未返回。请稍后重试，或改用「粘贴正文」导入。") from exc
                raise ValueError(f"无法访问该网页：{exc.reason}") from exc
        raw, charset = load()
        decoded = raw.decode(charset, errors="replace")
        parser = _ArticleText(); parser.feed(decoded)
        body = parser.body()
        if len(body) < 100:
            # Chrome filtering must never turn a readable page into an error, so
            # fall back to structure-only filtering before giving up.
            relaxed = _ArticleText(heuristics=False); relaxed.feed(decoded)
            if len(relaxed.body()) > len(body):
                parser, body = relaxed, relaxed.body()
        if len(body) < 100: raise ValueError("未能提取到足够的正文内容，请改用粘贴文本")
        title = " ".join(parser.title).strip()
        heading = _headline(title, body)
        # A single page is still one page; without this the review panel reports 0.
        return {"text": f"# {heading}\n\n{body}" if heading else body, "title": title, "url": url, "pages": 1}
    except (ValueError, HTTPError, URLError, TimeoutError, OSError) as exc:
        raise HTTPException(422, str(exc)) from exc

def _pptx_slide_text(archive: zipfile.ZipFile, slide_path: str, slide_number: int) -> tuple[str, str, list[tuple[str, bytes]]]:
    ns = {"a": "http://schemas.openxmlformats.org/drawingml/2006/main", "p": "http://schemas.openxmlformats.org/presentationml/2006/main", "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships"}
    root = ET.fromstring(archive.read(slide_path))
    # Table cells are emitted once as "表格行：" lines below; reading them here as
    # well would duplicate every table twice in the source text.
    rows = root.findall(".//a:tr", ns)
    cell_paragraphs = {id(paragraph) for row in rows for cell in row.findall("a:tc", ns) for paragraph in cell.findall(".//a:p", ns)}
    paragraphs = []
    for paragraph in root.findall(".//a:p", ns):
        if id(paragraph) in cell_paragraphs: continue
        text = "".join(node.text or "" for node in paragraph.findall(".//a:t", ns)).strip()
        if text: paragraphs.append(text)
    rel_path = slide_path.replace("ppt/slides/", "ppt/slides/_rels/") + ".rels"
    images: list[tuple[str, bytes]] = []
    notes_path = f"ppt/notesSlides/notesSlide{slide_number}.xml"
    if rel_path in archive.namelist():
        rel_root = ET.fromstring(archive.read(rel_path))
        for rel in rel_root:
            relation_type = rel.attrib.get("Type", "")
            target = rel.attrib.get("Target", "")
            related_path = posixpath.normpath(f"{Path(slide_path).parent.as_posix()}/{target}")
            if relation_type.endswith("/image") and related_path in archive.namelist(): images.append((Path(related_path).name, archive.read(related_path)))
            elif relation_type.endswith("/notesSlide"): notes_path = related_path
    for row in rows:
        cells = [" ".join(node.text or "" for node in cell.findall(".//a:t", ns)).strip() for cell in row.findall("a:tc", ns)]
        if any(cells): paragraphs.append("表格行：" + " | ".join(cells))
    notes = ""
    if notes_path in archive.namelist():
        note_root = ET.fromstring(archive.read(notes_path))
        note_paragraphs = []
        for paragraph in note_root.findall(".//a:p", ns):
            text = "".join(node.text or "" for node in paragraph.findall(".//a:t", ns)).strip()
            if text and not re.fullmatch(r"\d+", text): note_paragraphs.append(text)
        notes = "\n".join(note_paragraphs)
    return "\n".join(paragraphs), notes, images

def _pptx_slide_order(archive: zipfile.ZipFile) -> list[str]:
    files = set(archive.namelist())
    fallback = sorted((name for name in files if re.fullmatch(r"ppt/slides/slide\d+\.xml", name)), key=lambda name: int(re.search(r"slide(\d+)", name).group(1)))
    presentation = "ppt/presentation.xml"; rels = "ppt/_rels/presentation.xml.rels"
    if presentation not in files or rels not in files: return fallback
    ns = {"p": "http://schemas.openxmlformats.org/presentationml/2006/main", "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships"}
    relationship_root = ET.fromstring(archive.read(rels))
    targets = {node.attrib.get("Id"): node.attrib.get("Target", "") for node in relationship_root}
    ids = [node.attrib.get(f"{{{ns['r']}}}id") for node in ET.fromstring(archive.read(presentation)).findall(".//p:sldId", ns)]
    ordered = [(targets[item].lstrip("/") if targets[item].startswith("/") else posixpath.normpath(f"ppt/{targets[item]}")) for item in ids if item in targets]
    return [item for item in ordered if item in files] or fallback

@app.get("/capabilities")
def capabilities():
    return presentation_capabilities()


def _render_pptx_pdf(source: Path, output_dir: Path) -> Path:
    available = converters()
    soffice = available['libreoffice']
    if soffice:
        result = subprocess.run([soffice, "--headless", "--convert-to", "pdf", "--outdir", str(output_dir), str(source)], capture_output=True, text=True, timeout=180)
        candidate = output_dir / f"{source.stem}.pdf"
        if result.returncode == 0 and candidate.is_file(): return candidate
    if available['powerpoint']:
        script = output_dir / "export-pptx.ps1"
        script.write_text("param([string]$InputPath,[string]$OutputPath)\n$app = New-Object -ComObject PowerPoint.Application\n$app.Visible = [Microsoft.Office.Core.MsoTriState]::msoFalse\n$presentation = $app.Presentations.Open($InputPath, $true, $false, $false)\ntry { $presentation.SaveAs($OutputPath, 32) } finally { $presentation.Close(); $app.Quit() }\n", encoding="utf-8")
        result = subprocess.run(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(script), "-InputPath", str(source), "-OutputPath", str(output_dir / f"{source.stem}.pdf")], capture_output=True, text=True, timeout=180)
        candidate = output_dir / f"{source.stem}.pdf"
        if result.returncode == 0 and candidate.is_file(): return candidate
    raise RuntimeError("保留原页画面需要安装 PowerPoint 或 LibreOffice；选择“提取内容重建”即可继续。")

@app.post("/extract/pptx")
async def extract_pptx(file: UploadFile = File(...), projectId: str = Form(...), mode: str = Form("rebuild")):
    if mode not in {'rebuild', 'preserve'}: raise HTTPException(400, '无效的 PPT 处理方式')
    if mode == 'preserve' and not presentation_capabilities()['preservePptx']:
        raise HTTPException(422, MISSING_RENDERER)
    if not file.filename or not file.filename.lower().endswith(".pptx"): raise HTTPException(400, "只支持 PPTX 文件")
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", projectId): raise HTTPException(400, "项目 ID 无效")
    raw = await file.read()
    if len(raw) > 100 * 1024 * 1024: raise HTTPException(413, "PPTX 文件不能超过 100 MB")
    project_root = (PROJECT_DIR / projectId).resolve()
    asset_root = (project_root / "assets").resolve(); asset_root.mkdir(parents=True, exist_ok=True)
    public_prefix = f"projects/{projectId}/assets"
    try:
        with tempfile.TemporaryDirectory(dir=PROJECT_DIR) as temp_dir:
            source = Path(temp_dir) / Path(file.filename).name; source.write_bytes(raw)
            with zipfile.ZipFile(source) as archive:
                if sum(info.file_size for info in archive.infolist()) > 500 * 1024 * 1024: raise ValueError("PPTX 解压后内容不能超过 500 MB")
                if any(info.file_size > 100 * 1024 * 1024 for info in archive.infolist()): raise ValueError("PPTX 内单个文件不能超过 100 MB")
                slide_names = _pptx_slide_order(archive)
                if not slide_names: raise ValueError("PPTX 中没有可读取的幻灯片")
                if len(slide_names) > 100: raise ValueError("单个 PPTX 最多支持 100 张幻灯片")
                blocks = []; assets = []
                for index, slide_path in enumerate(slide_names, 1):
                    slide_text, notes, images = _pptx_slide_text(archive, slide_path, index)
                    if not slide_text.strip() and not notes.strip(): slide_text = "此页没有可提取的文本内容。"
                    blocks.append(f"## 幻灯片 {index}\n标题和正文：\n{slide_text}\n\n演讲者备注（优先作为旁白依据）：\n{notes or '（无备注，请根据页面内容生成旁白）'}")
                    for image_index, (image_name, image_bytes) in enumerate(images, 1):
                        suffix = Path(image_name).suffix.lower()
                        if suffix not in {".png", ".jpg", ".jpeg", ".webp"}: continue
                        name = f"slide-{index:03d}-image-{image_index:02d}{suffix}"
                        (asset_root / name).write_bytes(image_bytes)
                        web_asset_root = WEB_PUBLIC_ASSETS / projectId / "assets"; web_asset_root.mkdir(parents=True, exist_ok=True); (web_asset_root / name).write_bytes(image_bytes)
                        assets.append({"path": f"{public_prefix}/{name}", "name": name})
            if mode == "preserve":
                pdf_path = _render_pptx_pdf(source, Path(temp_dir))
                with pymupdf.open(pdf_path) as doc:
                    for index, page in enumerate(doc, 1):
                        name = f"slide-{index:03d}.png"
                        page.get_pixmap(matrix=pymupdf.Matrix(1.5, 1.5), alpha=False).save(asset_root / name)
                        web_asset_root = WEB_PUBLIC_ASSETS / projectId / "assets"; web_asset_root.mkdir(parents=True, exist_ok=True); shutil.copyfile(asset_root / name, web_asset_root / name)
                        assets.append({"path": f"{public_prefix}/{name}", "name": name})
        return {"text": "\n\n".join(blocks), "pages": len(slide_names), "assets": assets, "filename": file.filename}
    except (zipfile.BadZipFile, ET.ParseError, ValueError, RuntimeError, OSError, subprocess.SubprocessError) as exc:
        raise HTTPException(422, f"PPTX 解析失败：{exc}") from exc

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
async def synthesize(text: str = Form(...), voice_id: str = Form(...), speed: float = Form(1.0), sentence_pause: float = Form(0.12), pronunciation_scopes: str = Form('[]'), pronunciation_base: str = Form('http://127.0.0.1:11434'), pronunciation_model: str = Form('qwen3:4b')):
    if not 0.5 <= speed <= 3 or not 0 <= sentence_pause <= 3:
        raise HTTPException(400, "语速或停顿超出范围")
    if not await run_in_threadpool(_tts_available):
        raise HTTPException(503, "未安装 F5-TTS，请使用 uv sync --extra tts，并安装受支持的 PyTorch/XPU 运行环境")
    try:
        from app.pronunciation import validate_rules
        scopes = json.loads(pronunciation_scopes)
        if not isinstance(scopes, list) or len(scopes) > 3:
            raise ValueError('纠音作用域格式错误')
        for rules in scopes:
            validate_rules(rules)
    except (ValueError, TypeError) as exc:
        raise HTTPException(400, str(exc)) from exc
    safe_id = "".join(c for c in voice_id if c.isalnum() or c in "-_ ").strip().replace(" ", "-") or "my-voice"
    directory = VOICE_DIR / safe_id
    refs = list(directory.glob("reference.*"))
    transcript_file = directory / "transcript.txt"
    if not refs or not transcript_file.exists():
        raise HTTPException(404, "声音档案不存在")
    output = AUDIO_DIR / f"{uuid4()}.wav"
    try:
        async with _TTS_LOCK:
            pronunciation_warnings = await run_in_threadpool(
                F5TTSProvider().synthesize,
                ref_file=refs[0],
                ref_text=transcript_file.read_text(encoding="utf-8"),
                text=text,
                output=output,
                speed=speed,
                sentence_pause=sentence_pause,
                pronunciation_scopes=scopes,
                pronunciation_base=pronunciation_base,
                pronunciation_model=pronunciation_model,
            )
    except Exception as exc:
        raise HTTPException(500, f"F5-TTS 生成失败：{exc}") from exc
    try:
        with wave.open(str(output), "rb") as audio_file:
            duration = audio_file.getnframes() / audio_file.getframerate()
    except (wave.Error, ZeroDivisionError):
        duration = 0
    return {"audioPath": str(output), "filename": output.name, "duration": duration, "warnings": pronunciation_warnings}

@app.post("/align")
async def align_audio(file: UploadFile = File(...), text: str = Form(...), language: str = Form("zh")):
    global _ALIGN_MODELS
    if language not in {"zh", "en"}: raise HTTPException(400, "目前只支持中文和英文字幕对齐")
    if not text.strip(): raise HTTPException(400, "对齐文本不能为空")
    try:
        import torch
        import torchaudio
        from transformers import AutoModelForCTC, AutoProcessor
    except ImportError as exc:
        raise HTTPException(503, "未安装本地字幕对齐依赖，请运行 uv sync --extra tts") from exc
    model_id = "jonatasgrosman/wav2vec2-large-xlsr-53-chinese-zh-cn" if language == "zh" else "facebook/wav2vec2-base-960h"
    suffix = Path(file.filename or "voice.wav").suffix or ".wav"
    with tempfile.NamedTemporaryFile(dir=AUDIO_DIR, suffix=suffix, delete=False) as handle:
        handle.write(await file.read()); audio_path = Path(handle.name)
    try:
        async with _ALIGN_LOCK:
            if model_id not in _ALIGN_MODELS:
                processor = AutoProcessor.from_pretrained(model_id)
                model = AutoModelForCTC.from_pretrained(model_id).to("cpu").eval()
                _ALIGN_MODELS[model_id] = (processor, model)
            processor, model = _ALIGN_MODELS[model_id]
            waveform, sample_rate = torchaudio.load(str(audio_path))
            waveform = waveform.mean(dim=0)
            if sample_rate != 16_000: waveform = torchaudio.functional.resample(waveform, sample_rate, 16_000)
            clean_text = re.sub(r"[^\w\s\u3400-\u9fff']", " ", text).strip()
            # The English CTC vocabulary contains uppercase letters only.
            # Lowercase targets otherwise become <unk> despite valid audio.
            if language == "en": clean_text = clean_text.upper()
            clean_text = ' '.join(clean_text.split())
            target_ids = processor.tokenizer(clean_text, add_special_tokens=False, return_tensors="pt").input_ids
            if target_ids.numel() == 0: raise ValueError("旁白中没有可对齐的文字")
            if processor.tokenizer.unk_token_id in target_ids[0].tolist():
                raise ValueError("旁白包含对齐模型不支持的字符，请将数字或符号改为实际朗读文字")
            inputs = processor(waveform.numpy(), sampling_rate=16_000, return_tensors="pt", padding=True)
            with torch.inference_mode():
                logits = model(**inputs).logits[0]
                log_probs = torch.log_softmax(logits, dim=-1).unsqueeze(0)
            blank = processor.tokenizer.pad_token_id
            if blank is None: raise ValueError("对齐模型没有 CTC blank token")
            alignment, alignment_scores = torchaudio.functional.forced_align(log_probs, target_ids, blank=blank)
            token_ids = target_ids[0].tolist(); frame_ids = alignment[0].tolist()
            # Collapse complete CTC runs, retaining their full duration. Blank
            # frames separate repeated letters; they must not consume targets.
            spans = torchaudio.functional.merge_tokens(alignment[0], alignment_scores[0], blank=blank)
            if [span.token for span in spans] != token_ids: raise ValueError("语音与旁白文本不匹配，无法完整对齐")
            tokens = processor.tokenizer.convert_ids_to_tokens(token_ids)
            frame_duration = (len(waveform) / 16_000) / max(1, len(frame_ids))
            aligned_tokens = []
            for token, span in zip(tokens, spans):
                if token == processor.tokenizer.unk_token:
                    raise ValueError("模型无法识别旁白中的部分文字，已取消不准确的字幕对齐")
                if token == processor.tokenizer.word_delimiter_token:
                    label = "|"
                else:
                    label = token.strip()
                if label: aligned_tokens.append({"text": label, "start": span.start * frame_duration, "end": span.end * frame_duration})
            if language == "en":
                words = []; current = None
                for item in aligned_tokens:
                    if item["text"] == "|":
                        if current: words.append(current); current = None
                    else:
                        if current is None: current = {"text": item["text"], "start": item["start"], "end": item["end"]}
                        else: current["text"] += item["text"]; current["end"] = item["end"]
                if current: words.append(current)
                original_words = re.sub(r"[^\w\s']", " ", text).split()
                if len(original_words) != len(words): raise ValueError("对齐结果的词数与旁白不一致")
                for word, original in zip(words, original_words):
                    if word["text"].casefold() != original.casefold(): raise ValueError("对齐结果与旁白不一致")
                    word["text"] = original
            else: words = [item for item in aligned_tokens if item["text"] != "|"]
        if not words: raise ValueError("模型未能对齐任何词语")
        return {"words": words, "language": language}
    except Exception as exc:
        raise HTTPException(422, f"字幕强制对齐失败：{exc}") from exc
    finally:
        audio_path.unlink(missing_ok=True)
