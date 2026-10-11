"""Windows GUI entry: preserve startup errors for a double-click launch."""
import os
import sys
import traceback
from pathlib import Path

if __name__ == '__main__':
    try:
        import server
        server.main()
    except Exception:
        app_home = Path(sys.executable).resolve().parent if getattr(sys, 'frozen', False) else Path(__file__).resolve().parent
        log = Path(os.environ.get('GPU_LOG_DATA_DIR', str(app_home / 'runtime'))) / 'startup-error.log'
        try:
            log.parent.mkdir(parents=True, exist_ok=True)
            log.write_text(traceback.format_exc(), encoding='utf-8')
            detail = f'启动失败，请将以下文件发给开发者：\n{log}'
        except OSError:
            detail = '启动失败。请将程序放到有写入权限的文件夹后重试。'
        if '--no-browser' not in sys.argv:
            import ctypes
            ctypes.windll.user32.MessageBoxW(None, detail, 'XidLens', 0x10)
        sys.exit(1)
