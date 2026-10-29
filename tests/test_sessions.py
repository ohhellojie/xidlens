import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'app'))
from sessions import SessionStore, aware_time, combine


A, B, C = 'a' * 32, 'b' * 32, 'c' * 32


def report(source, gpu_uuid='GPU-DEMO-001', gpu_serial='DEMO-SERIAL-001', machine='DEMO-SERVER', time='[12.345]'):
    def field(value, line):
        return {'value': value, 'origin': 'synthetic', 'evidence': {'line': line, 'text': value, 'section': 'sample'}}
    return {
        'source': source, 'sourceMember': 'logs/' + source, 'complete': True,
        'server': {'sn': machine, 'uuid': '', 'time': '', 'fields': {}},
        'gpus': [{'id': 0, 'pci': '0000:41:00.0', 'label': 'GPU 0', 'model': 'NVIDIA A100',
                  'uuid': gpu_uuid, 'sn': gpu_serial,
                  'fields': {'uuid': [field(gpu_uuid, 5)] if gpu_uuid else [],
                             'serial': [field(gpu_serial, 6)] if gpu_serial else [],
                             'model': [field('NVIDIA A100', 7)]}}],
        'events': [{'id': 'e0', 'gpu': 0, 'address': '0000:41:00.0', 'kind': 'xid', 'code': '79',
                    'time': time, 'boot': '-- Boot demo --', 'line': 12, 'raw': time + ' NVRM: Xid 79'}],
        'diagnostics': {'checks': [{'id': 'c0', 'status': 'missing', 'address': '0000:41:00.0',
                                    'evidence': [{'line': 15, 'text': 'N/A', 'section': 'sample'}]}]}}


class SessionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.data = {A: (report('first.log'), 'revision-a'), B: (report('second.log'), 'revision-b')}
        self.original = copy.deepcopy(self.data)
        self.store = SessionStore(Path(self.temp.name) / 'sessions', self.load)

    def tearDown(self):
        self.temp.cleanup()

    def load(self, key):
        if key not in self.data:
            raise FileNotFoundError('missing')
        return self.data[key]

    def create(self, ids=None):
        return self.store.create(ids or [A, B], 'Sample session')

    def test_manifest_is_small_and_keeps_original_reports_unchanged(self):
        result = self.create()
        manifest = result['manifest']
        self.assertEqual(manifest['method'], 'user-selected')
        saved = (self.store.root / (manifest['id'] + '.json')).read_text(encoding='utf-8')
        self.assertNotIn('NVRM', saved)
        self.assertNotIn('GPU-DEMO', saved)
        self.assertEqual(self.data, self.original)
        self.assertEqual(self.store.list()['sessions'][0]['id'], manifest['id'])

    def test_cross_file_evidence_remains_source_and_line_addressed(self):
        view = self.create()['view']
        self.assertEqual(len(view['events']), 2)
        self.assertNotEqual(view['events'][0]['id'], view['events'][1]['id'])
        self.assertEqual(view['events'][1]['line'], 12)
        self.assertEqual(view['events'][1]['reportId'], B)
        self.assertEqual(view['events'][1]['sourceMember'], 'logs/second.log')
        self.assertEqual(view['events'][1]['deviceKey'], B + ':0')
        self.assertEqual(view['checks'][1]['evidence'][0]['line'], 15)
        self.assertEqual(view['checks'][1]['evidence'][0]['reportId'], B)
        self.assertEqual(view['devices'][1]['fields']['model'][0]['evidence']['source'], 'second.log')

    def test_lifecycle_sources_and_association_evidence_keep_error_counts(self):
        first = self.data[A][0]
        first['lifecycleEvents'] = [{'id': 'l0', 'gpu': 0, 'kind': 'reset', 'targetUUID': 'GPU-DEMO-001',
            'outcome': 'completed', 'line': 20, 'raw': '[13] GPU reset executed: synthetic',
            'timeInfo': {'kind': 'uptime_seconds', 'raw': '13'}, 'boot': '-- Boot demo --',
            'association': {'method': 'uuid', 'refs': first['gpus'][0]['fields']['uuid']}}]
        original = copy.deepcopy(first)
        view = self.create()['view']
        event = view['lifecycleEvents'][0]
        self.assertEqual(view['counts']['events'], 2)
        self.assertEqual(view['counts']['lifecycleEvents'], 1)
        self.assertEqual(event['reportId'], A)
        self.assertEqual(event['sourceMember'], 'logs/first.log')
        self.assertEqual(event['line'], 20)
        self.assertEqual(event['deviceKey'], A + ':0')
        self.assertEqual(event['timeInfo']['kind'], 'uptime_seconds')
        self.assertEqual(event['timeInfo']['raw'], '13')
        self.assertEqual(event['association']['refs'][0]['evidence']['reportId'], A)
        self.assertEqual(event['association']['refs'][0]['evidence']['line'], 5)
        self.assertEqual(first, original)

    def test_same_bdf_without_identity_does_not_match(self):
        self.data[A] = report('first.log', '', ''), 'a'
        self.data[B] = report('second.log', '', ''), 'b'
        view = self.create()['view']
        self.assertEqual(len(view['deviceGroups']), 2)
        self.assertEqual(view['links'], [])

    def test_unique_uuid_or_serial_links_only_when_other_identity_agrees(self):
        self.data[A][0]['gpus'][0]['fields'].pop('serial')
        self.data[A][0]['gpus'][0]['sn'] = ''
        view = self.create()['view']
        self.assertEqual(len(view['deviceGroups']), 1)
        self.assertEqual(view['links'][0]['basis'], [{'field': 'uuid', 'value': 'GPU-DEMO-001'}])
        self.data[A][0]['gpus'][0]['sn'] = 'DIFFERENT-SERIAL'
        self.assertEqual(self.create()['view']['links'], [])

    def test_conflicting_machine_ids_block_device_links(self):
        self.data[B][0]['server']['sn'] = 'OTHER-DEMO-SERVER'
        view = self.create()['view']
        self.assertEqual(view['links'], [])
        self.assertTrue(any(w['kind'] == 'machine-conflict' for w in view['warnings']))

    def test_internal_machine_and_device_conflicts_cannot_be_hidden_by_fallback(self):
        self.data[A][0]['server']['sn'] = '冲突'
        self.assertEqual(self.create()['view']['links'], [])
        self.data[A][0]['server']['sn'] = 'DEMO-SERVER'
        gpu = self.data[A][0]['gpus'][0]
        gpu['fields']['serial'].append({'value': 'DIFFERENT', 'evidence': {'line': 8}})
        self.assertEqual(self.create()['view']['links'], [])

    def test_duplicate_identity_in_one_file_is_not_matched(self):
        gpu = copy.deepcopy(self.data[A][0]['gpus'][0])
        gpu.update(id=1, pci='0000:42:00.0')
        self.data[A][0]['gpus'].append(gpu)
        view = self.create()['view']
        self.assertEqual(view['links'], [])
        self.assertTrue(any(w['kind'] == 'ambiguous-device' for w in view['warnings']))

    def test_transitive_group_cannot_join_two_gpus_from_one_report(self):
        self.data[A] = report('first.log', 'GPU-DEMO-A', ''), 'a'
        self.data[B] = report('second.log', 'GPU-DEMO-A', 'DEMO-SHARED'), 'b'
        self.data[C] = report('third.log', '', 'DEMO-SHARED'), 'c'
        extra = copy.deepcopy(self.data[A][0]['gpus'][0])
        extra.update(id=1, uuid='', sn='DEMO-SHARED')
        extra['fields'] = {'serial': [{'value': 'DEMO-SHARED', 'evidence': {'line': 4}}]}
        self.data[A][0]['gpus'].append(extra)
        view = self.create([A, B, C])['view']
        for group in view['deviceGroups']:
            report_ids = [key.split(':')[0] for key in group['deviceKeys']]
            self.assertEqual(len(set(report_ids)), len(report_ids))

    def test_multiple_values_preserve_each_source(self):
        self.data[B][0]['gpus'][0]['fields']['model'][0]['value'] = 'NVIDIA H100'
        view = self.create()['view']
        diff = next(d for d in view['fieldDifferences'] if d['field'] == 'model')
        self.assertEqual({r['value'] for r in diff['values']}, {'NVIDIA A100', 'NVIDIA H100'})
        self.assertEqual({r['evidence']['reportId'] for r in diff['values']}, {A, B})

    def test_unknown_and_uptime_times_are_not_sorted_across_sources(self):
        self.data[B][0]['events'][0].update(time='1.000', raw='[1.000] NVRM: Xid 79')
        view = self.create()['view']
        self.assertEqual(view['timeOrder'], 'source')
        self.assertEqual([e['reportId'] for e in view['events']], [A, B])
        self.assertEqual(view['events'][0]['timeInfo']['kind'], 'uptime_seconds')
        self.assertIsNone(view['events'][0]['timeInfo']['utc'])

    def test_explicit_timezones_allow_calendar_order(self):
        self.data[A][0]['events'][0].update(time='2026-10-28T10:00:00+08:00', raw='2026-10-28T10:00:00+08:00 NVRM: Xid 79')
        self.data[B][0]['events'][0].update(time='2026-10-28T01:00:00Z', raw='2026-10-28T01:00:00Z NVRM: Xid 79')
        view = self.create()['view']
        self.assertEqual(view['timeOrder'], 'calendar')
        self.assertEqual([e['reportId'] for e in view['events']], [B, A])
        self.data[B][0]['events'][0].update(time='2026-10-28T01:00:00', raw='2026-10-28T01:00:00 NVRM: Xid 79')
        self.assertEqual(self.create()['view']['timeOrder'], 'source')
        self.assertIsNone(aware_time('2026-02-30T01:00:00Z'))

    def test_duplicate_content_counts_once_but_retains_member_reference(self):
        for report_data, _ in self.data.values():
            report_data['contentSha256'] = '1' * 64
        view = self.create()['view']
        self.assertEqual(view['counts']['events'], 1)
        self.assertEqual(view['members'][1]['duplicateOf'], A)

    def test_missing_and_reparsed_members_remain_explicit_until_refresh(self):
        created = self.create()
        key = created['manifest']['id']
        del self.data[B]
        self.data[A] = self.data[A][0], 'new-revision'
        view = self.store.get(key)['view']
        self.assertEqual([m['state'] for m in view['members']], ['changed', 'missing'])
        self.assertEqual(view['events'], [])
        self.assertFalse(view['complete'])
        refreshed = self.store.refresh(key)['view']
        self.assertEqual(refreshed['members'][0]['state'], 'ready')
        self.assertEqual(refreshed['members'][1]['state'], 'missing')
        self.assertEqual(len(refreshed['events']), 1)

    def test_delete_only_manifest_never_deletes_reports(self):
        key = self.create()['manifest']['id']
        self.store.delete(key)
        self.assertEqual(self.store.list()['sessions'], [])
        self.assertEqual(self.data, self.original)

    def test_invalid_members_never_publish_a_manifest(self):
        for ids in ([A, A], [A], [A, '../bad'], [A, 42], None, [A] * 33):
            with self.assertRaises(ValueError):
                self.store.create(ids)
        with self.assertRaises(FileNotFoundError):
            self.store.create([A, C])
        self.assertEqual(self.store.list()['sessions'], [])

    def test_corrupt_or_path_escape_manifests_are_not_read(self):
        (self.store.root / (A + '.json')).write_text('[]', encoding='utf-8')
        self.assertEqual(self.store.list()['unreadable'], 1)
        with self.assertRaises(ValueError):
            self.store.get('../outside')
        with self.assertRaises(ValueError):
            self.store.delete('../outside')

    def test_view_limits_are_explicit_without_altering_sources(self):
        with patch('sessions.MAX_EVENTS', 1), patch('sessions.MAX_CHECKS', 1):
            view = self.create()['view']
        self.assertEqual(view['counts']['events'], 2)
        self.assertEqual(len(view['events']), 1)
        self.assertFalse(view['complete'])
        self.assertEqual(self.data, self.original)
        self.assertEqual(len([w for w in view['warnings'] if w['kind'] == 'limit']), 2)

    def test_32_member_groups_retain_every_identity_link_and_source(self):
        manifest, loaded = {'members': []}, {}
        for member in range(32):
            key = f'{member:032x}'
            current = report(f'synthetic-{member}.log')
            current['gpus'] = []
            for index in range(4):
                gpu = report('synthetic.log', f'GPU-SYNTHETIC-{index}', f'SYNTHETIC-{index}')['gpus'][0]
                gpu.update(id=index, pci=f'0000:{index:02x}:00.0')
                current['gpus'].append(gpu)
            manifest['members'].append({'reportId': key, 'source': current['source'], 'revision': 'r1'})
            loaded[key] = current, 'r1'
        original = copy.deepcopy(loaded)
        view = combine(manifest, loaded)
        self.assertEqual(loaded, original)
        self.assertEqual(len(view['devices']), 128)
        self.assertEqual(len(view['deviceGroups']), 4)
        self.assertTrue(all(len(group['deviceKeys']) == 32 for group in view['deviceGroups']))
        self.assertEqual(len(view['links']), 4 * 32 * 31 // 2)
        self.assertTrue(all({row['field'] for row in link['basis']} == {'serial', 'uuid'} for link in view['links']))
        self.assertEqual(len(view['events']), 32)
        self.assertEqual({row['reportId'] for row in view['events']}, set(loaded))


if __name__ == '__main__':
    unittest.main()
