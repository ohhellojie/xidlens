"""Check tracked source files for common local-data mistakes."""
from pathlib import Path
import re
import subprocess

root = Path(__file__).resolve().parent.parent
try:
    names = subprocess.check_output(['git', '-C', str(root), 'ls-files', '-z']).decode().split('\0')
except (OSError, subprocess.CalledProcessError):
    names = [str(p.relative_to(root)).replace('\\', '/') for p in root.rglob('*') if p.is_file()]
errors = []
for name in filter(None, names):
    p = root/name
    if any(part in {'runtime', 'results', 'uploads', '.venv', '__pycache__', '.git'} for part in p.relative_to(root).parts):
        errors.append(name + ': local directory')
        continue
    if p.suffix.lower() in {'.log', '.gz', '.zip', '.tar', '.xlsx', '.xls', '.exe', '.dll'} or name.endswith('.local.json'):
        errors.append(name + ': local artifact')
        continue
    if name in {'app/logo.png', 'docs/images/devices.png', 'docs/images/errors.png', 'docs/images/topology.png'}:
        if not p.read_bytes().startswith(b'\x89PNG\r\n\x1a\n'):
            errors.append(name + ': invalid PNG')
        continue
    try:
        text = p.read_text(encoding='utf-8')
    except UnicodeDecodeError:
        errors.append(name + ': unexpected binary file')
        continue
    if re.search(r'(?i)[A-Z]:[\\/]Users[\\/]|/(?:home|Users)/[A-Za-z0-9_.-]+/', text):
        errors.append(name + ': user path')
    if re.search(r'(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)', text):
        errors.append(name + ': credential-like value')
if errors:
    raise SystemExit('\n'.join(errors))
print('Tracked source check passed')
