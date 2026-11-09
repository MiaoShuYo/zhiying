import io
import json
import logging
import sys
import types
import unittest
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import nullcontext
from pathlib import Path
from urllib.error import HTTPError
from unittest.mock import patch

from app.pronunciation import (
    PronunciationBatchError, _build_prediction_prompt, _log_prediction_batch, _predict_pronunciation_batch,
    _prediction_schema, candidates, resolve, validate_rules, tokens, f5_pronunciation,
)
from app.local_llm_config import local_llm_config, local_llm_slot


class PronunciationTests(unittest.TestCase):
    def test_prompt_modes_keep_absolute_indices_and_only_send_one_context_strategy(self):
        text = '银行' + ('背景资料。' * 10) + '行数'
        first, second = text.index('行'), text.rindex('行')
        batch = [(first, candidates(text[first])), (second, candidates(text[second]))]

        legacy = _build_prediction_prompt(text, batch, 'legacy')
        full = _build_prediction_prompt(text, batch, 'full')
        local = _build_prediction_prompt(text, batch, 'local')
        marked = _build_prediction_prompt(text, batch, 'full', '0102')
        legacy_data = json.loads(legacy.split('\n')[-1])
        full_data = json.loads(full.split('\n')[-1])
        local_data = json.loads(local.split('\n')[-1])

        self.assertIn('narration', legacy_data)
        self.assertIn('context', legacy_data['positions'][0])
        self.assertEqual(full_data['narration'], text)
        self.assertNotIn('context', full_data['positions'][0])
        self.assertNotIn('narration', local_data)
        self.assertTrue(marked.startswith('基准标识：0102。'))
        self.assertEqual(json.loads(marked.split('\n')[-1])['positions'][0]['index'], str(first))
        self.assertEqual([item['index'] for item in local_data['positions']], [str(first), str(second)])
        self.assertEqual(len(local_data['contexts']), 2, 'distant target windows are not duplicated or joined')
        self.assertTrue(all('【行】' in item['text'] for item in local_data['contexts']))

        schema = _prediction_schema(batch)
        readings = schema['properties']['readings']
        self.assertEqual(readings['required'], [str(first), str(second)])
        self.assertFalse(readings['additionalProperties'])
        self.assertEqual(set(readings['properties']), {str(first), str(second)})

    def test_batch_parser_reads_stream_metrics_and_rejects_length_truncation(self):
        text, batch = '银行', [(1, candidates('行'))]
        answer = json.dumps({'readings': {'1': 'hang2'}}, ensure_ascii=False)
        raw = (
            json.dumps({'message': {'content': answer}, 'done': False}, ensure_ascii=False) + '\n' +
            json.dumps({'message': {'content': ''}, 'done': True, 'done_reason': 'stop', 'eval_count': 8,
                        'eval_duration': 800_000_000, 'prompt_eval_count': 70, 'prompt_eval_cached_count': 12,
                        'prompt_eval_duration': 90_000_000}) + '\n'
        ).encode()
        config = {'stream': True, 'keep_alive': '30m', 'num_ctx': 4096, 'max_concurrency': 1}
        with patch('app.pronunciation.local_llm_slot', return_value=nullcontext()), \
             patch('app.pronunciation.build_opener') as opener:
            opener.return_value.open.return_value = io.BytesIO(raw)
            selected, result = _predict_pronunciation_batch(text, batch, 'http://127.0.0.1:11434', 'local', config, 256, 'full')
            self.assertEqual(selected, {1: 'hang2'})
            self.assertEqual(result['metrics']['prompt_eval_count'], 70)
            self.assertEqual(result['metrics']['prompt_eval_cached_count'], 12)
            self.assertEqual(result['done_reason'], 'stop')
            self.assertGreaterEqual(result['wall_ms'], 0)
            handlers = opener.call_args.args
            self.assertEqual(handlers[0].proxies, {})
            from urllib.request import HTTPRedirectHandler
            self.assertTrue(any(isinstance(handler, HTTPRedirectHandler) for handler in handlers[1:]))

        truncated = json.dumps({'message': {'content': answer}, 'done_reason': 'length', 'eval_count': 256}).encode()
        with patch('app.pronunciation.local_llm_slot', return_value=nullcontext()), \
             patch('app.pronunciation.build_opener') as opener:
            opener.return_value.open.return_value = io.BytesIO(truncated)
            with self.assertRaises(PronunciationBatchError) as raised:
                _predict_pronunciation_batch(text, batch, 'http://127.0.0.1:11434', 'local', config, 256, 'full')
        self.assertEqual(raised.exception.done_reason, 'length')
        self.assertEqual(raised.exception.metrics['eval_count'], 256)

    def test_ollama_http_error_status_is_available_for_batch_fallback(self):
        config = {'stream': True, 'keep_alive': '30m', 'num_ctx': 4096, 'max_concurrency': 1}
        error = HTTPError('http://127.0.0.1:11434/api/chat', 400, 'invalid request', {}, io.BytesIO(b'{"error":"test"}'))
        with patch('app.pronunciation.local_llm_slot', return_value=nullcontext()), \
             patch('app.pronunciation.build_opener') as opener:
            opener.return_value.open.side_effect = error
            with self.assertRaises(PronunciationBatchError) as raised:
                _predict_pronunciation_batch('银行', [(1, candidates('行'))], 'http://127.0.0.1:11434', 'local', config, 384, 'legacy')
        self.assertEqual(raised.exception.http_status, 400)
        self.assertIn('HTTP 400', str(raised.exception))

    def test_prediction_metrics_log_batch_timing_and_fallback_without_text(self):
        with self.assertLogs('test.pronunciation.metrics', level='INFO') as captured:
            _log_prediction_batch(
                logging.getLogger('test.pronunciation.metrics'), batch_index=1, batch_count=2,
                batch_size=32, prompt_mode='legacy', status='fallback', wall_ms=1200,
                metrics={'total_duration': 1_100_000_000, 'load_duration': 50_000_000,
                         'prompt_eval_count': 100, 'prompt_eval_cached_count': 5,
                         'prompt_eval_duration': 200_000_000, 'eval_count': 20, 'eval_duration': 500_000_000},
                done_reason='length', fallback_count=32,
            )
        line = captured.output[0]
        self.assertIn('batch_size=32', line)
        self.assertIn('wall_ms=1200.0', line)
        self.assertIn('ollama_total_ms=1100.0', line)
        self.assertIn('load_ms=50.0', line)
        self.assertIn('prompt_tokens=100', line)
        self.assertIn('fallback_count=32', line)

    def test_failed_batch_falls_back_and_later_batches_continue(self):
        text = '、'.join(['行'] * 65)
        requests = []

        def request(req, timeout):
            requests.append(req)
            if len(requests) == 1:
                raise TimeoutError('offline')
            prompt = json.loads(req.data)['messages'][0]['content']
            payload = json.loads(prompt.split('\n')[-1])
            readings = {position['index']: 'hang2' for position in payload['positions']}
            return io.BytesIO(json.dumps({'message': {'content': json.dumps({'readings': readings})}, 'done_reason': 'stop'}).encode())

        with patch('app.pronunciation.local_llm_slot', return_value=nullcontext()), \
             patch('app.pronunciation.build_opener') as opener, \
             self.assertLogs('app.pronunciation', level='INFO') as logs:
            opener.return_value.open.side_effect = request
            readings, warnings = resolve(
                text, [], 'http://127.0.0.1:11434', 'local',
                {'prediction_batch_size': 32, 'prediction_num_predict': 512, 'prediction_prompt_mode': 'full'},
            )

        positions = [index for index, char in enumerate(text) if char == '行']
        self.assertEqual(len(requests), 3)
        self.assertEqual(readings[positions[0]], 'xing2', 'failed batch keeps the dictionary reading')
        self.assertTrue(all(readings[index] == 'hang2' for index in positions[32:]))
        self.assertEqual(len(warnings), 1)
        self.assertTrue(any('batch_size=32' in line and 'fallback_count=32' in line for line in logs.output))
        self.assertTrue(any('status=ok' in line and 'fallback_count=0' in line for line in logs.output))
        self.assertFalse(any(text in line for line in logs.output), 'logs never include the narration text')

    def test_dictionary_phrases_survive_incorrect_model_predictions(self):
        text = '让模型多写几行代码。银行行长在银行行走，行动要看行程。'
        def request(request, timeout):
            payload = json.loads(request.data)
            positions = json.loads(payload['messages'][0]['content'].split('\n', 1)[1])['positions']
            predictions = {p['index']: ('hang2' if p['char'] == '行' else p['candidates'][0]) for p in positions}
            return io.StringIO(json.dumps({'message': {'content': json.dumps({'readings': predictions})}}))
        with patch('app.pronunciation.build_opener') as opener:
            opener.return_value.open.side_effect = request
            readings, warnings = resolve(text, [], 'http://127.0.0.1:11434', 'local')
        self.assertEqual(readings[text.index('行走')], 'xing2')
        self.assertEqual(readings[text.index('行动')], 'xing2')
        self.assertEqual(readings[text.index('行程')], 'xing2')
        self.assertEqual(readings[text.index('几行') + 1], 'hang2')
        self.assertEqual(warnings, [])

    def test_scope_and_occurrence_priority(self):
        text = '行行'
        scopes = [
            [{'text': '行', 'pinyin': ['xing2']}],
            [{'text': '行', 'pinyin': ['hang2']}],
            [{'text': '行', 'pinyin': ['xing2'], 'occurrence': 2}],
        ]
        readings, warnings = resolve(text, scopes, 'http://127.0.0.1:11434', 'local')
        self.assertEqual(readings, ['hang2', 'xing2'])
        self.assertEqual(warnings, [])

    def test_contextual_readings_are_stable_and_allow_manual_overrides(self):
        text = '加载模型时，长序列会提高数据量。多卡互联能分担计算量。'
        def predict(_text, batch, *_args):
            return ({position: sounds[0] for position, sounds in batch},
                    {'wall_ms': 0, 'metrics': {}, 'done_reason': 'stop'})
        with patch('app.pronunciation._predict_pronunciation_batch', side_effect=predict) as model:
            readings, warnings = resolve(text, [])
        expected = {'载': 'zai4', '长': 'chang2', '卡': 'ka3'}
        for char, reading in expected.items():
            self.assertEqual(readings[text.index(char)], reading)
        for phrase in ('数据量', '计算量'):
            self.assertEqual(readings[text.index(phrase) + 2], 'liang4')
        for call in model.call_args_list:
            self.assertFalse(any(text[position] in expected for position, _ in call.args[1]))
        self.assertEqual(warnings, [])
        with patch('app.pronunciation._predict_pronunciation_batch', side_effect=predict):
            overridden, _ = resolve(text, [[{'text': '长', 'pinyin': ['zhang3'], 'occurrence': 1}]])
        self.assertEqual(overridden[text.index('长')], 'zhang3')
        self.assertIn('chang2', tokens(text, readings, None))

    def test_stale_and_invalid_annotations_fail(self):
        with self.assertRaises(ValueError):
            validate_rules([{'text': '行', 'pinyin': ['ma3']}])
        with self.assertRaises(ValueError):
            resolve('行', [[{'text': '行', 'pinyin': ['hang2'], 'occurrence': 2}]], '', '')

    def test_model_selects_from_candidates_with_full_context(self):
        payloads = []
        def request(request, timeout):
            payload = json.loads(request.data)
            payloads.append(payload)
            content = payload['messages'][0]['content']
            self.assertIn('银行发行股票，代码有几行', content)
            context = json.loads(content.split('\n', 1)[1])
            predictions = {p['index']: (('hang2' if int(p['index']) in (1, 11) else 'xing2') if p['char'] == '行' else p['candidates'][0]) for p in context['positions']}
            return io.StringIO(json.dumps({'message': {'content': json.dumps({'readings': predictions})}}))
        with patch('app.pronunciation.build_opener') as opener:
            opener.return_value.open.side_effect = request
            readings, warnings = resolve('银行发行股票，代码有几行', [], 'http://127.0.0.1:11434', 'local')
        self.assertEqual(readings[1], 'hang2')
        self.assertEqual(readings[3], 'xing2')
        self.assertEqual(readings[11], 'hang2')
        self.assertTrue(payloads)
        self.assertEqual(payloads[0]['stream'], True)
        self.assertEqual(payloads[0]['keep_alive'], '30m')
        self.assertEqual(payloads[0]['options']['num_ctx'], 4096)
        self.assertEqual(payloads[0]['options']['num_predict'], 384)
        self.assertEqual(warnings, [])

    def test_runtime_settings_use_bounded_fallbacks(self):
        with patch.dict('os.environ', {'OLLAMA_NUM_CTX': '999999', 'OLLAMA_KEEP_ALIVE': 'forever', 'OLLAMA_STREAM': 'bad', 'LLM_MAX_CONCURRENCY': '0'}):
            config = local_llm_config()
        self.assertEqual(config['num_ctx'], 4096)
        self.assertEqual(config['keep_alive'], '30m')
        self.assertTrue(config['stream'])
        self.assertEqual(config['max_concurrency'], 1)
        self.assertEqual(len(config['warnings']), 4)

    def test_generation_slot_serializes_threads(self):
        data_dir = Path(__file__).resolve().parents[3] / 'data'
        with tempfile.TemporaryDirectory(prefix='m2v-ollama-slots-', dir=data_dir) as lock_dir:
            config = local_llm_config()
            config.update(lock_dir=Path(lock_dir), max_concurrency=1)
            guard = threading.Lock()
            active = [0]
            peak = [0]
            def work():
                with local_llm_slot(config):
                    with guard:
                        active[0] += 1
                        peak[0] = max(peak[0], active[0])
                    time.sleep(.02)
                    with guard:
                        active[0] -= 1
            with ThreadPoolExecutor(max_workers=4) as pool:
                list(pool.map(lambda _: work(), range(4)))
            self.assertEqual(peak[0], 1)

    def test_model_failure_is_visible_and_manual_override_survives(self):
        with patch('app.pronunciation.build_opener', side_effect=TimeoutError):
            readings, warnings = resolve('行重', [[{'text': '行', 'pinyin': ['hang2']}]], 'http://127.0.0.1:11434', 'local')
        self.assertEqual(readings[0], 'hang2')
        self.assertTrue(warnings)

    def test_invalid_model_output_cannot_override_readings(self):
        body = json.dumps({'message': {'content': '{"readings":{"0":"not-a-reading"}}'}})
        with patch('app.pronunciation.build_opener') as opener:
            opener.return_value.open.return_value = io.StringIO(body)
            readings, warnings = resolve('行', [], 'http://127.0.0.1:11434', 'local')
        self.assertNotIn('not-a-reading', readings)
        self.assertTrue(warnings)

    def test_remote_model_is_never_contacted(self):
        with patch('app.pronunciation.build_opener') as opener:
            _, warnings = resolve('行', [], 'https://example.com', 'remote')
            opener.assert_not_called()
        self.assertTrue(warnings)

    def test_f5_boundary_and_restoration(self):
        module = types.ModuleType('f5_tts.infer.utils_infer')
        original = lambda texts, **kw: [list(text) for text in texts]
        module.convert_char_to_pinyin = original
        def batch(audio, ref, chunks, *args, **kwargs):
            return module.convert_char_to_pinyin([ref + chunk for chunk in chunks])
        module.infer_batch_process = batch
        packages = {'f5_tts': types.ModuleType('f5_tts'), 'f5_tts.infer': types.ModuleType('f5_tts.infer'), 'f5_tts.infer.utils_infer': module}
        packages['f5_tts'].infer = packages['f5_tts.infer']
        packages['f5_tts.infer'].utils_infer = module
        with patch.dict(sys.modules, packages):
            with f5_pronunciation('几行代码。执行代码。', ['ji3', 'hang2', 'dai4', 'ma3', '。', 'zhi2', 'xing2', 'dai4', 'ma3', '。']):
                values = module.infer_batch_process(None, '参考。', ['几行代码。 ', '执行代码。'])
                self.assertIn('hang2', values[0])
                self.assertIn('xing2', values[1])
                self.assertEqual(values[0][:3], list('参考。'))
            self.assertIs(module.convert_char_to_pinyin, original)
            self.assertIs(module.infer_batch_process, batch)
            with self.assertRaises(RuntimeError):
                with f5_pronunciation('行', ['hang2']):
                    raise RuntimeError('inference failed')
            self.assertIs(module.convert_char_to_pinyin, original)

    def test_non_chinese_and_neutral_tone(self):
        result = tokens('AI的。', ['A', 'I', 'de5', '。'], lambda texts: [list(text) for text in texts])
        self.assertEqual(result, ['A', 'I', ' ', 'de', '。'])


if __name__ == '__main__':
    unittest.main()
