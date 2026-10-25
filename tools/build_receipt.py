"""Bind a release executable to the current TLS policy and build sources."""
import hashlib
import json
from pathlib import Path


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def sources(root):
    paths = list((root / 'app').rglob('*.py'))
    paths += [root / name for name in ('requirements-desktop.txt', 'requirements-build.txt',
              'tools/build_windows.py', 'tools/build_receipt.py', 'tools/privacy_guard.py',
              '.privacy-policy.json', 'packaging/windows-version.txt')]
    return {p.relative_to(root).as_posix(): sha(p) for p in sorted(paths)}


def write(root):
    import certifi
    value = {'exe_sha256': sha(root / 'dist/XidLens.exe'), 'sources': sources(root),
             'certifi_version': certifi.__version__, 'ca_sha256': sha(certifi.where())}
    (root / 'dist/build-receipt.json').write_text(json.dumps(value, indent=2) + '\n', encoding='utf-8')


def verify(root):
    import certifi
    from PyInstaller.archive.readers import CArchiveReader
    value = json.loads((root / 'dist/build-receipt.json').read_text(encoding='utf-8'))
    if value['sources'] != sources(root) or value['exe_sha256'] != sha(root / 'dist/XidLens.exe'):
        raise ValueError('Executable or source changed; rebuild before packaging')
    if tuple(map(int, value['certifi_version'].split('.'))) < (2026, 10, 19):
        raise ValueError('Build uses an outdated CA dependency')
    archive = CArchiveReader(str(root / 'dist/XidLens.exe'))
    entries = [name for name in archive.toc if name.replace('\\', '/') == 'certifi/cacert.pem']
    if len(entries) != 1:
        raise ValueError('Packaged CA set is missing or ambiguous')
    digest = hashlib.sha256(archive.extract(entries[0])).hexdigest()
    if digest != value['ca_sha256'] or digest != sha(certifi.where()):
        raise ValueError('Packaged CA set does not match the checked build')
