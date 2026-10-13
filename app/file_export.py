"""Save exported text without changing line endings or truncating old files."""
import os
import tempfile
from pathlib import Path


def save_export(path, text):
    target = Path(path)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8-sig', newline='',
                                         dir=target.parent, prefix='.xidlens-',
                                         suffix='.pending', delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(target)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
