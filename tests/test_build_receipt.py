import hashlib
import importlib.util
import json
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

import certifi


spec = importlib.util.spec_from_file_location('build_receipt', Path(__file__).resolve().parents[1] / 'tools/build_receipt.py')
receipt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(receipt)


class BuildReceiptTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        for name in ('app/online.py', 'requirements-desktop.txt', 'requirements-build.txt',
                     'tools/build_windows.py', 'tools/build_receipt.py', 'tools/privacy_guard.py',
                     '.privacy-policy.json', 'packaging/windows-version.txt',
                     'dist/XidLens.exe'):
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b'fixture')
        self.ca = Path(certifi.where()).read_bytes()
        self.archive = types.SimpleNamespace(toc={'certifi\\cacert.pem': None}, extract=lambda name: self.ca)
        reader = types.ModuleType('PyInstaller.archive.readers')
        reader.CArchiveReader = lambda name: self.archive
        self.modules = patch.dict('sys.modules', {'PyInstaller.archive.readers': reader})
        self.modules.start()
        self.addCleanup(self.modules.stop)
        receipt.write(self.root)

    def test_accepts_current_build_and_windows_archive_path(self):
        receipt.verify(self.root)
        self.archive.toc = {'certifi/cacert.pem': None}
        receipt.verify(self.root)

    def test_rejects_stale_source_and_replaced_executable(self):
        for name in ('app/online.py', 'tools/privacy_guard.py', '.privacy-policy.json', 'dist/XidLens.exe'):
            with self.subTest(name=name):
                path = self.root / name
                path.write_bytes(b'changed')
                with self.assertRaisesRegex(ValueError, 'rebuild before packaging'):
                    receipt.verify(self.root)
                path.write_bytes(b'fixture')

    def test_rejects_outdated_dependency_receipt(self):
        path = self.root / 'dist/build-receipt.json'
        value = json.loads(path.read_text(encoding='utf-8'))
        value['certifi_version'] = '2026.7.22'
        path.write_text(json.dumps(value), encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'outdated CA dependency'):
            receipt.verify(self.root)

    def test_rejects_missing_or_ambiguous_packaged_ca(self):
        for names in ({}, {'certifi/cacert.pem': None, 'certifi\\cacert.pem': None}):
            with self.subTest(names=names):
                self.archive.toc = names
                with self.assertRaisesRegex(ValueError, 'missing or ambiguous'):
                    receipt.verify(self.root)

    def test_rejects_replaced_packaged_ca(self):
        self.archive.extract = lambda name: b'old CA set'
        with self.assertRaisesRegex(ValueError, 'does not match'):
            receipt.verify(self.root)

    def test_rejects_ca_changed_since_build(self):
        with tempfile.TemporaryDirectory() as folder:
            changed = Path(folder) / 'cacert.pem'
            changed.write_bytes(b'changed CA set')
            with patch('certifi.where', return_value=str(changed)):
                with self.assertRaisesRegex(ValueError, 'does not match'):
                    receipt.verify(self.root)


if __name__ == '__main__':
    unittest.main()
