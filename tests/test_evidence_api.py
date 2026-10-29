"""Evidence API integration with synthetic reports and a loopback service."""
import hashlib
import http.client
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO/'app'))
from test_sessions import report

A, SOURCE = 'a'*32, 'c'*32


class EvidenceApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        spec = importlib.util.spec_from_file_location('evidence_api_server', REPO/'app/server.py')
        cls.s = importlib.util.module_from_spec(spec)
        with patch.dict(os.environ, {'GPU_LOG_DATA_DIR': cls.temp.name}):
            spec.loader.exec_module(cls.s)
        cls.service = cls.s.LocalService(0)
        with patch.object(cls.s.ONLINE, 'schedule'):
            cls.service.start()

    @classmethod
    def tearDownClass(cls):
        cls.service.close()
        cls.temp.cleanup()

    def setUp(self):
        self.s.RECOVERY['pending'] = 0
        for key, job in list(self.s.READER.jobs.items()):
            self.s.READER.drop(key)
            job.future.result(timeout=5)
        for folder in (self.s.RESULTS, self.s.SOURCES, self.s.EVIDENCE.root):
            for path in folder.iterdir():
                path.unlink()
        self.s.CASE_CACHE.clear()
        self.s.READER_SOURCES.clear()
        self.raw = b'demo-node.example DEMO-SERVER-001\nGPU-DEMO-001\nNVRM: Xid 79\n'
        self.source = self.s.SOURCES/SOURCE
        self.source.write_bytes(self.raw)
        self.value = report('demo-source.log')
        self.value.pop('sourceMember', None)
        self.value['server'].update(host='demo-node.example', sn='DEMO-SERVER-001')
        self.value['input'] = {'key': SOURCE, 'name': 'demo-upload.log'}
        self.value.update(contentSha256=hashlib.sha256(self.raw).hexdigest(), lines=3)
        self.value['events'] = []
        for field in ('snapshots', 'topology', 'matrices', 'cpuRows'):
            self.value['diagnostics'][field] = []
        self.write_report()

    def write_report(self):
        with self.s.RESULTS_LOCK:
            path = self.s.RESULTS/(A+'.json')
            previous = path.stat().st_mtime_ns if path.exists() else 0
            path.write_text(json.dumps(self.value), encoding='utf-8')
            if previous:
                os.utime(path, ns=(previous+10_000_000, previous+10_000_000))

    def request(self, path, body=None, *, raw=None, headers=None, method=None):
        data = raw if raw is not None else json.dumps(body, ensure_ascii=False).encode() if body is not None else None
        outgoing = {'X-Local-Token': self.s.TOKEN, 'Content-Type': 'application/json'}
        outgoing.update(headers or {})
        connection = http.client.HTTPConnection('127.0.0.1', self.service.http.server_port, timeout=3)
        try:
            connection.request(method or ('POST' if data is not None else 'GET'), path, data, outgoing)
            response = connection.getresponse()
            content = response.read()
            return response.status, json.loads(content)
        finally:
            connection.close()

    def listing(self):
        status, value = self.request('/api/evidence?id='+A)
        self.assertEqual(200, status, value)
        return value

    def ready(self):
        status, meta = self.request('/api/log/meta?id='+A)
        self.assertEqual(200, status, meta)
        self.s.READER.jobs[A].future.result(timeout=5)
        self.assertEqual('ready', self.s.READER.meta(A)['state'])
        return self.listing()

    def body(self, binding=None, **extra):
        binding = binding or self.listing()
        return {key: binding[key] for key in ('id', 'revision', 'identity')} | extra

    def save(self, **entry):
        binding = self.ready()
        value = {'start': 1, 'end': 3, 'title': 'Synthetic evidence',
                 'note': 'demo-upload.log demo-source.log', 'tags': ['synthetic']} | entry
        status, result = self.request('/api/evidence/save', self.body(binding, entry=value))
        self.assertEqual(200, status, result)
        return result['item']

    def preview(self, item, binding=None, **extra):
        return self.request('/api/evidence/preview', self.body(binding, ids=[item['id']], **extra))

    def test_save_update_preview_delete_preserve_source_and_report(self):
        source, report_bytes = self.source.read_bytes(), (self.s.RESULTS/(A+'.json')).read_bytes()
        item = self.save()
        updated = self.save(id=item['id'], note='Checked synthetic excerpt')
        self.assertEqual(item['created'], updated['created'])
        status, preview = self.preview(updated)
        self.assertEqual(200, status, preview)
        self.assertEqual((1, 3), (preview['package']['items'][0]['start'], preview['package']['items'][0]['end']))
        status, value = self.request('/api/evidence/delete', self.body(bookmarkId=item['id']))
        self.assertEqual((200, {'deleted': True}), (status, value))
        self.assertEqual([], self.listing()['items'])
        self.assertEqual(source, self.source.read_bytes())
        self.assertEqual(report_bytes, (self.s.RESULTS/(A+'.json')).read_bytes())

    def test_full_report_redacts_unlabelled_identity_and_source_names(self):
        item = self.save()
        status, value = self.preview(item)
        self.assertEqual(200, status, value)
        for private in ('demo-node.example', 'DEMO-SERVER-001', 'GPU-DEMO-001', 'demo-upload.log', 'demo-source.log', A, self.value['contentSha256']):
            self.assertNotIn(private, value['text'])
            self.assertNotIn(private, value['json'])
        self.assertIn('<HOST-', value['text'])
        self.assertIn('<SERIAL-', value['text'])
        self.assertIn('NVRM: Xid 79', value['text'])
        self.assertNotIn('redactionKey', json.dumps(value))
        path, complete, revision = self.s.EVIDENCE.resolve(A)
        self.assertEqual(self.source, path)
        self.assertEqual('demo-node.example', complete['server']['host'])
        self.assertEqual(self.s.READER.meta(A)['revision'], revision)

    def test_resolver_holds_results_lock_without_returning_json_revision(self):
        calls = []
        original = self.s.read_case
        def checked(key):
            self.assertTrue(self.s.RESULTS_LOCK._is_owned())
            calls.append(key)
            return original(key)
        with patch.object(self.s, 'read_case', side_effect=checked):
            binding = self.listing()
        self.assertTrue(calls)
        self.assertNotEqual(self.s.read_case(A)[1], binding['revision'])

    def test_same_content_reparse_keeps_aliases_and_rejects_old_revision(self):
        item = self.save()
        old = self.listing()
        before = self.preview(item, old)[1]['text']
        self.value['server']['time'] = 'Synthetic metadata revision'
        self.write_report()
        current = self.ready()
        self.assertNotEqual(old['revision'], current['revision'])
        self.assertEqual(old['identity'], current['identity'])
        self.assertTrue(current['items'][0]['reparsed'])
        self.assertFalse(current['items'][0]['stale'])
        self.assertEqual(400, self.preview(item, old)[0])
        self.assertEqual(before, self.preview(item, current)[1]['text'])

    def test_changed_contents_cannot_rebind_old_bookmark(self):
        item = self.save()
        old = self.listing()
        self.source.write_bytes(b'new synthetic source\n')
        self.value.update(contentSha256=hashlib.sha256(self.source.read_bytes()).hexdigest(), lines=1)
        self.write_report()
        current = self.ready()
        self.assertTrue(current['items'][0]['stale'])
        self.assertEqual(400, self.preview(item, old)[0])
        self.assertEqual(400, self.preview(item, current)[0])
        self.assertEqual(400, self.request('/api/evidence/save', self.body(current, entry=item))[0])
        self.assertEqual(200, self.request('/api/evidence/delete', self.body(current, bookmarkId=item['id']))[0])

    def test_changed_source_without_updated_hash_fails_closed(self):
        item = self.save()
        self.source.write_bytes(b'replaced synthetic original\n')
        self.s.READER.meta(A)
        self.s.READER.jobs[A].future.result(timeout=5)
        self.assertEqual('error', self.s.READER.meta(A)['state'])
        status, value = self.preview(item)
        self.assertEqual(400, status, value)
        self.assertNotIn('package', value)
        self.assertEqual(1, len(self.listing()['items']))

    def test_index_not_ready_does_not_create_records(self):
        entered, release = threading.Event(), threading.Event()
        original = self.s.READER._build
        def wait_build(job):
            entered.set()
            release.wait(5)
            return original(job)
        binding = self.listing()
        with patch.object(self.s.READER, '_build', side_effect=wait_build):
            try:
                self.s.READER.meta(A)
                self.assertTrue(entered.wait(2))
                status, value = self.request('/api/evidence/save', self.body(binding, entry={'start': 1, 'end': 1}))
                self.assertEqual(400, status, value)
                self.assertEqual([], self.listing()['items'])
                self.assertEqual([], list(self.s.EVIDENCE.root.iterdir()))
            finally:
                release.set()
                self.s.READER.jobs[A].future.result(timeout=5)
        self.save()

    def test_revision_change_during_read_never_exports_or_overwrites(self):
        item = self.save()
        path = self.s.EVIDENCE.root/(A+'.json')
        original_bytes = path.read_bytes()
        original_read = self.s.EVIDENCE.read
        def changed(*args):
            result = original_read(*args)
            self.value['server']['time'] = 'Changed while reading'
            self.write_report()
            return result
        with patch.object(self.s.EVIDENCE, 'read', side_effect=changed):
            self.assertEqual(400, self.preview(item)[0])
        self.assertEqual(original_bytes, path.read_bytes())

    def test_corrupt_store_keeps_original_and_has_fixed_error(self):
        item = self.save()
        path = self.s.EVIDENCE.root/(A+'.json')
        original = json.loads(path.read_text(encoding='utf-8'))
        for data in ('{broken', json.dumps(original | {'extra': 'synthetic'}),
                     json.dumps(original | {'items': [{key: value for key, value in item.items() if key != 'created'}]})):
            path.write_text(data, encoding='utf-8')
            status, value = self.request('/api/evidence?id='+A)
            self.assertEqual(422, status, value)
            self.assertNotIn(str(path), json.dumps(value))
            self.assertEqual(data, path.read_text(encoding='utf-8'))

    def test_token_host_origin_rejected_before_resolving_or_writing(self):
        with patch.object(self.s.EVIDENCE, 'resolve') as resolve:
            for headers in ({'X-Local-Token': ''}, {'X-Local-Token': 'invalid'}, {'Host': 'other.invalid'},
                            {'Origin': 'https://other.invalid'}, {'Origin': 'null'}):
                self.assertEqual(403, self.request('/api/evidence?id='+A, headers=headers)[0])
                for action in ('save', 'delete', 'preview'):
                    self.assertEqual(403, self.request('/api/evidence/'+action, {}, headers=headers)[0])
            resolve.assert_not_called()
        origin = f'http://127.0.0.1:{self.service.http.server_port}'
        self.assertEqual(200, self.request('/api/evidence?id='+A, headers={'Origin': origin})[0])

    def test_invalid_binding_and_json_do_not_delete_bookmarks(self):
        item = self.save()
        binding = self.listing()
        body = self.body(binding, bookmarkId=item['id'])
        for changed in ({'revision': None}, {'identity': None}, {'revision': ''}, {'identity': True},
                        {'id': '../outside'}, {'path': '/synthetic/outside'}):
            self.assertEqual(400, self.request('/api/evidence/delete', body | changed)[0])
        for raw in (b'{"id":1,"id":2}', b'[]', b'null', b'{"id":NaN}', b'\xff', b'{'):
            self.assertEqual(400, self.request('/api/evidence/delete', raw=raw)[0])
        self.assertEqual(1, len(self.listing()['items']))

    def test_valid_unicode_body_and_request_size_limit(self):
        item = self.save(note='文'*4000)
        options = {'extra': [str(index)+'文'*197 for index in range(100)]}
        self.assertEqual(200, self.preview(item, options=options)[0])
        before = {path.name: path.read_bytes() for path in self.s.EVIDENCE.root.iterdir()}
        # Oversized requests are rejected from headers before reading a body.
        with patch.object(self.s.EVIDENCE, 'save') as save:
            self.assertEqual(400, self.request('/api/evidence/save', method='POST',
                headers={'Content-Length': str(128*1024+1)})[0])
            save.assert_not_called()
        self.assertEqual(before, {path.name: path.read_bytes() for path in self.s.EVIDENCE.root.iterdir()})
        for length in ('-1', '+20', 'invalid', '99999999999999999999'):
            self.assertEqual(400, self.request('/api/evidence/save', raw=b'{}', headers={'Content-Length': length})[0])
        self.assertEqual(400, self.request('/api/evidence/save', raw=b'{}', headers={'Transfer-Encoding': 'chunked'})[0])

    def test_partial_body_times_out_without_creating_records(self):
        with patch.object(self.s, 'JSON_BODY_TIMEOUT', .05):
            status, value = self.request('/api/evidence/save', raw=b'{', headers={'Content-Length': '50'})
        self.assertEqual(408, status, value)
        self.assertEqual([], list(self.s.EVIDENCE.root.iterdir()))

    def test_io_and_unexpected_errors_do_not_reflect_paths(self):
        private = 'C:/SYNTHETIC_PRIVATE/evidence.json'
        for exception, status in ((PermissionError(private), 503), (RuntimeError(private), 500)):
            with patch.object(self.s.EVIDENCE, 'list', side_effect=exception):
                result, value = self.request('/api/evidence?id='+A)
            self.assertEqual(status, result)
            self.assertNotIn('SYNTHETIC_PRIVATE', json.dumps(value))

    def test_deleted_report_makes_remaining_bookmarks_unavailable(self):
        item = self.save()
        binding = self.listing()
        self.assertEqual(200, self.request('/api/cases/delete', {'ids': [A]})[0])
        self.assertEqual(404, self.request('/api/evidence?id='+A)[0])
        self.assertEqual(404, self.preview(item, binding)[0])
        self.assertFalse((self.s.EVIDENCE.root/(A+'.json')).exists())

    def test_report_cleanup_releases_results_lock_and_can_retry(self):
        self.save()
        path = self.s.EVIDENCE.root/(A+'.json')
        def failed(key):
            self.assertFalse(self.s.RESULTS_LOCK._is_owned())
            raise PermissionError('C:/SYNTHETIC_PRIVATE/annotations.json')
        with patch.object(self.s.EVIDENCE, 'remove_report', side_effect=failed):
            status, result = self.request('/api/cases/delete', {'ids': [A]})
        self.assertEqual(200, status, result)
        self.assertEqual([A], result['deleted'])
        self.assertEqual([A], result['evidenceCleanupFailed'])
        self.assertNotIn('SYNTHETIC_PRIVATE', json.dumps(result))
        self.assertFalse((self.s.RESULTS/(A+'.json')).exists())
        self.assertTrue(path.exists())
        status, result = self.request('/api/cases/delete', {'ids': [A]})
        self.assertEqual(200, status, result)
        self.assertFalse(result.get('evidenceCleanupFailed'))
        self.assertFalse(path.exists())

    def test_concurrent_save_cannot_leave_annotations_after_report_cleanup(self):
        binding = self.ready()
        writing, release, cleanup = threading.Event(), threading.Event(), threading.Event()
        results = {}
        original_write, original_remove = self.s.EVIDENCE._write, self.s.EVIDENCE.remove_report
        def write(key, data):
            writing.set()
            release.wait(5)
            original_write(key, data)
        def remove(key):
            self.assertFalse(self.s.RESULTS_LOCK._is_owned())
            cleanup.set()
            original_remove(key)
        def save():results['save'] = self.request('/api/evidence/save', self.body(binding, entry={'start': 1, 'end': 1}))
        def delete():results['delete'] = self.request('/api/cases/delete', {'ids': [A]})
        saver, deleter = threading.Thread(target=save), threading.Thread(target=delete)
        with patch.object(self.s.EVIDENCE, '_write', side_effect=write), patch.object(self.s.EVIDENCE, 'remove_report', side_effect=remove):
            try:
                saver.start()
                self.assertTrue(writing.wait(2))
                deleter.start()
                self.assertTrue(cleanup.wait(2))
                self.assertFalse((self.s.RESULTS/(A+'.json')).exists())
            finally:
                release.set()
                saver.join(3)
                if deleter.ident is not None:deleter.join(3)
        self.assertFalse(saver.is_alive())
        self.assertFalse(deleter.is_alive())
        self.assertEqual(200, results['save'][0])
        self.assertEqual(200, results['delete'][0])
        self.assertFalse(results['delete'][1].get('evidenceCleanupFailed'))
        self.assertFalse((self.s.EVIDENCE.root/(A+'.json')).exists())


if __name__ == '__main__':
    unittest.main()
