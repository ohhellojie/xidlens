import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'app'))
import knowledge


def release(kind,pack):
    raw=json.dumps(pack,ensure_ascii=False).encode()
    tag='knowledge-'+kind+'-v'+pack['version']
    asset={'name':'XidLens-'+kind+'.json','size':len(raw),'digest':'sha256:'+hashlib.sha256(raw).hexdigest(),
           'browser_download_url':knowledge.REPOSITORY+'/releases/download/'+tag+'/XidLens-'+kind+'.json'}
    return {'tag_name':tag,'draft':False,'prerelease':False,'assets':[asset]},raw


class ReferenceUpdatesTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.store=knowledge.KnowledgeStore(self.root)
    def tearDown(self):self.store.close();self.temp.cleanup()
    def updated(self,kind):
        pack=copy.deepcopy(self.store.data[kind]);pack['version']='1.0.1'
        if kind=='xid':pack['content']['cn']['codes']['79']['title']='更新后的说明'
        else:pack['content']['topics'][0]['title']='更新后的步骤'
        return pack
    def check(self,kind,pack):
        row,raw=release(kind,pack)
        with patch('knowledge.download',return_value=json.dumps([row]).encode()):self.store.run(kind,'check')
        return raw
    def apply(self,kind,raw):
        with patch('knowledge.download',return_value=raw):self.store.run(kind,'apply')

    def test_each_package_updates_independently_and_survives_restart(self):
        for kind in ('xid','manual'):
            other='manual' if kind=='xid' else 'xid';unchanged=copy.deepcopy(self.store.data[other])
            pack=self.updated(kind);raw=self.check(kind,pack)
            self.assertEqual(self.store.data[kind]['version'],'1.0.0')
            self.apply(kind,raw)
            self.assertEqual(self.store.data[kind],pack);self.assertEqual(self.store.data[other],unchanged)
            self.assertEqual(knowledge.KnowledgeStore(self.root).data[kind],pack)

    def test_failed_download_hash_schema_and_write_preserve_current(self):
        pack=self.updated('xid');raw=self.check('xid',pack);self.apply('xid',raw)
        before=self.store.content();path=self.root/'knowledge/xid/active.json';saved=path.read_bytes()
        newer=copy.deepcopy(pack);newer['version']='1.0.2'
        good=self.check('xid',newer)
        for failure in ('network','hash','schema','write'):
            with self.subTest(failure=failure):
                if failure=='network':
                    with patch('knowledge.download',side_effect=OSError('offline')):self.store.run('xid','apply')
                elif failure=='hash':self.apply('xid',b'incomplete')
                elif failure=='schema':
                    broken=copy.deepcopy(newer);broken['schema']=999
                    raw=self.check('xid',broken);self.apply('xid',raw)
                else:
                    good=self.check('xid',newer);replace=Path.replace
                    def fail(source,target):
                        if Path(target).name=='active.json':raise PermissionError('disk full')
                        return replace(source,target)
                    with patch.object(Path,'replace',fail):self.apply('xid',good)
                self.assertEqual(self.store.state['xid']['state'],'error')
                self.assertEqual(self.store.data['xid'],before['packages']['xid']);self.assertEqual(path.read_bytes(),saved)

    def test_missing_references_unsafe_links_and_malformed_manual_are_rejected(self):
        original=self.updated('manual')
        for mutate in (lambda p:p['sources'][0].update(url='javascript:alert(1)'),
                       lambda p:p['content']['topics'][0].update(next=['absent']),
                       lambda p:p['content']['topics'][0].update(steps=[]),
                       lambda p:p['content']['sources'].update(triage=['unsafe','https://evil.test/x']),
                       lambda p:p.update(kind='xid')):
            pack=copy.deepcopy(original);mutate(pack)
            with self.assertRaises(ValueError):knowledge.checked(json.dumps(pack).encode(),'manual')

    def test_release_selection_ignores_other_assets_old_versions_and_drafts(self):
        row,raw=release('xid',self.updated('xid'))
        self.assertIsNotNone(knowledge.candidate([row],'xid','1.0.0'))
        for mutate in (lambda r:r.update(draft=True),lambda r:r.update(prerelease=True),
                       lambda r:r['assets'][0].update(digest=''),
                       lambda r:r['assets'][0].update(browser_download_url='https://github.com/other/file'),
                       lambda r:r['assets'][0].update(size=knowledge.MAX_PACKAGE+1)):
            bad=copy.deepcopy(row);mutate(bad);self.assertIsNone(knowledge.candidate([bad],'xid','1.0.0'))
        self.assertIsNone(knowledge.candidate([row],'manual','1.0.0'))
        self.assertIsNone(knowledge.candidate([row],'xid','1.0.1'))

    def test_cancel_and_concurrent_actions_keep_previous_data(self):
        pack=self.updated('manual');raw=self.check('manual',pack);gate=threading.Event();entered=threading.Event()
        original=copy.deepcopy(self.store.data['manual'])
        def slow(*args,**kwargs):entered.set();gate.wait(5);return raw
        with patch('knowledge.download',side_effect=slow):
            self.store.start('manual','apply');self.assertTrue(entered.wait(2))
            with self.assertRaises(ValueError):self.store.start('manual','check')
            self.store.start('manual','cancel');gate.set();self.store.threads['manual'].join(5)
        self.assertEqual(self.store.data['manual'],original)
        self.assertFalse((self.root/'knowledge/manual/active.json').exists())

    def test_corrupted_active_falls_back_without_deleting_file(self):
        pack=self.updated('manual');self.apply('manual',self.check('manual',pack))
        second=copy.deepcopy(pack);second['version']='1.0.2';self.apply('manual',self.check('manual',second))
        path=self.root/'knowledge/manual/active.json';path.write_text('{broken')
        loaded=knowledge.KnowledgeStore(self.root)
        self.assertEqual(loaded.data['manual'],pack);self.assertTrue(loaded.warning['manual']);self.assertEqual(path.read_text(),'{broken')

    def test_schema_valid_tampering_fails_saved_checksum(self):
        pack=self.updated('xid');self.apply('xid',self.check('xid',pack))
        path=self.root/'knowledge/xid/active.json';saved=json.loads(path.read_bytes())
        saved['package']['content']['cn']['codes']['79']['title']='modified';path.write_text(json.dumps(saved))
        loaded=knowledge.KnowledgeStore(self.root)
        self.assertEqual(loaded.data['xid']['version'],'1.0.0');self.assertTrue(loaded.warning['xid'])

    def test_rules_and_reports_are_not_modified(self):
        for name in ('rules/active.json','results/report.json'):
            path=self.root/name;path.parent.mkdir(parents=True);path.write_bytes(b'keep unchanged')
        for kind in knowledge.KINDS:self.apply(kind,self.check(kind,self.updated(kind)))
        for name in ('rules/active.json','results/report.json'):self.assertEqual((self.root/name).read_bytes(),b'keep unchanged')

    def test_api_requires_token_and_rejects_cross_origin(self):
        spec=importlib.util.spec_from_file_location('knowledge_test_server',Path(__file__).resolve().parents[1]/'app/server.py')
        server=importlib.util.module_from_spec(spec)
        with patch.dict(os.environ,{'GPU_LOG_DATA_DIR':str(self.root)}):spec.loader.exec_module(server)
        service=server.LocalService(0);service.start();opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
        try:
            for headers in ({},{'X-Local-Token':server.TOKEN,'Origin':'https://other.test'}):
                request=urllib.request.Request(service.url+'api/knowledge/xid/check',data=b'',headers=headers)
                with self.assertRaises(urllib.error.HTTPError) as error:opener.open(request)
                self.assertEqual(error.exception.code,403)
            request=urllib.request.Request(service.url+'api/knowledge/content',headers={'X-Local-Token':server.TOKEN})
            with opener.open(request) as response:self.assertEqual(json.load(response)['packages']['manual']['version'],'1.0.0')
        finally:service.close()
