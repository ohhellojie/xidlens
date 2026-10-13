"""Windows desktop window for the existing local interface."""
import argparse
import webview
import server
from window_layout import fitted_bounds
from file_export import save_export


def position_window(window):
    # before_show runs on the WinForms UI thread, before the first visible frame.
    from ctypes import windll, wintypes
    from System.Drawing import Point, Rectangle, Size
    from System.Windows.Forms import Cursor, FormStartPosition, Screen
    form = window.native
    area = Screen.FromPoint(Cursor.Position).WorkingArea
    form.StartPosition = FormStartPosition.Manual
    form.Location = Point(area.X, area.Y)
    scale = windll.user32.GetDpiForWindow(wintypes.HWND(form.Handle.ToInt64())) / 96
    x, y, width, height, min_w, min_h = fitted_bounds(
        (area.X, area.Y, area.Width, area.Height), scale or 1.0)
    form.MinimumSize = Size(min_w, min_h)
    form.Bounds = Rectangle(x, y, width, height)


class DesktopActions:
    def __init__(self):
        self._window=None

    def install_update(self):
        import update_install
        with server.LOCK:
            if any(j.result['state'] not in {'done','error','cancelled'} for j in server.JOBS.values()):
                raise ValueError('请等待导入或解析结束')
        with server.ONLINE.lock:
            if server.ONLINE.active or not server.ONLINE.ready:raise ValueError('请先完成更新下载')
            update_install.launch(server.APP_HOME,dict(server.ONLINE.ready))
        self._window.destroy()
        return True

    def save_text(self,name,text):
        if name not in {'GPU设备清单.tsv','GPU日志摘要.txt','GPU日志证据.json'}:
            raise ValueError('无效文件名')
        extension=name.rsplit('.',1)[-1]
        selected=self._window.create_file_dialog(webview.FileDialog.SAVE,save_filename=name,
                                                 file_types=(f'{extension.upper()} (*.{extension})',))
        if not selected:return False
        save_export(selected[0],text)
        return True


def main(after_start=None):
    ap=argparse.ArgumentParser()
    ap.add_argument('--port',type=int,default=0)
    args=ap.parse_args()
    service=server.LocalService(args.port)
    try:
        service.start()
        webview.settings['ALLOW_FILE_URLS']=False
        actions=DesktopActions()
        window=webview.create_window('XidLens',service.url,width=1440,height=960,
                                     min_size=(860,600),text_select=True,
                                     background_color='#ffffff',js_api=actions,
                                     localization={'global.ok':'确定','global.cancel':'取消',
                                                   'global.quit':'退出','global.saveFile':'保存文件',
                                                   'windows.fileFilter.allFiles':'所有文件'})
        actions._window=window
        window.events.before_show += position_window
        service.on_stop=window.destroy
        window.events.closing += lambda: server.STOP_EVENT.set()
        webview.start(after_start,args=(window,service),gui='edgechromium',
                      private_mode=True,storage_path=str(server.RUNTIME/'webview'))
        if not window.events.shown.is_set():raise RuntimeError('软件窗口未能启动')
    finally:
        service.close()


if __name__=='__main__':
    main()
