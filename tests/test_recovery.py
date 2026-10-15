import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'app'))
import recovery


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        for name in ('results','uploads','sources'):(self.root/name).mkdir()
        self.folder=self.root/'uploads'/('a'*32);self.folder.mkdir()
        self.old=self.root/'results'/('b'*32+'.json');self.old.write_text('{"source":"old"}')
        self.new=self.root/'results'/('c'*32+'.json')
    def tearDown(self):self.temp.cleanup()

    def test_process_exit_at_each_publish_boundary_restores_atomic_batch(self):
        for phase in ('prepared','first','second','committed'):
            with self.subTest(phase=phase):
                self.folder.mkdir(exist_ok=True);self.old.write_text('{"source":"old"}');self.new.unlink(missing_ok=True)
                script="""
import os,sys,json
from pathlib import Path
import recovery
root=Path(sys.argv[1]);folder=root/'uploads'/('a'*32);phase=sys.argv[2]
ids=['b'*32,'c'*32]
for key in ids:(folder/(key+'.pending')).write_text('{"source":"new"}')
recovery.prepare(folder,root/'results',ids)
if phase=='prepared':os._exit(0)
(folder/(ids[0]+'.pending')).replace(root/'results'/(ids[0]+'.json'))
if phase=='first':os._exit(0)
(folder/(ids[1]+'.pending')).replace(root/'results'/(ids[1]+'.json'))
if phase=='second':os._exit(0)
recovery.settle(folder,root/'results',commit=True)
os._exit(0)
"""
                env=os.environ.copy();env['PYTHONPATH']=str(Path(recovery.__file__).parent)
                subprocess.run([sys.executable,'-c',script,str(self.root),phase],env=env,check=True,timeout=10)
                result=recovery.recover(self.root)
                self.assertEqual(result['pending'],0)
                self.assertEqual(json.loads(self.old.read_text())['source'],'new' if phase=='committed' else 'old')
                self.assertEqual(self.new.exists(),phase=='committed')
                self.assertFalse(self.folder.exists())
                self.assertEqual(recovery.recover(self.root)['recovered'],0)

    def test_interrupted_rollback_is_retryable_and_keeps_backups(self):
        recovery.prepare(self.folder,self.root/'results',[self.old.stem,self.new.stem])
        self.old.write_text('{"source":"new"}');self.new.write_text('{}')
        replace=Path.replace
        def fail(source,target):
            if source.suffix=='.restore':raise PermissionError('busy')
            return replace(source,target)
        with patch.object(Path,'replace',fail):self.assertEqual(recovery.recover(self.root)['pending'],1)
        self.assertTrue((self.folder/(self.old.stem+'.backup')).exists())
        self.assertEqual(recovery.recover(self.root)['recovered'],1)
        self.assertEqual(json.loads(self.old.read_text())['source'],'old');self.assertFalse(self.new.exists())

    def test_legacy_missing_result_recovers_without_replacing_valid_result(self):
        (self.folder/(self.old.stem+'.backup')).write_text('{"source":"older"}')
        (self.folder/(self.new.stem+'.backup')).write_text('{"source":"recovered"}')
        self.assertEqual(recovery.recover(self.root)['recovered'],1)
        self.assertEqual(json.loads(self.old.read_text())['source'],'old')
        self.assertEqual(json.loads(self.new.read_text())['source'],'recovered')

    def test_corrupt_report_preserves_all_sources(self):
        self.old.write_text('{broken')
        source=self.root/'sources'/('d'*32);source.write_text('original')
        recovery.recover(self.root)
        self.assertEqual(self.old.read_text(),'{broken');self.assertEqual(source.read_text(),'original')

    def test_only_unreferenced_owned_sources_are_removed(self):
        used=self.root/'sources'/('d'*32);used.write_text('used')
        orphan=self.root/'sources'/('e'*32);orphan.write_text('partial copy')
        unknown=self.root/'sources'/'notes.txt';unknown.write_text('keep')
        self.old.write_text(json.dumps({'input':{'key':used.name}}))
        recovery.recover(self.root)
        self.assertTrue(used.exists());self.assertTrue(unknown.exists());self.assertFalse(orphan.exists())

    def test_invalid_transaction_is_retained_and_cannot_escape(self):
        outside=self.root/'keep.json';outside.write_text('keep')
        recovery.write_json(self.folder/'transaction.json',{'state':'prepared','entries':[{'id':'../../keep','existed':False}]})
        self.assertEqual(recovery.recover(self.root)['pending'],1)
        self.assertEqual(outside.read_text(),'keep');self.assertTrue(self.folder.exists())
