"""Reproducible local Ollama benchmark for pronunciation prediction profiles.

Run from services/python with:
    uv run --no-sync python benchmark_pronunciation.py

The benchmark emits measurement data only; it never logs or writes the narration.
"""
from __future__ import annotations

import json
import argparse
import os
import platform
import statistics
import subprocess
import time
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
from urllib.request import urlopen

from app.local_llm_config import local_llm_config
from app.pronunciation import (
    PronunciationBatchError,
    _predict_pronunciation_batch,
    candidates,
)


# Each case is (sentence, target phrase, target offset in phrase, expected pinyin).
CASES = [
    ('银行客户正在柜台办理业务。', '银行', 1, 'hang2'),
    ('银行的行长介绍了新的服务。', '行长', 0, 'hang2'),
    ('请按照行动计划逐项落实。', '行动', 0, 'xing2'),
    ('请检查表格的行数是否正确。', '行数', 0, 'hang2'),
    ('沿着安全通道行走。', '行走', 0, 'xing2'),
    ('今天重新启动服务。', '重新', 0, 'chong2'),
    ('这项安排非常重要。', '重要', 0, 'zhong4'),
    ('相同的内容不要重复录入。', '重复', 0, 'chong2'),
    ('称量时请记录物体重量。', '重量', 0, 'zhong4'),
    ('孩子正在健康长大。', '长大', 0, 'zhang3'),
    ('请准确测量线段长度。', '长度', 0, 'chang2'),
    ('沿着长江继续行驶。', '长江', 0, 'chang2'),
    ('请及时归还资料。', '归还', 1, 'huan2'),
    ('会议结束后还有一个问题。', '还有', 0, 'hai2'),
    ('祝大家节日快乐。', '快乐', 1, 'le4'),
    ('背景音乐已经停止。', '音乐', 1, 'yue4'),
    ('请核对本次订单数量。', '数量', 0, 'shu4'),
    ('老师带着孩子数数。', '数数', 0, 'shu3'),
    ('数学课程今天开始。', '数学', 0, 'shu4'),
    ('完成检查后再处理问题。', '处理', 0, 'chu3'),
    ('附近到处都设置了标志。', '到处', 1, 'chu4'),
    ('这次旅行将前往西藏。', '西藏', 1, 'zang4'),
    ('收藏所有重要文件。', '收藏', 1, 'cang2'),
    ('团队决定调动现有资源。', '调动', 0, 'diao4'),
    ('需要调整工作顺序。', '调整', 0, 'tiao2'),
    ('请打开空调，保持空气流通。', '空调', 1, 'tiao2'),
    ('下周他要去北京出差。', '出差', 1, 'chai1'),
    ('这个任务差不多完成。', '差不多', 0, 'cha4'),
    ('山坡上树木参差不齐。', '参差', 1, 'ci1'),
    ('这段传说流传了很久。', '传说', 0, 'chuan2'),
    ('她正在整理自己的自传。', '自传', 1, 'zhuan4'),
    ('信息必须准确传递。', '传递', 0, 'chuan2'),
]


def build_workload() -> tuple[str, list[tuple[int, list[str]]], dict[int, str]]:
    fragments: list[str] = []
    expected: dict[int, str] = {}
    offset = 0
    # Two passes produce 64 labeled targets, exercising the largest tested batch.
    for pass_index in range(2):
        for case_index, (sentence, phrase, phrase_offset, sound) in enumerate(CASES, start=1):
            prefix = f'复测第{pass_index + 1}轮第{case_index}条：'
            fragments.append(prefix + sentence + '\n')
            phrase_start = sentence.index(phrase)
            target = offset + len(prefix) + phrase_start + phrase_offset
            char = (prefix + sentence)[len(prefix) + phrase_start + phrase_offset]
            if sound not in candidates(char):
                raise ValueError(f'基准语料的预期读音不在候选列表中：case={case_index}')
            expected[target] = sound
            offset += len(prefix + sentence + '\n')
    text = ''.join(fragments)
    positions = [(index, candidates(text[index])) for index in expected]
    if len(positions) != 64:
        raise AssertionError(f'预期 64 个测试位置，实际为 {len(positions)}')
    return text, positions, expected


def run_profile(text: str, positions: list[tuple[int, list[str]]], expected: dict[int, str],
                config: dict, *, batch_size: int, num_predict: int, prompt_mode: str, prompt_marker: str) -> dict:
    base, model = config['base_url'], config['model']
    predictions: dict[int, str] = {}
    batches = [positions[offset:offset + batch_size] for offset in range(0, len(positions), batch_size)]
    measurement = {
        'batch_size': batch_size, 'num_predict': num_predict, 'prompt_mode': prompt_mode,
        'requests': len(batches), 'successful_requests': 0, 'failures': 0, 'fallback_positions': 0,
        'done_reason_length': 0, 'wall_ms': 0.0, 'max_request_wall_ms': 0.0,
        'prompt_eval_count': 0, 'prompt_eval_cached_count': 0, 'prompt_eval_duration': 0,
        'eval_count': 0, 'eval_duration': 0, 'load_duration': 0,
        'http_status_codes': [],
    }
    run_started = time.perf_counter()
    for batch_index, batch in enumerate(batches, start=1):
        try:
            batch_marker = f'{prompt_marker}-batch-{batch_index}' if prompt_marker else None
            selected, result = _predict_pronunciation_batch(text, batch, base, model, config, num_predict, prompt_mode, batch_marker)
            predictions.update(selected)
            measurement['successful_requests'] += 1
            measurement['wall_ms'] += result['wall_ms']
            measurement['max_request_wall_ms'] = max(measurement['max_request_wall_ms'], result['wall_ms'])
            for metric in ('prompt_eval_count', 'prompt_eval_cached_count', 'prompt_eval_duration', 'eval_count', 'eval_duration', 'load_duration'):
                measurement[metric] += result['metrics'].get(metric, 0)
            if result['done_reason'] == 'length':
                measurement['done_reason_length'] += 1
        except PronunciationBatchError as exc:
            measurement['failures'] += 1
            measurement['fallback_positions'] += len(batch)
            measurement['wall_ms'] += exc.wall_ms
            measurement['max_request_wall_ms'] = max(measurement['max_request_wall_ms'], exc.wall_ms)
            measurement['done_reason_length'] += exc.done_reason == 'length'
            if exc.http_status is not None:
                measurement['http_status_codes'].append(exc.http_status)
            for metric in ('prompt_eval_count', 'prompt_eval_cached_count', 'prompt_eval_duration', 'eval_count', 'eval_duration', 'load_duration'):
                measurement[metric] += exc.metrics.get(metric, 0)
            # Keep the reason, never the model input or response body.
            measurement.setdefault('error_kinds', []).append(type(exc.__cause__ or exc).__name__)
    measurement['wall_ms'] = max(measurement['wall_ms'], (time.perf_counter() - run_started) * 1000)
    measurement['correct'] = sum(predictions.get(index) == sound for index, sound in expected.items())
    measurement['targets'] = len(expected)
    measurement['accuracy'] = measurement['correct'] / len(expected) if expected else 1.0
    measurement['complete'] = measurement['failures'] == 0 and len(predictions) == len(expected)
    return measurement


def profile_summary(rows: list[dict]) -> dict:
    return {
        'runs': len(rows),
        'complete_runs': sum(row['complete'] for row in rows),
        'mean_accuracy': statistics.mean(row['accuracy'] for row in rows),
        'median_wall_ms': statistics.median(row['wall_ms'] for row in rows),
        'mean_wall_ms': statistics.mean(row['wall_ms'] for row in rows),
        'mean_requests': statistics.mean(row['requests'] for row in rows),
        'mean_prompt_eval_count': statistics.mean(row['prompt_eval_count'] for row in rows),
        'mean_prompt_eval_cached_count': statistics.mean(row['prompt_eval_cached_count'] for row in rows),
        'mean_eval_count': statistics.mean(row['eval_count'] for row in rows),
        'mean_fallback_positions': statistics.mean(row['fallback_positions'] for row in rows),
        'done_reason_length': sum(row['done_reason_length'] for row in rows),
    }


def run_comparison_profile(model: str, output_path: str, trials: int = 3) -> dict:
    """Compare a selected production pronunciation profile without tuning profiles."""
    config = local_llm_config()
    config['model'] = model
    text, positions, expected = build_workload()
    try:
        subprocess.run(['ollama', 'stop', model], capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=30, check=False)
    except (OSError, subprocess.TimeoutExpired):
        pass

    rows: list[dict] = []
    for phase, trial in [('cold', 0), *(('warm', index) for index in range(1, trials + 1))]:
        marker = f'{phase}-{trial}-{time.time_ns()}'
        row = run_profile(text, positions, expected, config, batch_size=32, num_predict=384,
                          prompt_mode='legacy', prompt_marker=marker)
        row.update(phase=phase, trial=trial, model=model, profile='legacy-batch-32-cap-384')
        rows.append(row)
        print(json.dumps({'phase': phase, 'trial': trial, **row}, ensure_ascii=False), flush=True)

    digest = None
    try:
        with urlopen(config['base_url'] + '/api/tags', timeout=5) as response:
            tags = json.loads(response.read())
        digest = next((item.get('digest') for item in tags.get('models', []) if item.get('name') == model), None)
    except Exception:
        pass
    warm = [row for row in rows if row['phase'] == 'warm']
    output = {
        'metadata': {
            'date_local': datetime.now(ZoneInfo('Asia/Shanghai')).isoformat(),
            'date_utc': datetime.now(timezone.utc).isoformat(), 'model': model, 'digest': digest,
            'ollama_base_url': config['base_url'], 'stream': config['stream'], 'keep_alive': config['keep_alive'],
            'num_ctx': config['num_ctx'], 'cpu': platform.processor(), 'logical_cpu_count': os.cpu_count(),
            'profile': 'legacy-batch-32-cap-384', 'target_count': len(positions), 'trial_count': trials,
            'cold_run_unloaded_before_request': True, 'prompt_cache_busted_per_request': True,
        },
        'summary': {
            'cold_wall_ms': rows[0]['wall_ms'] if rows else None,
            'warm_median_wall_ms': statistics.median(row['wall_ms'] for row in warm) if warm else None,
            'warm_p95_wall_ms': sorted((row['wall_ms'] for row in warm))[max(0, int(len(warm) * .95 + .999999) - 1)] if warm else None,
            'warm_mean_accuracy': statistics.mean(row['accuracy'] for row in warm) if warm else None,
            'warm_complete_runs': sum(bool(row['complete']) for row in warm),
            'warm_mean_fallback_positions': statistics.mean(row['fallback_positions'] for row in warm) if warm else None,
            'warm_mean_prompt_eval_count': statistics.mean(row['prompt_eval_count'] for row in warm) if warm else None,
            'warm_mean_eval_count': statistics.mean(row['eval_count'] for row in warm) if warm else None,
        },
        'runs': rows,
    }
    with open(output_path, 'w', encoding='utf-8') as output_file:
        json.dump(output, output_file, ensure_ascii=False, indent=2)
        output_file.write('\n')
    print(json.dumps({'event': 'comparison-profile-complete', 'output': output_path, 'metadata': output['metadata'], 'summary': output['summary']}, ensure_ascii=False), flush=True)
    return output


def main() -> None:
    parser = argparse.ArgumentParser(description='Reproducible local Ollama pronunciation benchmark')
    parser.add_argument('--comparison-profile', action='store_true', help='Run the production batch-32/cap-384 A/B profile only')
    parser.add_argument('--model', help='Override OLLAMA_MODEL for this benchmark run')
    parser.add_argument('--output', default='tests/qwen-pronunciation-comparison.json', help='Output JSON path for comparison profile')
    parser.add_argument('--trials', type=int, default=3, help='Warm repetitions for comparison profile')
    args = parser.parse_args()
    config = local_llm_config()
    if args.model:
        config['model'] = args.model
    if args.comparison_profile:
        if args.trials < 1:
            parser.error('--trials must be at least 1')
        run_comparison_profile(config['model'], args.output, args.trials)
        return
    for warning in config['warnings']:
        print(json.dumps({'warning': warning}, ensure_ascii=False))
    text, positions, expected = build_workload()
    # Warm the configured model before any measurements; this request is excluded.
    _predict_pronunciation_batch(text, positions[:2], config['base_url'], config['model'], config, 64, 'full', 'warmup-0000')

    profiles = [
        {'name': f'{mode}-batch-{batch_size}-cap-512', 'batch_size': batch_size, 'num_predict': 512, 'prompt_mode': mode}
        for mode in ('legacy', 'full', 'local') for batch_size in (32, 40, 64)
    ]
    raw_rows: list[dict] = []
    baseline_rows = []
    for trial in range(1, 4):
        marker = f'{trial:02d}00'
        row = run_profile(text, positions, expected, config, batch_size=40, num_predict=2048,
                          prompt_mode='legacy', prompt_marker=marker)
        row.update(name='baseline-legacy-batch-40-cap-2048', trial=trial, cache_marker_id=marker)
        baseline_rows.append(row)
        raw_rows.append(row)
        print(json.dumps({'phase': 'baseline', **row}, ensure_ascii=False), flush=True)
    baseline = profile_summary(baseline_rows)

    # A single measured preflight rejects profiles that already fail the quality or completeness gate.
    # Only profiles that can be selected receive the remaining repetitions.
    preflight_rows: dict[str, list[dict]] = {profile['name']: [] for profile in profiles}
    for profile_index, profile in enumerate(profiles, start=1):
        marker = f'01{profile_index:02d}'
        row = run_profile(
            text, positions, expected, config,
            **{key: profile[key] for key in ('batch_size', 'num_predict', 'prompt_mode')}, prompt_marker=marker,
        )
        row.update(name=profile['name'], trial=1, cache_marker_id=marker)
        preflight_rows[profile['name']].append(row)
        raw_rows.append(row)
        print(json.dumps({'phase': 'profile-preflight', **row}, ensure_ascii=False), flush=True)

    eligible = [profile for profile in profiles if
                preflight_rows[profile['name']][0]['complete'] and
                preflight_rows[profile['name']][0]['accuracy'] >= baseline['mean_accuracy']]
    grouped: dict[str, list[dict]] = {name: rows[:] for name, rows in preflight_rows.items()}
    for profile_index, profile in enumerate(eligible, start=1):
        for trial in (2, 3):
            marker = f'{trial:02d}{profile_index:02d}'
            row = run_profile(
                text, positions, expected, config,
                **{key: profile[key] for key in ('batch_size', 'num_predict', 'prompt_mode')}, prompt_marker=marker,
            )
            row.update(name=profile['name'], trial=trial, cache_marker_id=marker)
            grouped[profile['name']].append(row)
            raw_rows.append(row)
            print(json.dumps({'phase': 'profile-repeat', **row}, ensure_ascii=False), flush=True)

    eligible_summaries = []
    for profile in profiles:
        rows = grouped[profile['name']]
        summary = profile_summary(rows)
        if len(rows) == 3 and summary['complete_runs'] == 3 and summary['mean_accuracy'] >= baseline['mean_accuracy']:
            eligible_summaries.append((profile, summary))
    selected = None
    if eligible_summaries:
        fastest = min(summary['median_wall_ms'] for _, summary in eligible_summaries)
        near_fastest = [(profile, summary) for profile, summary in eligible_summaries if summary['median_wall_ms'] <= fastest * 1.05]
        selected, selected_summary = min(
            near_fastest,
            key=lambda pair: (pair[1]['mean_prompt_eval_count'], -pair[0]['batch_size']),
        )
    else:
        selected_summary = None

    cap_rows: list[dict] = []
    selected_cap = None
    if selected:
        for cap_index, cap in enumerate((256, 384), start=1):
            cap_group = []
            for trial in range(1, 4):
                marker = f'{trial:02d}{20 + cap_index:02d}'
                row = run_profile(
                    text, positions, expected, config, batch_size=selected['batch_size'], num_predict=cap,
                    prompt_mode=selected['prompt_mode'], prompt_marker=marker,
                )
                row.update(name=f'cap-{cap}', trial=trial, cache_marker_id=marker)
                cap_rows.append(row)
                cap_group.append(row)
                print(json.dumps({'phase': 'output-cap', **row}, ensure_ascii=False), flush=True)
            summary = profile_summary(cap_group)
            if summary['complete_runs'] == 3 and summary['mean_accuracy'] >= baseline['mean_accuracy']:
                selected_cap = cap
                break
        if selected_cap is None:
            selected_cap = 512

    output = {
        'metadata': {
            'date_local': datetime.now(ZoneInfo('Asia/Shanghai')).isoformat(),
            'date_utc': datetime.now(timezone.utc).isoformat(), 'model': config['model'],
            'base_url': config['base_url'], 'stream': config['stream'], 'keep_alive': config['keep_alive'],
            'num_ctx': config['num_ctx'], 'cpu': platform.processor(), 'logical_cpu_count': os.cpu_count(),
            'target_count': len(positions), 'case_count': len(CASES), 'passes': 2,
            'trials_per_eligible_profile': 3, 'cache_busted_per_profile_trial': True,
        },
        'baseline': baseline,
        'preflight_profiles': {name: profile_summary(rows) for name, rows in preflight_rows.items()},
        'eligible_profile_summaries': {profile['name']: summary for profile, summary in eligible_summaries},
        'selected_context_batch_profile': selected,
        'selected_context_batch_summary': selected_summary,
        'selected_num_predict': selected_cap,
        'raw_runs': raw_rows,
        'cap_runs': cap_rows,
    }
    print(json.dumps({'final_summary': output}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
