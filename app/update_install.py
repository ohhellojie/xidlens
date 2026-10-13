"""Install a verified release after the desktop process exits."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import uuid


def digest(path):
    with Path(path).open('rb') as stream:return hashlib.file_digest(stream,'sha256').hexdigest()


def prepare(home, ready, executable=None):
    target=Path(executable or sys.executable).resolve()
    home=Path(home).resolve()
    if target.parent!=home:raise ValueError('程序位置不匹配')
    source=Path(ready['path']).resolve()
    if not source.is_file() or digest(source)!=ready['sha256']:raise ValueError('更新文件校验失败，请重新下载')
    folder=home/'runtime'/'updater'/uuid.uuid4().hex
    folder.mkdir(parents=True)
    # Run an independent copy so the original one-file executable can be replaced.
    helper=folder/'XidLens-updater.exe';shutil.copy2(target,helper)
    staged=folder/'XidLens.new.exe';shutil.copy2(source,staged)
    manifest={'target':str(target),'source':str(staged),'sha256':ready['sha256'],
              'oldSha256':digest(target),'pid':os.getpid()}
    path=folder/'install.json';path.write_text(json.dumps(manifest),encoding='utf-8')
    return helper,path


def launch(home,ready):
    if not getattr(sys,'frozen',False):raise ValueError('请在 Windows EXE 中安装更新')
    helper,path=prepare(home,ready)
    subprocess.Popen([str(helper),'--apply-update',str(path)],cwd=helper.parent,
                     creationflags=subprocess.CREATE_NO_WINDOW)


def replace_verified(target,source,expected,previous,attempts=120):
    target=Path(target);source=Path(source)
    if digest(source)!=expected:raise ValueError('更新文件校验失败')
    if digest(target)!=previous:raise ValueError('程序文件已变化，未执行更新')
    # Keep a recoverable copy; replace() does not remove the old target on failure.
    backup=source.parent/'XidLens.previous.exe';shutil.copy2(target,backup)
    for attempt in range(attempts):
        try:source.replace(target);return backup
        except PermissionError:
            if attempt+1==attempts:raise
            time.sleep(.5)


def apply(path):
    path=Path(path).resolve();data=json.loads(path.read_text(encoding='utf-8'))
    target=Path(data['target']).resolve();source=Path(data['source']).resolve()
    if source.parent!=path.parent or path.parent.parent!=target.parent/'runtime'/'updater':
        raise ValueError('更新位置不匹配')
    import ctypes
    from ctypes import wintypes
    kernel=ctypes.WinDLL('kernel32',use_last_error=True)
    kernel.OpenProcess.argtypes=[wintypes.DWORD,wintypes.BOOL,wintypes.DWORD];kernel.OpenProcess.restype=wintypes.HANDLE
    kernel.WaitForSingleObject.argtypes=[wintypes.HANDLE,wintypes.DWORD];kernel.WaitForSingleObject.restype=wintypes.DWORD
    kernel.CloseHandle.argtypes=[wintypes.HANDLE]
    handle=kernel.OpenProcess(0x100000,False,int(data['pid']))
    if handle:
        try:
            if kernel.WaitForSingleObject(handle,120000)!=0:raise ValueError('程序尚未退出，更新已停止')
        finally:kernel.CloseHandle(handle)
    backup=replace_verified(target,source,data['sha256'],data['oldSha256'])
    try:subprocess.Popen([str(target)],cwd=target.parent)
    except OSError:
        shutil.copy2(backup,target);raise


def main(path):
    try:apply(path)
    except Exception as exc:
        import ctypes
        message='更新未完成，请重新打开 XidLens 后重试。'
        try:(Path(path).parent/'error.txt').write_text(str(exc),encoding='utf-8')
        except OSError:pass
        ctypes.windll.user32.MessageBoxW(None,message,'XidLens',0x10)
