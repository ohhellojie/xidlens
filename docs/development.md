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

联网下载使用随应用打包的 certifi 公共证书库，不合并系统中额外安装的 CA。要求 certifi 2026.10.19 或更新版本；企业 HTTPS 检查代理的私有 CA 不在该公共信任集合中。

```sh
python -m unittest discover -s tests -v
node tests/test_analysis.cjs
node tests/test_topology.cjs
node tests/test_report_time.cjs
node tests/test_exports.cjs
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
