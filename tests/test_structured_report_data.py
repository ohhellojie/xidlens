"""Optional parsed blocks fail independently at the saved-report read boundary."""
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'app'))
import parser
from report_data import normalize_report
from sessions import combine
from test_structured_events import dcgm, goe_document


def parsed(text, name='synthetic.log'):
    return parser.convert(parser.Parser(name).parse(io.BytesIO(text.encode())))


class OptionalReportDataTests(unittest.TestCase):
    def setUp(self):
        self.report = parsed('[1.000] NVRM: Xid (PCI:0000:41:00): 79, synthetic fault\n'
                             '[2.000] NVRM: loading NVIDIA UNIX Kernel Module for x86_64 580.0\n')
        self.dcgm = parsed(json.dumps(dcgm()), 'synthetic-dcgm.json')['structured']

    def degraded(self, value, key):
        output = normalize_report(copy.deepcopy(value))
        self.assertNotIn(key, output)
        self.assertFalse(output['complete'])
        self.assertTrue(output['warnings'])
        self.assertEqual(value['events'], output['events'])
        self.assertEqual(value['gpus'], output['gpus'])
        return output

    def test_missing_optional_blocks_are_supported(self):
        self.report.pop('lifecycleEvents', None)
        self.report.pop('structured', None)
        output = normalize_report(copy.deepcopy(self.report))
        self.assertNotIn('lifecycleEvents', output)
        self.assertNotIn('structured', output)
        self.assertTrue(output['complete'])

    def test_lifecycle_block_wrong_types_are_isolated(self):
        for broken in (None, 'PRIVATE-CORRUPT-PAYLOAD', {}, [None], [1], [{}]):
            with self.subTest(value=broken):
                value = {**self.report, 'lifecycleEvents': broken, 'structured': self.dcgm}
                output = self.degraded(value, 'lifecycleEvents')
                self.assertEqual(output['structured'], self.dcgm)
                self.assertNotIn('PRIVATE-CORRUPT-PAYLOAD', ' '.join(output['warnings']))

    def test_nested_lifecycle_fields_are_checked(self):
        original = self.report['lifecycleEvents'][0]
        for field, broken in (('timeInfo', []), ('timeInfo', {'raw': 7}), ('association', {'refs': [None]}),
                              ('timeInfo', {'raw': '13'}), ('timeInfo', {'kind': 'uptime_seconds'}),
                              ('association', {'refs': [{'evidence': {'line': '23'}}]}), ('line', True),
                              ('gpu', []), ('recoveryAction', {'current': []}), ('boot', {})):
            with self.subTest(field=field, broken=broken):
                value = {**self.report, 'lifecycleEvents': [{**original, field: broken}]}
                self.degraded(value, 'lifecycleEvents')

    def test_duplicate_lifecycle_ids_are_not_ambiguous_ui_targets(self):
        value = {**self.report, 'lifecycleEvents': self.report['lifecycleEvents'] * 2}
        self.degraded(value, 'lifecycleEvents')

    def test_structured_block_wrong_types_are_isolated(self):
        for broken in (None, [], 'PRIVATE-CORRUPT-PAYLOAD', {}, {'format': []}, {'format': 'dcgm-json', 'dcgm': None}):
            with self.subTest(value=broken):
                output = self.degraded({**self.report, 'structured': broken}, 'structured')
                self.assertEqual(output['lifecycleEvents'], self.report['lifecycleEvents'])
                self.assertNotIn('PRIVATE-CORRUPT-PAYLOAD', ' '.join(output['warnings']))

    def test_dcgm_consumed_shapes_are_checked(self):
        mutations = [lambda d: d.update(dcgm=[]), lambda d: d.update(warnings=[{}]),
            lambda d: d['dcgm'].update(results=None), lambda d: d['dcgm'].update(runs=[None]),
            lambda d: d['dcgm']['runs'][0].update(version={}),
            lambda d: d['dcgm']['results'][0].update(entity=[]),
            lambda d: d['dcgm']['results'][0].update(status=['Pass']),
            lambda d: d['dcgm']['results'][0].update(evidence={'line': '12'}),
            lambda d: d['dcgm']['results'][0].update(evidence={'jsonPointer': []}),
            lambda d: d['dcgm']['results'][0].update(run=True),
            lambda d: d['dcgm'].pop('summaries')]
        for change in mutations:
            value = copy.deepcopy(self.dcgm);change(value)
            with self.subTest(change=change): self.degraded({**self.report, 'structured': value}, 'structured')

    def test_unknown_fields_statuses_and_raw_payloads_are_preserved(self):
        structured = copy.deepcopy(self.dcgm)
        structured['extension'] = {'future': [1, True, None]}
        structured['rawDocument']['new-producer-field'] = {'nested': ['unrecognized']}
        row = structured['dcgm']['results'][0]
        row.update(status='future-status', statusRaw={'unknown': True}, warnings={'new': 'shape'},
                   raw={'new': {'payload': [1, None]}}, newField={'keep': True})
        structured['dcgm']['runs'][0]['runtimeError'] = {'futureError': ['one', 'two']}
        value = {**self.report, 'structured': structured}
        output = normalize_report(copy.deepcopy(value))
        self.assertEqual(output['structured'], structured)
        self.assertTrue(output['complete'])

    def test_goe_metadata_shape_preserves_full_64_bit_strings(self):
        value = parsed(json.dumps(goe_document()), 'synthetic-goe.json')
        output = normalize_report(copy.deepcopy(value))
        self.assertEqual(output['structured'], value['structured'])
        self.assertEqual(output['events'], value['events'])
        self.assertEqual('9007199254740993', output['structured']['events'][0]['traceId'])
        output['structured']['events'][0]['representations'] = [None]
        degraded = normalize_report(output)
        self.assertNotIn('structured', degraded)
        self.assertEqual(1, len(degraded['events']))

    def test_invalid_event_extensions_preserve_the_original_event(self):
        value = copy.deepcopy(self.report)
        value['events'][0].update(timeInfo=[], structured={'representations': [None]},
                                  recoveryAction={'current': None}, occurrenceCount=True)
        raw = value['events'][0]['raw']
        output = normalize_report(value)
        self.assertEqual(raw, output['events'][0]['raw'])
        self.assertTrue(all(key not in output['events'][0] for key in ('timeInfo', 'structured', 'recoveryAction', 'occurrenceCount')))
        self.assertFalse(output['complete'])
        self.assertEqual(1, sum('事件附加数据' in warning for warning in output['warnings']))
        self.assertEqual(output, normalize_report(copy.deepcopy(output)), 'Repeated reads do not accumulate warnings')

    def test_valid_optional_blocks_remain_identical(self):
        value = {**self.report, 'structured': self.dcgm}
        output = normalize_report(copy.deepcopy(value))
        self.assertEqual(output['lifecycleEvents'], value['lifecycleEvents'])
        self.assertEqual(output['structured'], value['structured'])
        self.assertEqual(output['diagnostics'], value['diagnostics'])

    def test_saved_read_is_read_only_and_healthy_parts_still_combine(self):
        with tempfile.TemporaryDirectory() as folder:
            spec = importlib.util.spec_from_file_location('structured_boundary_server', Path(__file__).resolve().parents[1] / 'app/server.py')
            server = importlib.util.module_from_spec(spec)
            with patch.dict(os.environ, {'GPU_LOG_DATA_DIR': folder}): spec.loader.exec_module(server)
            try:
                key = 'a' * 32
                value = {**self.report, 'lifecycleEvents': [None], 'structured': {'format': 'dcgm-json', 'dcgm': {'results': None}}}
                path = server.RESULTS / (key + '.json')
                raw = json.dumps(value).encode();path.write_bytes(raw)
                with server.RESULTS_LOCK: loaded, revision = server.read_case(key)
                self.assertEqual(raw, path.read_bytes())
                self.assertEqual(hashlib.sha256(raw).hexdigest(), revision)
                self.assertEqual(1, len(loaded['events']))
                self.assertNotIn('structured', loaded)
                self.assertNotIn('lifecycleEvents', loaded)
                view = combine({'members': [{'reportId': key, 'source': loaded['source'], 'revision': revision}]}, {key: (loaded, revision)})
                self.assertEqual(1, view['counts']['events'])
                self.assertEqual([], view['lifecycleEvents'])
                self.assertFalse(view['complete'])
            finally:
                server.KNOWLEDGE.close();server.READER.close();server.EXECUTOR.shutdown(wait=True,cancel_futures=True)


if __name__ == '__main__': unittest.main()
