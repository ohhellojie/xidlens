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
from recovery import write_json, durable_copy


def digest(path):
    with Path(path).open('rb') as stream:return hashlib.file_digest(stream,'sha256').hexdigest()


def prepare(home, ready, executable=None, restart_args=None):
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
              'oldSha256':digest(target),'pid':os.getpid(),'token':uuid.uuid4().hex,
              'restartArgs':restart_args or []}
    path=folder/'install.json';write_json(path,manifest)
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


def mark_ready(home):
    value=os.environ.get('XIDLENS_UPDATE_RECEIPT')
    if not value:return
    receipt=Path(value).resolve();home=Path(home).resolve()
    if receipt.name!='ready.json' or receipt.parent.parent!=home/'runtime'/'updater':return
    data=json.loads((receipt.parent/'install.json').read_text(encoding='utf-8'))
    if Path(data['target']).resolve().parent!=home:return
    from version import VERSION
    write_json(receipt,{'token':data['token'],'pid':os.getpid(),'version':VERSION})


def stop_child(process):
    # The one-file bootloader has a child process. Limit termination to the process we launched.
    if process.poll() is None:
        result=subprocess.run([str(Path(os.environ['SystemRoot'])/'System32/taskkill.exe'),
                        '/PID',str(process.pid),'/T','/F'],capture_output=True,
                       creationflags=subprocess.CREATE_NO_WINDOW,timeout=20)
        if result.returncode and process.poll() is None:raise RuntimeError('新版进程尚未退出，旧版备份已保留')
    process.wait(timeout=20)


def restart_verified(target,backup,path,data,timeout=60):
    receipt=path.parent/'ready.json';receipt.unlink(missing_ok=True)
    args=data.get('restartArgs',[])
    if args not in ([],['--no-browser']):raise ValueError('无效启动参数')
    env=os.environ.copy();env['XIDLENS_UPDATE_RECEIPT']=str(receipt)
    process=None
    try:
        process=subprocess.Popen([str(target),*args],cwd=target.parent,env=env,
                                 creationflags=subprocess.CREATE_NO_WINDOW)
        deadline=time.monotonic()+timeout
        while time.monotonic()<deadline:
            if process.poll() is not None:raise RuntimeError('新版启动失败')
            try:
                ready=json.loads(receipt.read_text(encoding='utf-8'))
                if ready.get('token')==data['token']:
                    write_json(path.parent/'result.json',{'state':'installed','version':ready['version']})
                    return process
            except (OSError,ValueError):pass
            time.sleep(.1)
        raise RuntimeError('新版启动超时')
    except Exception:
        if process is not None:stop_child(process)
        # Refuse to replace a file changed by another installation while this attempt was running.
        if digest(target)!=data['sha256']:raise ValueError('程序文件已变化，旧版备份已保留')
        temp=path.parent/'rollback.exe';durable_copy(backup,temp);temp.replace(target)
        write_json(path.parent/'result.json',{'state':'rolledback'})
        raise


def apply(path):
    path=Path(path).resolve();data=json.loads(path.read_text(encoding='utf-8'))
    target=Path(data['target']).resolve();source=Path(data['source']).resolve()
    if source.parent!=path.parent or path.parent.parent!=target.parent/'runtime'/'updater':
        raise ValueError('更新位置不匹配')
    if data.get('restartArgs',[]) not in ([],['--no-browser']):raise ValueError('无效启动参数')
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
    return restart_verified(target,backup,path,data)


def main(path):
    try:apply(path)
    except Exception as exc:
        import ctypes
        message='更新未完成，请重新打开 XidLens 后重试。'
        try:
            result=json.loads((Path(path).parent/'result.json').read_text(encoding='utf-8'))
            if result.get('state')=='rolledback':message='更新未完成，已恢复旧版。请重新打开 XidLens。'
        except (OSError,ValueError):pass
        try:(Path(path).parent/'error.txt').write_text(str(exc),encoding='utf-8')
        except OSError:pass
        try:background=json.loads(Path(path).read_text(encoding='utf-8')).get('restartArgs')==['--no-browser']
        except (OSError,ValueError):background=False
        if not background:ctypes.windll.user32.MessageBoxW(None,message,'XidLens',0x10)
