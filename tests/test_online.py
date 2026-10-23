import hashlib,json,ssl,tempfile,threading,time,unittest
from pathlib import Path
from unittest.mock import patch
from test_catalog import rule,xlsx_bytes
import catalog,online,update_install


def release(tag='v0.9.0',raw=b'MZtest',draft=False):
 return {'tag_name':tag,'draft':draft,'prerelease':True,'body':'New version', 'assets':[{'name':'XidLens.exe','size':len(raw),'digest':'sha256:'+hashlib.sha256(raw).hexdigest(),'browser_download_url':f'https://github.com/ohhellojie/xidlens/releases/download/{tag}/XidLens.exe'}]}


class OnlineTests(unittest.TestCase):
 def test_download_uses_packaged_ca_context_without_system_roots(self):
  with patch('online.ssl.create_default_context', wraps=ssl.create_default_context) as create:
   context=online.tls_context()
  create.assert_called_once_with(cafile=online.certifi.where())
  self.assertTrue(context.check_hostname)
  self.assertEqual(context.verify_mode,ssl.CERT_REQUIRED)
  with patch('online.certifi.__version__','2026.7.22'):
   with self.assertRaisesRegex(ValueError,'证书库版本过旧'):online.tls_context()
 def test_https_context_reaches_shared_download_opener(self):
  with patch('online.urllib.request.build_opener') as build:
   response=build.return_value.open.return_value.__enter__.return_value
   response.url='https://api.github.com/test';response.headers={}
   response.read.side_effect=[b'ok',b'']
   self.assertEqual(online.download(response.url,10),b'ok')
  handlers=build.call_args.args
  self.assertIsInstance(handlers[0],online.Redirects)
  self.assertIsInstance(handlers[1],online.urllib.request.HTTPSHandler)
  self.assertTrue(handlers[1]._context.check_hostname)
 def test_malformed_release_entries_do_not_hide_valid_update(self):
  rows=[None,42,{'assets':None,'tag_name':'v9.0.0'},release('v9.0.1'),release('v9.0.2'),release('v9.0.3')]
  rows[3]['assets']=[None,42];rows[4]['assets'][0]['digest']={};rows[5]['assets'][0].pop('size')
  self.assertEqual(online.select_release(rows+[release('v2.0.0')],current='1.0.0')['version'],'v2.0.0')
  with self.assertRaises(ValueError):online.select_release({'message':'unavailable'})
 def test_version_order_and_asset_origin(self):
  self.assertLess(online.version_key('0.9.0-preview.9'),online.version_key('0.9.0'))
  self.assertGreater(online.version_key('0.10.0'),online.version_key('0.9.9'))
  self.assertIsNone(online.select_release([release('v0.7.0')],current='0.8.0'))
  self.assertIsNone(online.select_release([release(draft=True)],current='0.8.0'))
  self.assertEqual(online.select_release([release('v0.9.0'),release('v0.10.0')],current='0.8.0')['version'],'v0.10.0')
  bad=release();bad['assets'][0]['browser_download_url']='https://github.com/someone/other/tool.exe'
  self.assertIsNone(online.select_release([bad],current='0.8.0'))
  bad=release();bad['assets'][0]['digest']=''
  self.assertIsNone(online.select_release([bad],current='0.8.0'))
 def test_https_redirect_allowlist(self):
  for url in ['http://docs.nvidia.com/x','https://evil.test/x','https://github.com@evil.test/x','https://github.com:8080/x']:
   with self.assertRaises(ValueError):online.safe_url(url)
  self.assertEqual(online.safe_url('https://release-assets.githubusercontent.com/x'),'https://release-assets.githubusercontent.com/x')
 def test_official_catalog_validates_link_and_retains_source(self):
  with patch('online.download',side_effect=[b'<a href="_downloads/a/Xid-Catalog.xlsx">Download</a>',xlsx_bytes()]):
   result=online.official_catalog()
  self.assertEqual(result['provider'],'NVIDIA');self.assertEqual(result['language'],'en')
  self.assertEqual(catalog.validate(result)['sourceUrl'],online.CATALOG_PAGE)
  with patch('online.download',return_value=b'<a href="https://evil.test/Xid-Catalog.xlsx">x</a>'):
   with self.assertRaises(ValueError):online.official_catalog()
 def test_rules_check_never_replaces_custom_rules(self):
  with tempfile.TemporaryDirectory() as folder:
   store=catalog.CatalogStore(folder);store.import_file(json.dumps(rule()).encode(),'chinese.json');before=store.path.read_bytes()
   updates=online.OnlineUpdates(folder,store)
   with patch('online.official_catalog',return_value=catalog.parse_upload(xlsx_bytes(),'official.xlsx')):updates.run('check-rules','rules')
   self.assertEqual(store.path.read_bytes(),before);self.assertEqual(updates.snapshot()['rules']['state'],'available')
   with patch.object(store,'apply',side_effect=OSError('full')):updates.run('apply-rules','rules')
   self.assertEqual(store.path.read_bytes(),before);self.assertEqual(updates.snapshot()['rules']['state'],'error')
   updates.run('apply-rules','rules');self.assertEqual(store.info()['file'],'official.xlsx')
   self.assertEqual(catalog.CatalogStore(folder).info(),store.info())
 def test_download_verification_cancellation_and_retry(self):
  with tempfile.TemporaryDirectory() as folder:
   updates=online.OnlineUpdates(folder,catalog.CatalogStore(folder));updates.release=online.select_release([release()],current='0.8.0')
   for raw in (b'MZwrong',b'garbage'):
    with patch('online.download',return_value=raw):updates.run('download-app','app')
    self.assertIsNone(updates.ready);self.assertEqual(updates.snapshot()['app']['state'],'error')
   updates.cancel.set()
   with patch('online.download',return_value=b'MZtest'):updates.run('download-app','app')
   self.assertIsNone(updates.ready)
   updates.cancel.clear()
   with patch('online.download',return_value=b'MZtest'):updates.run('download-app','app')
   self.assertEqual(updates.snapshot()['app']['state'],'ready');self.assertEqual(Path(updates.ready['path']).read_bytes(),b'MZtest')
 def test_settings_default_on_persist_and_failed_save(self):
  with tempfile.TemporaryDirectory() as folder:
   updates=online.OnlineUpdates(folder,catalog.CatalogStore(folder))
   self.assertTrue(updates.snapshot()['settings']['automatic'])
   updates.settings_save(False);self.assertFalse(online.OnlineUpdates(folder,updates.catalog).settings['automatic'])
   with patch.object(Path,'replace',side_effect=OSError('full')):
    with self.assertRaises(OSError):updates.settings_save(True)
   self.assertFalse(updates.settings['automatic'])
 def test_automatic_checks_are_daily_software_only_and_never_install(self):
  with tempfile.TemporaryDirectory() as folder:
   updates=online.OnlineUpdates(folder,catalog.CatalogStore(folder))
   with patch.object(updates,'start') as start:
    updates.check_due();self.assertEqual([c.args[0] for c in start.call_args_list],['check-app'])
    updates.check_due();self.assertEqual(start.call_count,1)
    updates.settings_save(False);updates.settings['lastCheck']=0
    updates.check_due();self.assertEqual(start.call_count,1)
 def test_update_notification_choices_persist_and_expire(self):
  with tempfile.TemporaryDirectory() as folder:
   updates=online.OnlineUpdates(folder,catalog.CatalogStore(folder))
   candidate=online.select_release([release('v9.0.0')])
   updates.release=candidate;updates.change('app',state='available',release=candidate)
   self.assertTrue(updates.snapshot()['app']['notify'])
   with patch('online.time.time',return_value=1000):updates.settings_save(dismissal='later',expected_version='v9.0.0')
   restored=online.OnlineUpdates(folder,updates.catalog);restored.release=candidate;restored.change('app',state='available',release=candidate)
   with patch('online.time.time',return_value=2000):self.assertFalse(restored.snapshot()['app']['notify'])
   with patch('online.time.time',return_value=90000):self.assertTrue(restored.snapshot()['app']['notify'])
   restored.settings_save(dismissal='ignore',expected_version='v9.0.0')
   self.assertFalse(restored.snapshot()['app']['notify'])
   self.assertEqual(online.OnlineUpdates(folder,updates.catalog).settings['ignoredVersion'],'v9.0.0')
   candidate=online.select_release([release('v9.0.1')]);restored.release=candidate;restored.change('app',state='available',release=candidate)
   self.assertTrue(restored.snapshot()['app']['notify'])
   with self.assertRaises(ValueError):restored.settings_save(dismissal='ignore',expected_version='v9.0.0')
   self.assertTrue(restored.snapshot()['app']['notify'])
   restored.settings_save(notify=False);self.assertFalse(restored.snapshot()['app']['notify'])
 def test_background_failure_and_unwritable_settings_do_not_repeat_or_notify(self):
  with tempfile.TemporaryDirectory() as folder:
   updates=online.OnlineUpdates(folder,catalog.CatalogStore(folder))
   with patch.object(updates,'settings_save',side_effect=PermissionError('readonly')),patch.object(updates,'start') as start:
    updates.check_due();updates.check_due();start.assert_called_once_with('check-app')
   with patch('online.download',side_effect=OSError('offline')):updates.run('check-app','app')
   self.assertEqual(updates.snapshot()['app']['state'],'error');self.assertFalse(updates.snapshot()['app']['notify'])
   self.assertFalse(updates.active)
   updates.settings['lastCheck']=0;updates.change('app',state='ready')
   with patch.object(updates,'start') as start:updates.check_due();start.assert_not_called()
 def test_duplicate_operation_rejected(self):
  with tempfile.TemporaryDirectory() as folder:
   updates=online.OnlineUpdates(folder,catalog.CatalogStore(folder));updates.active.add('app')
   with self.assertRaises(ValueError):updates.start('check-app')
 def test_checked_update_keeps_reports_and_backups(self):
  with tempfile.TemporaryDirectory() as folder:
   root=Path(folder);target=root/'XidLens.exe';target.write_bytes(b'old app');source=root/'new.exe';source.write_bytes(b'MZnew')
   runtime=root/'runtime';runtime.mkdir();report=runtime/'report.json';report.write_text('saved report')
   old=update_install.digest(target);new=update_install.digest(source)
   with patch.object(Path,'replace',side_effect=PermissionError('running')):
    with self.assertRaises(PermissionError):update_install.replace_verified(target,source,new,old,attempts=1)
   self.assertEqual(target.read_bytes(),b'old app')
   backup=update_install.replace_verified(target,source,new,old)
   self.assertEqual(target.read_bytes(),b'MZnew');self.assertEqual(backup.read_bytes(),b'old app');self.assertEqual(report.read_text(),'saved report')
 def test_modified_executable_or_download_is_not_installed(self):
  with tempfile.TemporaryDirectory() as folder:
   root=Path(folder);target=root/'XidLens.exe';target.write_bytes(b'old');source=root/'new.exe';source.write_bytes(b'MZnew')
   for new,old in [('0'*64,update_install.digest(target)),(update_install.digest(source),'0'*64)]:
    with self.assertRaises(ValueError):update_install.replace_verified(target,source,new,old)
    self.assertEqual(target.read_bytes(),b'old');self.assertTrue(source.exists())

if __name__=='__main__':unittest.main()
