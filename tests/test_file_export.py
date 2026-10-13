import codecs
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'app'))
from file_export import save_export


class FileExportTests(unittest.TestCase):
    def test_exact_utf8_bom_and_line_endings_for_all_formats(self):
        with tempfile.TemporaryDirectory() as folder:
            for name,text in [('设备.tsv','SN\tUUID\r\n显卡一\tGPU-DEMO'),
                              ('摘要.txt','日志：样例\nXid 79'),
                              ('记录.json',json.dumps({'标题':'样例'},ensure_ascii=False))]:
                with self.subTest(name=name):
                    target=Path(folder)/name
                    save_export(target,text)
                    self.assertEqual(target.read_bytes(),codecs.BOM_UTF8+text.encode('utf-8'))
    def test_failed_write_preserves_old_file_and_cleans_pending_file(self):
        with tempfile.TemporaryDirectory() as folder:
            target=Path(folder)/'已有.tsv';target.write_bytes(b'old export')
            with patch('file_export.os.fsync',side_effect=OSError('disk full')):
                with self.assertRaises(OSError):save_export(target,'new data')
            self.assertEqual(target.read_bytes(),b'old export')
            self.assertEqual(list(Path(folder).iterdir()),[target])
    def test_failed_replace_preserves_old_file_and_success_replaces_it(self):
        with tempfile.TemporaryDirectory() as folder:
            target=Path(folder)/'已有.json';target.write_bytes(b'old export')
            with patch.object(Path,'replace',side_effect=PermissionError('locked')):
                with self.assertRaises(PermissionError):save_export(target,'new data')
            self.assertEqual(target.read_bytes(),b'old export')
            self.assertEqual(list(Path(folder).iterdir()),[target])
            save_export(target,'new data')
            self.assertEqual(target.read_text(encoding='utf-8-sig'),'new data')
    def test_missing_directory_does_not_leave_a_file(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(OSError):save_export(Path(folder)/'missing'/'export.txt','data')
            self.assertEqual(list(Path(folder).iterdir()),[])
