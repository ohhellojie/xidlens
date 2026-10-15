import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock,patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'app'))
import update_install as updater


class UpdateRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.folder=self.root/'runtime/updater'/('a'*32);self.folder.mkdir(parents=True)
        self.target=self.root/'XidLens.exe';self.target.write_bytes(b'new')
        self.backup=self.folder/'XidLens.previous.exe';self.backup.write_bytes(b'old')
        self.path=self.folder/'install.json'
        self.data={'target':str(self.target),'token':'b'*32,'sha256':updater.digest(self.target)}
        self.path.write_text(json.dumps(self.data))
        self.report=self.root/'runtime/report.json';self.report.write_text('saved report')
    def tearDown(self):self.temp.cleanup()

    def test_launch_error_rolls_back_executable_and_preserves_data(self):
        with patch.object(updater.subprocess,'Popen',side_effect=OSError('cannot start')):
            with self.assertRaises(OSError):updater.restart_verified(self.target,self.backup,self.path,self.data)
        self.assertEqual(self.target.read_bytes(),b'old');self.assertEqual(self.report.read_text(),'saved report')
        self.assertEqual(json.loads((self.folder/'result.json').read_text())['state'],'rolledback')

    def test_early_exit_and_timeout_roll_back(self):
        for status in (1,None):
            with self.subTest(status=status):
                self.target.write_bytes(b'new');process=Mock();process.poll.return_value=status
                with patch.object(updater.subprocess,'Popen',return_value=process),patch.object(updater,'stop_child') as stop:
                    with self.assertRaises(RuntimeError):updater.restart_verified(self.target,self.backup,self.path,self.data,timeout=.01)
                    stop.assert_called_once_with(process)
                self.assertEqual(self.target.read_bytes(),b'old')

    def test_ready_handshake_keeps_new_executable(self):
        process=Mock();process.poll.return_value=None
        def start(*args,**kwargs):
            with patch.dict(updater.os.environ,kwargs['env']):updater.mark_ready(self.root)
            return process
        with patch.object(updater.subprocess,'Popen',side_effect=start):
            self.assertIs(updater.restart_verified(self.target,self.backup,self.path,self.data),process)
        self.assertEqual(self.target.read_bytes(),b'new');self.assertEqual(self.backup.read_bytes(),b'old')
        self.assertEqual(json.loads((self.folder/'result.json').read_text())['state'],'installed')

    def test_modified_target_is_not_overwritten_on_failure(self):
        def start(*args,**kwargs):self.target.write_bytes(b'another update');raise OSError('failed')
        with patch.object(updater.subprocess,'Popen',side_effect=start):
            with self.assertRaises(ValueError):updater.restart_verified(self.target,self.backup,self.path,self.data)
        self.assertEqual(self.target.read_bytes(),b'another update');self.assertTrue(self.backup.exists())

    def test_receipt_outside_updater_directory_is_ignored(self):
        receipt=self.root/'ready.json'
        with patch.dict(updater.os.environ,{'XIDLENS_UPDATE_RECEIPT':str(receipt)}):updater.mark_ready(self.root)
        self.assertFalse(receipt.exists())
