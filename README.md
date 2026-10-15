# XidLens

离线整理 GPU 日志，查看设备、PCIe 拓扑和错误证据。

[English](README.en.md) · [使用说明](docs/usage.md)

## 目前能做什么

- 查看服务器 SN、GPU 型号、SN、UUID 和采集状态。
- 按 SN、UUID 或 PCI 地址搜索，复制到 Excel，导出设备清单与日志摘要。
- 整理 Xid、初始化失败、PCIe/AER 等记录，查看日志原文。
- 按设备和错误类型聚合记录，查看条数和首末记录。
- 按 SN / UUID 对比设备字段、驱动、链路、ECC 及错误记录，查看两份原文。
- 报告列表支持搜索、筛选排序、多选重新解析和删除。
- 导入 Xid 规则，或在线获取 NVIDIA 官方英文规则，查看当前规则与来源。
- 按问题查看 GPU 排查步骤及官方原文。
- 检查软件更新，下载后重启升级；支持可选的每日检查。
- 查看 PCIe 路径与槽位参考，追溯字段来源。

支持 nvidia-bug-report、dmesg / journal、nvidia-smi -q 文本，以及 GZ、ZIP、TAR。每份报告独立查看，日志在本机处理。

当前为 Windows 试用版，界面使用中文。

## 开始使用

在 [Releases](https://github.com/ohhellojie/xidlens/releases) 下载 Windows 试用包，解压后双击 `XidLens.exe`。

### 从源码运行

需要 Windows、Python 3.12 或更高版本，以及 Microsoft Edge WebView2 Runtime。

```sh
git clone https://github.com/ohhellojie/xidlens.git
cd xidlens
python -m pip install -r requirements-desktop.txt
python app/main.py
```

程序打开独立窗口。点击“导入日志”选择文件，关闭窗口结束程序。

解析结果保存在程序目录的 `runtime/results`。

## Xid 说明

内置中文 Xid 查询、英文原文和排查手册，可按编号或关键词搜索。“解析规则”支持导入 XLSX / JSON、查看来源和恢复内置中文规则，格式见[规则说明](docs/catalog.md)。Xid 资料和排查手册可在“版本与更新”中分别更新，查看版本与来源；失败或取消保留原资料。软件更新位于独立入口。

说明和建议来自匹配的规则，故障原因需进一步核实。SN 缺失时留空，字段冲突保留原值；槽位需核对机箱或模组位置。

## 开发与打包

```sh
python -m unittest discover -s tests -v
node tests/test_analysis.cjs
node tests/test_topology.cjs
node tests/test_report_time.cjs
python tools/check_repository.py
```

在 Windows x64 上构建 EXE：

```sh
python -m pip install -r requirements-build.txt
cd frontend
npm ci
npm run build
cd ..
python tools/build_windows.py
```

产物位于 `dist/XidLens.exe`。可选规则包的构建方式见[规则说明](docs/catalog.md)。

运行 `python tools/package_release.py` 可生成便携 ZIP 和 `SHA256SUMS.txt`，产物在 `dist/release`。

## 参与

欢迎提交解析问题、交互建议和经过脱敏的最小样本。请先阅读[贡献说明](CONTRIBUTING.md)。

代码使用 [MIT](LICENSE) 许可证。第三方资料保留其原有权利，见 [NOTICE](NOTICE.md)。
