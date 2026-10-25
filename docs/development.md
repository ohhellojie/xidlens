# 源码运行与构建

## 从源码运行

需要 Windows、Python 3.12 或更高版本，以及 Microsoft Edge WebView2 Runtime。

```sh
git clone https://github.com/ohhellojie/xidlens.git
cd xidlens
python -m pip install -r requirements-desktop.txt
python app/main.py
```

程序打开独立窗口，关闭窗口退出。

## 检查

Python 测试使用上述依赖；前端测试与构建使用 Node.js 24.22.1 或更新的 24.x 和 npm。

联网下载仅信任随应用打包的 certifi 公共证书库，要求版本为 2026.10.19 或更新版本。使用企业 HTTPS 代理时，其证书链也须通过该证书库校验。

```sh
python -m unittest discover -s tests -v
node tests/test_analysis.cjs
node tests/test_topology.cjs
node tests/test_report_time.cjs
node tests/test_exports.cjs
node tests/test_diagnostics.cjs
node tests/test_import_ui.cjs
node tests/test_update_ui.cjs
node tests/test_state_ui.cjs
node tests/test_reader_ui.cjs
python tools/check_repository.py
git diff --check
```

## 构建 Windows x64

```sh
python -m pip install -r requirements-build.txt
cd frontend
npm ci
npm run build
cd ..
python tools/build_windows.py
python tools/package_release.py
```

EXE 位于 `dist/XidLens.exe`；便携 ZIP 和 SHA-256 清单位于 `dist/release`。自定义规则的构建方式见[规则说明](catalog.md)，独立中文资料包的生成方式见[资料更新](reference-packages.md)。

## 公开内容检查

提交或发布前执行：

```powershell
python tools/privacy_guard.py --install-hooks
python tools/privacy_guard.py --history
```

本地钩子检查暂存文件、提交署名和可达的 Git 历史，CI 会重复检查。提交使用公开署名和 GitHub 提供的 noreply 邮箱；新的公开署名需加入 `.privacy-policy.json` 的允许名单。

发布脚本还会检查程序和 ZIP 内部内容，无法读取或不支持的容器会中止打包。检查 PyInstaller 程序时，使用与构建时相同的 Python 小版本，以读取压缩代码对象的源码路径。

图片需先检查画面，再将最终文件的 SHA-256 加入 `.privacy-policy.json`。图片改变后，摘要未经审核就不能通过检查。凭证、运行数据、客户日志和内部开发计划保存在仓库外。
