import hashlib
import json
from pathlib import Path
import re
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'app'))
from evidence import EvidenceStore, Redactor, MAX_RANGE, normalize_options


class EvidenceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.key = 'a'*32
        self.lines = ['Hostname: demo-node.example', 'Serial Number: DEMO-SERVER-001', 'GPU UUID: GPU-DEMO-001', 'peer=192.0.2.14 path=/srv/demo/trace.log', 'NVRM: Xid 79']
        self.identity = hashlib.sha256('\n'.join(self.lines).encode()).hexdigest()
        self.revision = 'revision-one'
        self.report = {'source': '/srv/demo/private-name.log', 'contentSha256': self.identity, 'lines': len(self.lines), 'server': {'host': 'demo-node.example', 'sn': 'DEMO-SERVER-001'}, 'gpus': [{'uuid': 'GPU-DEMO-001'}]}
        self.store = EvidenceStore(self.root/'bookmarks', self.resolve, self.read)

    def tearDown(self):
        self.tmp.cleanup()

    def resolve(self, key):
        if key != self.key:
            raise ValueError('报告不存在')
        return self.root/'sample.log', self.report, self.revision

    def read(self, key, revision, start, count):
        self.assertEqual(key, self.key)
        self.assertEqual(revision, self.revision)
        return {'start': start, 'revision': revision, 'lines': self.lines[start-1:start-1+count]}

    def save(self, **changes):
        entry = {'start': 1, 'end': 5, 'title': 'GPU 错误', 'note': 'demo-node.example 上的 DEMO-SERVER-001', 'tags': ['设备', 'GPU-DEMO-001']}
        entry.update(changes)
        return self.store.save(self.key, self.revision, self.identity, entry)['item']

    def test_save_update_reload_and_delete_preserve_local_notes(self):
        item = self.save()
        result = self.store.list(self.key)
        self.assertEqual(result['identity'], self.identity)
        self.assertFalse(result['items'][0]['stale'])
        self.assertEqual(result['items'][0]['note'], item['note'])
        self.assertNotIn('redactionKey', result)
        updated = self.save(id=item['id'], note='已核对原文', tags=['same', 'same'])
        self.assertEqual(updated['tags'], ['same'])
        reopened = EvidenceStore(self.root/'bookmarks', self.resolve, self.read)
        self.assertEqual(reopened.list(self.key)['items'][0]['note'], '已核对原文')
        reopened.delete(self.key, self.revision, self.identity, item['id'])
        self.assertEqual(reopened.list(self.key)['items'], [])

    def test_preview_redacts_notes_tags_lines_and_source_names(self):
        item = self.save()
        result = self.store.preview(self.key, self.revision, self.identity, [item['id']])
        for private in ('demo-node.example', 'DEMO-SERVER-001', 'GPU-DEMO-001', '192.0.2.14', '/srv/demo/trace.log', 'private-name.log', self.identity, self.key):
            self.assertNotIn(private, result['text'])
            self.assertNotIn(private, result['json'])
        self.assertIn('NVRM: Xid 79', result['text'])
        self.assertIn('不能覆盖全部自由文本', result['warning'])
        self.assertEqual(json.loads(result['json']), result['package'])
        self.assertNotIn('redactionKey', result['json'])
        self.assertEqual(result['package']['items'][0]['start'], 1)
        self.assertEqual(result['package']['items'][0]['end'], 5)
        self.assertTrue(result['replacements']['host'] >= 2)

    def test_aliases_stay_consistent_across_previews_and_selections(self):
        one = self.save(start=1, end=2)
        two = self.save(start=3, end=5)
        a = self.store.preview(self.key, self.revision, self.identity, [one['id']])
        b = self.store.preview(self.key, self.revision, self.identity, [two['id'], one['id']])
        host_a = re.findall(r'<HOST-[0-9a-f]+>', a['text'])
        host_b = re.findall(r'<HOST-[0-9a-f]+>', b['text'])
        self.assertTrue(host_a)
        self.assertEqual(set(host_a), set(host_b))
        secret = json.loads((self.root/'bookmarks'/(self.key+'.json')).read_text(encoding='utf-8'))['redactionKey']
        self.assertNotIn(secret, b['json'])

    def test_revision_and_identity_are_checked_before_using_ranges(self):
        item = self.save()
        self.revision = 'revision-two'
        with self.assertRaisesRegex(ValueError, '变更'):
            self.store.preview(self.key, 'revision-one', self.identity, [item['id']])
        listing = self.store.list(self.key)
        self.assertTrue(listing['items'][0]['reparsed'])
        self.assertFalse(listing['items'][0]['stale'])
        self.store.preview(self.key, self.revision, self.identity, [item['id']])
        self.report['contentSha256'] = 'b'*64
        self.assertTrue(self.store.list(self.key)['items'][0]['stale'])
        with self.assertRaisesRegex(ValueError, '旧版本'):
            self.store.preview(self.key, self.revision, 'b'*64, [item['id']])
        with self.assertRaisesRegex(ValueError, '原文已变化'):
            self.store.save(self.key, self.revision, 'b'*64, {**item, 'note': 'cannot rebind'})

    def test_mutations_and_preview_require_explicit_valid_binding(self):
        item = self.save()
        path = self.root/'bookmarks'/(self.key+'.json')
        original = path.read_bytes()
        bindings = [(None, self.identity), ('', self.identity), ([], self.identity),
                    ('x'*129, self.identity), ('revision\n', self.identity),
                    (self.revision, None), (self.revision, ''), (self.revision, [])]
        for revision, identity in bindings:
            operations = [lambda: self.store.delete(self.key, revision, identity, item['id']),
                          lambda: self.store.save(self.key, revision, identity, item),
                          lambda: self.store.preview(self.key, revision, identity, [item['id']])]
            for operation in operations:
                with self.subTest(revision=revision, identity=identity), patch.object(self.store, 'read') as read:
                    with self.assertRaisesRegex(ValueError, '无效'):
                        operation()
                    read.assert_not_called()
                    self.assertEqual(path.read_bytes(), original)

    def test_same_content_reparse_keeps_aliases_but_requires_current_revision(self):
        item = self.save()
        previous = self.store.preview(self.key, self.revision, self.identity, [item['id']])
        self.revision = 'revision-two'
        listing = self.store.list(self.key)
        self.assertTrue(listing['items'][0]['reparsed'])
        self.assertFalse(listing['items'][0]['stale'])
        current = self.store.preview(self.key, self.revision, self.identity, [item['id']])
        self.assertEqual(previous['text'], current['text'])
        self.report['contentSha256'] = 'b'*64
        self.store.delete(self.key, self.revision, 'b'*64, item['id'])
        self.assertEqual(self.store.list(self.key)['items'], [])

    def test_range_note_tag_and_option_limits(self):
        for change in ({'start': True}, {'start': 0}, {'end': MAX_RANGE+1}, {'end': 6}, {'note': 'x'*4001}, {'tags': ['x']*13}, {'tags': ['x'*41]}, {'title': 'x\0y'}):
            with self.subTest(change=str(change)[:50]), self.assertRaises(ValueError):
                self.save(**change)
        self.assertEqual(self.store.list(self.key)['items'], [])
        for options in ({'redact': {'ip': 'false'}}, {'redact': {'other': True}}, {'extra': ['x']*101}):
            with self.assertRaises(ValueError):
                normalize_options(options)
        with self.assertRaises(ValueError):
            self.store.list('../outside')

    def test_corrupt_store_is_never_silently_overwritten(self):
        path = self.root/'bookmarks'/(self.key+'.json')
        path.write_text('{broken', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, '原文件已保留'):
            self.save()
        self.assertEqual(path.read_text(encoding='utf-8'), '{broken')

    def test_invalid_stored_metadata_is_rejected_without_rewrite(self):
        item = self.save()
        path = self.root/'bookmarks'/(self.key+'.json')
        valid = json.loads(path.read_text(encoding='utf-8'))
        changes = [('created', None), ('created', 'not-a-date'), ('updated', '2026-01-01T00:00:00'),
                   ('revision', None), ('revision', ''), ('extra', 'unexpected metadata')]
        for field, value in changes:
            data = json.loads(json.dumps(valid))
            if value is None:
                data['items'][0].pop(field)
            else:
                data['items'][0][field] = value
            original = json.dumps(data).encode()
            path.write_bytes(original)
            for operation in (lambda: self.store.list(self.key),
                              lambda: self.save(id=item['id']),
                              lambda: self.store.delete(self.key, self.revision, self.identity, item['id']),
                              lambda: self.store.preview(self.key, self.revision, self.identity, [item['id']])):
                with self.subTest(field=field, value=value), self.assertRaisesRegex(ValueError, '原文件已保留'):
                    operation()
                self.assertEqual(path.read_bytes(), original)

    def test_index_not_ready_does_not_save_or_export(self):
        item = self.save()
        path = self.root/'bookmarks'/(self.key+'.json')
        original = path.read_bytes()
        with patch.object(self.store, 'read', side_effect=ValueError('原文索引尚未完成')):
            with self.assertRaisesRegex(ValueError, '索引尚未完成'):
                self.save(id=item['id'], note='pending')
            with self.assertRaisesRegex(ValueError, '索引尚未完成'):
                self.store.preview(self.key, self.revision, self.identity, [item['id']])
        self.assertEqual(path.read_bytes(), original)

    def test_revision_change_during_read_rejects_save_and_preview(self):
        item = self.save()
        path = self.root/'bookmarks'/(self.key+'.json')
        original = path.read_bytes()
        def changed_read(key, revision, start, count):
            result = self.read(key, revision, start, count)
            self.revision = 'revision-two'
            return result
        for operation in (lambda: self.save(id=item['id'], note='stale request'),
                          lambda: self.store.preview(self.key, self.revision, self.identity, [item['id']])):
            self.revision = 'revision-one'
            with patch.object(self.store, 'read', side_effect=changed_read), self.assertRaisesRegex(ValueError, '报告已变更'):
                operation()
            self.assertEqual(path.read_bytes(), original)

    def test_failed_atomic_replace_retains_existing_data(self):
        item = self.save()
        path = self.root/'bookmarks'/(self.key+'.json')
        original = path.read_bytes()
        with patch('evidence.os.replace', side_effect=OSError('unavailable')):
            with self.assertRaisesRegex(ValueError, '已有记录未覆盖'):
                self.save(id=item['id'], note='new')
        self.assertEqual(path.read_bytes(), original)
        self.assertFalse(list(path.parent.glob('.evidence-*.tmp')))

    def test_read_revision_and_partial_ranges_are_rejected(self):
        self.store.read = lambda *args: {'revision': 'stale', 'start': 1, 'lines': self.lines}
        with self.assertRaisesRegex(ValueError, '版本不匹配'):
            self.save()
        self.assertFalse((self.root/'bookmarks'/(self.key+'.json')).exists())

    def test_discovery_handles_ipv6_paths_custom_text_and_credentials(self):
        windows = 'X:'+chr(92)+'logs'+chr(92)+'trace.txt'
        text = 'peer=2001:db8::1 ipv4=198.51.100.23 pci=0000:41:00.0 '+windows+' "'+ '/srv/demo folder/log.txt'+'" Password: temporary-value Customer Example'
        redactor = Redactor({}, 'a'*64, [text], {'extra': ['Customer Example']})
        result = redactor.text(text)
        for private in ('2001:db8::1', '198.51.100.23', windows, '/srv/demo folder/log.txt', 'temporary-value', 'Customer Example'):
            self.assertNotIn(private, result)
        self.assertIn('0000:41:00.0', result)
        self.assertIn('<SECRET-', result)
        self.assertIn('<CUSTOM-', result)

    def test_optional_categories_are_explicit_and_default_on(self):
        text = 'peer 192.0.2.17 Hostname: demo-host'
        result = Redactor({}, 'b'*64, [text], {'redact': {'ip': False}}).text(text)
        self.assertIn('192.0.2.17', result)
        self.assertNotIn('demo-host', result)
        self.assertNotIn('192.0.2.17', Redactor({}, 'b'*64, [text]).text(text))

    def test_quoted_credentials_and_basic_auth_are_fully_redacted(self):
        samples = ['{"api_key": "DEMO-CREDENTIAL-ONLY", "password": "DEMO PASSPHRASE"}',
                   'Password="DEMO PASSPHRASE"', "password: 'DEMO PASSPHRASE'",
                   'Authorization: Basic ZGVtbzpkZW1v',
                   '{"Authorization": "Basic ZGVtbzpkZW1v"}',
                   'access_token=DEMO-TOKEN-ONLY']
        for text in samples:
            with self.subTest(text=text):
                result = Redactor({}, 'a'*64, [text]).text(text)
                for private in ('DEMO-CREDENTIAL-ONLY', 'DEMO', 'PASSPHRASE', 'ZGVtbzpkZW1v', 'DEMO-TOKEN-ONLY'):
                    self.assertNotIn(private, result)
                self.assertIn('<SECRET-', result)

    def test_known_token_shapes_in_free_text_are_redacted(self):
        tokens = ['gh'+'p_'+'a'*30, 'sk'+'-'+'b'*30,
                  'github'+'_pat_'+'c'*30, 'eyJ'+'d'*12+'.'+'e'*12+'.'+'f'*12]
        text = ' '.join(tokens)
        result = Redactor({}, 'a'*64, [text]).text(text)
        self.assertEqual(result.count('<SECRET-'), 4)
        self.assertFalse(any(token in result for token in tokens))

    def test_long_detected_credentials_are_never_silently_left_in_preview(self):
        text = 'password='+'a'*3000
        self.assertNotIn('a'*3000, Redactor({}, 'a'*64, [text]).text(text))
        with self.assertRaisesRegex(ValueError, '敏感字段过长') as caught:
            Redactor({}, 'a'*64, ['password='+'b'*5000])
        self.assertNotIn('b'*5000, str(caught.exception))

    def test_unlabelled_case_variants_and_uuid_spellings_share_aliases(self):
        gpu = 'GPU-11111111-2222-3333-4444-555555555555'
        text = 'demo-node.example DEMO-NODE.EXAMPLE ' + gpu + ' ' + gpu.lower() + ' ' + gpu[4:]
        result = Redactor({'server': {'host': 'demo-node.example'}, 'gpus': [{'uuid': gpu}]}, 'a'*64, [text]).text(text)
        self.assertNotIn('DEMO-NODE', result)
        self.assertEqual(len(set(re.findall(r'<HOST-[a-f0-9]+>', result))), 1)
        self.assertEqual(len(re.findall(r'<UUID-[a-f0-9]+>', result)), 3)
        self.assertEqual(len(set(re.findall(r'<UUID-[a-f0-9]+>', result))), 1)

    def test_ipv6_punctuation_and_equivalent_notation(self):
        text = 'peer=2001:db8::1. other=2001:0DB8:0:0:0:0:0:1 bind=::'
        result = Redactor({}, 'a'*64, [text]).text(text)
        aliases = re.findall(r'<IP-[a-f0-9]+>', result)
        self.assertEqual(len(aliases), 3)
        self.assertEqual(aliases[0], aliases[1])
        self.assertNotIn('2001:', result)

    def test_windows_path_separators_and_case_share_aliases(self):
        first = 'X:'+chr(92)+'Logs'+chr(92)+'trace.txt'
        text = first + ' x:/logs/trace.txt'
        result = Redactor({}, 'a'*64, [text]).text(text)
        aliases = re.findall(r'<PATH-[a-f0-9]+>', result)
        self.assertEqual(len(aliases), 2)
        self.assertEqual(aliases[0], aliases[1])

    def test_source_filename_in_note_and_title_is_redacted(self):
        self.report['input'] = {'key': 'c'*32, 'name': 'demo-collection.tar.gz'}
        self.report['sourceMember'] = {'name': 'logs/demo-member.log', 'index': 0}
        item = self.save(title='private-name.log', note='Source: private-name.log demo-collection.tar.gz logs/demo-member.log')
        result = self.store.preview(self.key, self.revision, self.identity, [item['id']])
        for name in ('private-name.log', 'demo-collection.tar.gz', 'demo-member.log'):
            self.assertNotIn(name, result['json'])
        self.assertIn('<SOURCE-', result['json'])

    def test_quoted_host_and_serial_fields_are_discovered_without_inventory(self):
        text = '{"hostname":"demo-node.example","serial":"DEMO-SN-001"} demo-node.example DEMO-SN-001'
        result = Redactor({}, 'a'*64, [text]).text(text)
        self.assertNotIn('demo-node.example', result)
        self.assertNotIn('DEMO-SN-001', result)
        self.assertEqual(result.count('<HOST-'), 2)
        self.assertEqual(result.count('<SERIAL-'), 2)

    def test_case_variants_of_same_host_share_alias(self):
        text = 'Hostname: demo-host\nHostname: DEMO-HOST'
        result = Redactor({}, 'c'*64, [text]).text(text)
        aliases = re.findall(r'<HOST-[a-f0-9]+>', result)
        self.assertEqual(len(aliases), 2)
        self.assertEqual(aliases[0], aliases[1])

    def test_concurrent_additions_do_not_lose_bookmarks(self):
        errors = []
        def save_one(index):
            try:
                self.save(title='Entry '+str(index))
            except Exception as error:
                errors.append(error)
        threads = [threading.Thread(target=save_one, args=(i,)) for i in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertFalse(errors)
        self.assertEqual(len(self.store.list(self.key)['items']), 8)

    def test_logstore_reads_exact_lines_without_changing_source(self):
        from log_reader import LogStore
        source = self.root/'sample.log'
        raw = ('\n'.join(self.lines)+'\n').encode('utf-8')
        source.write_bytes(raw)
        self.report['contentSha256'] = self.identity = hashlib.sha256(raw).hexdigest()
        self.report['input'] = {'name': source.name, 'key': self.key}
        reader = LogStore(self.root/'cache', self.resolve)
        try:
            reader.meta(self.key)
            reader.jobs[self.key].future.result(timeout=10)
            self.store.read = reader.lines
            item = self.save()
            preview = self.store.preview(self.key, self.revision, self.identity, [item['id']])
            self.assertEqual(len(preview['package']['items'][0]['lines']), 5)
            self.assertEqual(source.read_bytes(), raw)
        finally:
            reader.close()


if __name__ == '__main__':
    unittest.main()
