"""Build a portable Windows GUI executable without machine-specific paths."""
import argparse
import os
from pathlib import Path
import subprocess
import sys

def main():
    if sys.platform != 'win32':
        raise SystemExit('Build this executable on Windows.')
    root = Path(__file__).resolve().parent.parent
    ap = argparse.ArgumentParser()
    ap.add_argument('--catalog', type=Path, default=root/'app/xid_catalog.json')
    args = ap.parse_args()
    if not args.catalog.is_file():
        ap.error('Catalog file not found')
    env = os.environ.copy()
    env['PYINSTALLER_CONFIG_DIR'] = str(root/'build/pyinstaller-cache')
    command = [sys.executable, '-m', 'PyInstaller', '--onefile', '--windowed', '--noupx',
               '--noconfirm', '--name', 'XidLens', '--icon', 'NONE',
               '--version-file', str(root/'packaging/windows-version.txt'), '--distpath', str(root/'dist'),
               '--workpath', str(root/'build/pyinstaller'), '--specpath', str(root/'build'),
               '--paths', str(root/'app')]
    for name in ('index.html', 'app.js'):
        command += ['--add-data', f'{root/"app"/name}:.']
    # A stage preserves the expected filename for optional local catalogs.
    import shutil
    stage = root/'build/catalog'
    stage.mkdir(parents=True, exist_ok=True)
    shutil.copy2(args.catalog, stage/'xid_catalog.json')
    command += ['--add-data', f'{stage/"xid_catalog.json"}:.',
                '--add-data', f'{root/"LICENSE"}:.', str(root/'app/main.py')]
    subprocess.run(command, cwd=root, env=env, check=True)

if __name__ == '__main__':
    main()
