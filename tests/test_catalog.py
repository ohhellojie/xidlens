import copy, hashlib, io, json, os, tempfile, unittest, zipfile
from pathlib import Path
from unittest.mock import patch
from test_parser import parser, SAMPLE
import catalog


def rule(title='示例说明'):
    return {'file':'example.xlsx','sha256':'a'*64,'codes':{'79':{'title':title,'description':'第一段\n\n第二段','row':2,'sheet':'Xids','actions':[{'key':'CHECK','label':'检查','text':'查看原始日志'}]}}}


def xlsx_bytes(duplicate=False):
    import openpyxl
    book=openpyxl.Workbook();sheet=book.active;sheet.title='Xids'
    sheet.append(['group','id','symbol','title','A100','H100','B100','GB200','next','after','154','description'])
    row=['',79,'DEMO','示例说明','','','','','CHECK','','','第一段\n\n第二段'];sheet.append(row)
    if duplicate:sheet.append(row)
    buckets=book.create_sheet('Resolution Buckets');buckets.append(['key','text']);buckets.append(['CHECK','查看原始日志'])
    out=io.BytesIO();book.save(out);book.close();return out.getvalue()


class CatalogTests(unittest.TestCase):
    def test_xlsx_retains_source_rows_and_actions(self):
        raw=xlsx_bytes();d=catalog.parse_upload(raw,'rules.xlsx')
        self.assertEqual(d['sha256'],hashlib.sha256(raw).hexdigest())
        self.assertEqual(d['codes']['79']['row'],2)
        self.assertEqual(d['codes']['79']['actions'][0]['text'],'查看原始日志')
        self.assertEqual(d['codes']['79']['description'],'第一段\n\n第二段')
    def test_json_hash_distinguishes_import_file_from_declared_source(self):
        raw=json.dumps(rule()).encode();d=catalog.parse_upload(raw,'rules.json')
        self.assertEqual(d['sha256'],hashlib.sha256(raw).hexdigest());self.assertEqual(d['sourceSha256'],'a'*64)
        self.assertEqual(d['importFile'],'rules.json');self.assertEqual(d['file'],'example.xlsx')
    def test_invalid_files_and_duplicate_codes_are_rejected(self):
        for raw,name in [(b'{}','rules.json'),(b'{','rules.json'),(b'no','rules.xlsx'),(b'{}','rules.txt'),(b'{"codes":{"79":{},"79":{}}}','rules.json'),(xlsx_bytes(True),'rules.xlsx')]:
            with self.subTest(name=name),self.assertRaises(ValueError):catalog.parse_upload(raw,name)
        for codes in ({'079':{}},{'-1':{}},{'79':{'actions':'bad'}},{'79':{'title':[]}}):
            with self.assertRaises(ValueError):catalog.parse_upload(json.dumps({'codes':codes}).encode(),'rules.json')
    def test_xml_entities_are_rejected(self):
        buf=io.BytesIO()
        with zipfile.ZipFile(buf,'w') as archive:archive.writestr('xl/workbook.xml','<!DOCTYPE x [<!ENTITY y SYSTEM "file:///secret">]><x>&y;</x>')
        with self.assertRaisesRegex(ValueError,'XML'):catalog.parse_upload(buf.getvalue(),'rules.xlsx')
    def test_failed_import_and_save_preserve_active_rules_on_disk(self):
        with tempfile.TemporaryDirectory() as folder:
            store=catalog.CatalogStore(folder);store.import_file(json.dumps(rule()).encode(),'rules.json');old=store.path.read_bytes();before=store.snapshot()
            with self.assertRaises(ValueError):store.import_file(b'{}','invalid.json')
            self.assertEqual(store.path.read_bytes(),old)
            with patch.object(Path,'replace',side_effect=OSError('full')):
                with self.assertRaises(OSError):store.import_file(json.dumps(rule('changed')).encode(),'changed.json')
            self.assertEqual(store.snapshot(),before);self.assertEqual(store.path.read_bytes(),old)
            self.assertEqual(list(store.path.parent.glob('*.pending')),[])
    def test_restart_reset_and_corrupt_saved_rules(self):
        with tempfile.TemporaryDirectory() as folder:
            store=catalog.CatalogStore(folder);store.import_file(xlsx_bytes(),'rules.xlsx')
            self.assertEqual(catalog.CatalogStore(folder).info(),store.info())
            store.reset();self.assertEqual(catalog.CatalogStore(folder).info()['count'],len(catalog.DEFAULT['codes']))
            store.path.write_text('invalid');restored=catalog.CatalogStore(folder)
            self.assertEqual(restored.info()['count'],len(catalog.DEFAULT['codes']));self.assertTrue(restored.info()['warning'])
    def test_startup_bad_local_file_does_not_break_parser(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);(root/'xid_catalog.local.json').write_text('bad')
            with patch.dict(os.environ,{},clear=True):d,warning=catalog.initial_catalog(root,root)
            self.assertEqual(d['codes'],catalog.DEFAULT['codes']);self.assertTrue(warning)
    def test_snapshot_is_stable_when_new_rules_are_imported(self):
        with tempfile.TemporaryDirectory() as folder:
            store=catalog.CatalogStore(folder);store.import_file(json.dumps(rule('A')).encode(),'a.json');snap=store.snapshot()
            store.import_file(json.dumps(rule('B')).encode(),'b.json')
            source=parser.Parser('sample.log').parse(io.BytesIO(SAMPLE.encode()))
            report=parser.convert(source,catalog=snap)
            self.assertEqual(next(e for e in report['events'] if e['code']=='79')['title'],'A')
            self.assertEqual(store.snapshot()['codes']['79']['title'],'B')


class CatalogApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import importlib.util, urllib.request
        cls.temp=tempfile.TemporaryDirectory()
        spec=importlib.util.spec_from_file_location('catalog_test_server',Path(__file__).resolve().parents[1]/'app/server.py')
        cls.server=importlib.util.module_from_spec(spec)
        with patch.dict(os.environ,{'GPU_LOG_DATA_DIR':cls.temp.name}):spec.loader.exec_module(cls.server)
        cls.service=cls.server.LocalService(0);cls.service.start()
        cls.opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
    @classmethod
    def tearDownClass(cls):cls.service.close();cls.temp.cleanup()
    def request(self,path,body=None,headers=None):
        import urllib.request
        req=urllib.request.Request(self.service.url+path,data=body,headers=headers if headers is not None else {'X-Local-Token':self.server.TOKEN})
        with self.opener.open(req,timeout=5) as r:return json.load(r)
    def test_api_import_failure_preserves_rules_and_reset_is_persistent(self):
        import urllib.error
        current=self.request('api/catalog/import?name=rules.xlsx',xlsx_bytes())
        self.assertEqual(current['count'],1)
        self.assertEqual(self.request('api/catalog/rules')['rules'][0]['code'],'79')
        for raw in (b'{}',b'not json'):
            with self.assertRaises(urllib.error.HTTPError) as error:self.request('api/catalog/import?name=broken.json',raw)
            self.assertEqual(error.exception.code,400);self.assertEqual(self.request('api/catalog'),current)
        self.assertEqual(catalog.CatalogStore(self.temp.name).info(),current)
        self.request('api/catalog/reset',b'')
        self.assertEqual(catalog.CatalogStore(self.temp.name).info()['count'],len(catalog.DEFAULT['codes']))
    def test_api_rules_require_session_and_same_origin(self):
        import urllib.error
        for path,body in [('api/catalog',None),('api/catalog/rules',None),('api/catalog/import?name=rules.json',b'{}'),('api/catalog/reset',b'')]:
            with self.assertRaises(urllib.error.HTTPError) as error:self.request(path,body,headers={})
            self.assertEqual(error.exception.code,403)
        with self.assertRaises(urllib.error.HTTPError) as error:self.request('api/catalog/reset',b'',headers={'X-Local-Token':self.server.TOKEN,'Origin':'https://example.com'})
        self.assertEqual(error.exception.code,403)

    def test_online_api_authentication_and_settings(self):
        import urllib.error
        self.assertFalse(self.request('api/online')['settings']['automatic'])
        for path,body in [('api/online',None),('api/online/check-app',b''),('api/online/enable',b'')]:
            with self.assertRaises(urllib.error.HTTPError) as error:self.request(path,body,headers={})
            self.assertEqual(error.exception.code,403)
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.request('api/online/enable',b'',headers={'X-Local-Token':self.server.TOKEN,'Origin':'https://example.com'})
        self.assertEqual(error.exception.code,403)
        self.assertTrue(self.request('api/online/enable',b'')['settings']['automatic'])
        self.assertFalse(self.request('api/online/disable',b'')['settings']['automatic'])
        with self.assertRaises(urllib.error.HTTPError) as error:self.request('api/online/unknown',b'')
        self.assertEqual(error.exception.code,400)
