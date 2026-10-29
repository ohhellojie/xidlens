# 源码运行与构建

## 从源码运行

桌面窗口需要 Windows、Python 3.12 或更高版本，以及 Microsoft Edge WebView2 Runtime。

```sh
git clone https://github.com/ohhellojie/xidlens.git
cd xidlens
python -m pip install -r requirements-desktop.txt
python app/main.py
```

程序打开独立窗口，关闭窗口退出。

## 检查

测试可在 Windows 和 Ubuntu 上执行。使用 Python 3.12 或更高版本、Node.js 24.22.1 或更新的 24.x；以下命令从仓库根目录运行。Python 依赖文件会按平台安装所需组件。

```sh
python -m pip install -r requirements-desktop.txt
python -m unittest discover -s tests -v
python -c "from pathlib import Path; import subprocess; [subprocess.run(['node', str(path)], check=True) for path in sorted(Path('tests').glob('test_*.cjs'))]"
python tools/check_repository.py
git diff --check
```

JavaScript 命令运行 `tests` 下全部 `test_*.cjs`，任一失败时退出并返回错误。测试覆盖解析、读取与恢复、报告管理、联合分析、时间线、对比、证据导出、结构化结果和证据辅助。模型测试使用合成片段、模拟响应和本机服务，不需要 API 密钥或外部模型。运行 API 测试时需允许本机回环连接。

只验证对应功能时，可执行：

```sh
python -m unittest discover -s tests -p "test_structured*.py" -v
node tests/test_structured_ui.cjs
node tests/test_structured_views.cjs
python -m unittest discover -s tests -p "test_assistant.py" -v
node tests/test_assistant_ui.cjs
node tests/test_evidence_assistant.cjs
```

功能修改还需运行相关宿主与来源跳转测试；完整回归使用上面的全部测试命令。

## 构建 Windows x64

在 Windows 上执行。前端构建还需要 npm。

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

软件和资料更新的 HTTPS 下载使用随应用打包的 certifi 公共证书库；版本要求由依赖文件固定。企业 HTTPS 代理的证书链也须通过该证书库校验。可选模型接口的连接与证书规则见[证据辅助](evidence-assistant.md)。

## 公开内容检查

提交或发布前执行：

```sh
python tools/privacy_guard.py --install-hooks
python tools/privacy_guard.py --history
```

本地钩子检查暂存文件、提交署名和可达的 Git 历史，CI 会重复检查。提交使用公开署名和 GitHub 提供的 noreply 邮箱；新的公开署名需加入 `.privacy-policy.json` 的允许名单。

发布脚本还会检查程序和 ZIP 内部内容，无法读取或不支持的容器会中止打包。检查 PyInstaller 程序时，使用与构建时相同的 Python 小版本，以读取压缩代码对象的源码路径。

图片需先检查画面，再将最终文件的 SHA-256 加入 `.privacy-policy.json`。图片改变后，摘要未经审核就不能通过检查。凭证、运行数据、客户日志和内部开发计划保存在仓库外。
