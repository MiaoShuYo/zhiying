import io
import json
import sys
import types
import unittest
from unittest.mock import patch

from app.pronunciation import resolve, validate_rules, tokens, f5_pronunciation


class PronunciationTests(unittest.TestCase):
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
        self.assertEqual(warnings, [])

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
