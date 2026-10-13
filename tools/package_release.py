"""Package only the EXE, instructions, and licenses; never runtime data."""
import hashlib
import importlib.metadata
from pathlib import Path
import sys
import zipfile

VERSION = '0.5.0'

def main():
    root = Path(__file__).resolve().parent.parent
    exe = root/'dist/XidLens.exe'
    if not exe.is_file():
        raise SystemExit('Build dist/XidLens.exe first.')
    out = root/'dist/release'
    out.mkdir(parents=True, exist_ok=True)
    import shutil
    shutil.copy2(exe, out/'XidLens.exe')
    files = {'XidLens.exe': exe,
             '使用说明.txt': root/'packaging/使用说明.txt',
             'LICENSE': root/'LICENSE', 'NOTICE.md': root/'NOTICE.md'}
    python_home = Path(sys.base_prefix)
    for name in ('LICENSE.txt', 'LICENSE'):
        candidate = python_home/name
        if candidate.is_file():
            files['licenses/PYTHON-LICENSE.txt'] = candidate
            break
    for name, folder in (('TCL-LICENSE.txt', 'tcl/tcl8.6'), ('TK-LICENSE.txt', 'tcl/tk8.6')):
        candidate = python_home/folder/'license.terms'
        if candidate.is_file():
            files['licenses/'+name] = candidate
    distribution = importlib.metadata.distribution('pyinstaller')
    for item in distribution.files or []:
        if str(item).endswith('COPYING.txt'):
            files['licenses/PYINSTALLER-COPYING.txt'] = Path(distribution.locate_file(item))
            break
    for project in ('pywebview','pythonnet','clr_loader','cffi','pycparser','typing_extensions','bottle','proxy_tools'):
        distribution=importlib.metadata.distribution(project)
        for item in distribution.files or []:
            if Path(str(item)).name.lower().startswith(('license','copying','authors')):
                files['licenses/'+project+'/'+Path(str(item)).name]=Path(distribution.locate_file(item))
    archive = out/f'XidLens_v{VERSION}_Windows_x64.zip'
    with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED) as z:
        for name, source in files.items():
            z.write(source, 'XidLens/'+name)
    with zipfile.ZipFile(archive) as z:
        assert z.testzip() is None
        assert z.read('XidLens/XidLens.exe') == exe.read_bytes()
        assert len(z.namelist()) == len(files)
    hashes = []
    for file in (out/'XidLens.exe', archive):
        with file.open('rb') as stream:
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        hashes.append(f'{digest}  {file.name}')
    (out/'SHA256SUMS.txt').write_text('\n'.join(hashes)+'\n', encoding='ascii')
    print(f'Release package verified: {archive.name}; {len(files)} files; no runtime or catalog included')

if __name__ == '__main__':
    main()
