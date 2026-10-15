"""One running process per data directory; Windows releases ownership after a crash."""
import ctypes
from ctypes import wintypes
import hashlib
import os
import threading


class Instance:
    def __init__(self, runtime):
        key = hashlib.sha256(os.path.normcase(str(runtime.resolve())).encode()).hexdigest()
        self.api = ctypes.WinDLL('kernel32', use_last_error=True)
        for name, args, result in (
            ('CreateMutexW', [wintypes.LPVOID, wintypes.BOOL, wintypes.LPCWSTR], wintypes.HANDLE),
            ('CreateEventW', [wintypes.LPVOID, wintypes.BOOL, wintypes.BOOL, wintypes.LPCWSTR], wintypes.HANDLE),
            ('WaitForSingleObject', [wintypes.HANDLE, wintypes.DWORD], wintypes.DWORD),
            ('SetEvent', [wintypes.HANDLE], wintypes.BOOL),
            ('ReleaseMutex', [wintypes.HANDLE], wintypes.BOOL),
            ('CloseHandle', [wintypes.HANDLE], wintypes.BOOL),
        ):
            fn = getattr(self.api, name); fn.argtypes = args; fn.restype = result
        self.mutex = self.api.CreateMutexW(None, False, 'Local\\XidLens-' + key)
        self.event = self.api.CreateEventW(None, False, False, 'Local\\XidLens-activate-' + key)
        self.stop = threading.Event(); self.thread = None; self.owned = False
        if not self.mutex or not self.event:
            self.close(); raise ctypes.WinError(ctypes.get_last_error())

    def acquire(self):
        result = self.api.WaitForSingleObject(self.mutex, 0)
        if result in (0, 0x80): self.owned = True; return True
        if result == 0x102:
            self.api.SetEvent(self.event)
            return False
        raise ctypes.WinError(ctypes.get_last_error())

    def listen(self, activate):
        def run():
            while not self.stop.is_set():
                if self.api.WaitForSingleObject(self.event, 200) == 0 and not self.stop.is_set():
                    try: activate()
                    except Exception: pass  # A window can close while activation is queued.
        self.thread = threading.Thread(target=run, daemon=True); self.thread.start()

    def close(self):
        self.stop.set()
        if self.thread: self.thread.join(timeout=2)
        if self.owned: self.api.ReleaseMutex(self.mutex); self.owned = False
        for name in ('event', 'mutex'):
            handle = getattr(self, name, None)
            if handle: self.api.CloseHandle(handle); setattr(self, name, None)

    def __enter__(self): return self
    def __exit__(self, *args): self.close()
