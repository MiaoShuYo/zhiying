"""Shared Ollama runtime settings and cross-process generation slots."""
from __future__ import annotations

import json
import logging
import os
import re
import time
import uuid
from contextlib import contextmanager
from pathlib import Path


def _integer(name: str, default: int, minimum: int, maximum: int, warnings: list[str]) -> int:
    raw = os.environ.get(name)
    if not raw:
        return default
    try:
        value = int(raw)
        if minimum <= value <= maximum:
            return value
    except ValueError:
        pass
    warnings.append(f'{name} 必须是 {minimum}–{maximum} 的整数，当前使用默认值 {default}')
    return default


def local_llm_config() -> dict:
    warnings: list[str] = []
    base_url = os.environ.get('OLLAMA_BASE_URL', 'http://127.0.0.1:11434').strip() or 'http://127.0.0.1:11434'
    model = os.environ.get('OLLAMA_MODEL', 'qwen3:4b').strip() or 'qwen3:4b'
    raw_keep_alive = os.environ.get('OLLAMA_KEEP_ALIVE', '30m').strip()
    duration = re.fullmatch(r'(\d+)(ms|s|m|h)', raw_keep_alive, re.I)
    maximum = {'ms': 86_400_000, 's': 86_400, 'm': 1_440, 'h': 24}.get(duration.group(2).lower(), 0) if duration else 0
    keep_alive = raw_keep_alive if raw_keep_alive == '0' or (duration and int(duration.group(1)) <= maximum) else '30m'
    if keep_alive != raw_keep_alive:
        warnings.append('OLLAMA_KEEP_ALIVE 格式无效，支持 0 或不超过 24 小时的时长；当前使用默认值 30m')
    raw_stream = os.environ.get('OLLAMA_STREAM', 'true').strip().lower()
    if raw_stream in {'true', '1', 'yes'}:
        stream = True
    elif raw_stream in {'false', '0', 'no'}:
        stream = False
    else:
        stream = True
        warnings.append('OLLAMA_STREAM 必须是 true 或 false，当前使用默认值 true')
    root = Path(__file__).resolve().parents[3]
    lock_dir = Path(os.environ.get('OLLAMA_LOCK_DIR') or root / 'data' / 'ollama-locks').resolve()
    return {
        'base_url': base_url.rstrip('/'), 'model': model, 'keep_alive': keep_alive,
        'num_ctx': _integer('OLLAMA_NUM_CTX', 4096, 512, 32768, warnings),
        'stream': stream, 'max_concurrency': _integer('LLM_MAX_CONCURRENCY', 1, 1, 4, warnings),
        'lock_dir': lock_dir, 'warnings': warnings,
    }


def _pid_alive(pid: object) -> bool:
    if type(pid) is not int or pid < 1:
        return False
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except OSError:
        return False


@contextmanager
def local_llm_slot(config: dict | None = None):
    config = config or local_llm_config()
    directory: Path = config['lock_dir']
    directory.mkdir(parents=True, exist_ok=True)
    token = str(uuid.uuid4())
    lock_path: Path | None = None
    while lock_path is None:
        for slot in range(config['max_concurrency']):
            candidate = directory / f'slot-{slot}.lock'
            try:
                descriptor = os.open(candidate, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
                    json.dump({'token': token, 'pid': os.getpid(), 'createdAt': time.time() * 1000}, stream)
                lock_path = candidate
                break
            except FileExistsError:
                try:
                    owner = json.loads(candidate.read_text(encoding='utf-8'))
                    age = time.time() * 1000 - owner.get('createdAt', 0)
                    if age > 5000 and not _pid_alive(owner.get('pid')):
                        candidate.unlink(missing_ok=True)
                except (OSError, ValueError, TypeError):
                    try:
                        if time.time() - candidate.stat().st_mtime > 5:
                            candidate.unlink(missing_ok=True)
                    except OSError:
                        pass
        if lock_path is None:
            time.sleep(0.1)
    try:
        yield
    finally:
        try:
            owner = json.loads(lock_path.read_text(encoding='utf-8'))
            if owner.get('token') == token:
                lock_path.unlink(missing_ok=True)
        except (OSError, ValueError):
            logging.getLogger(__name__).warning('Unable to release local Ollama generation slot')
