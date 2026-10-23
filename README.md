<p align="center"><img src="app/logo.png" width="64" alt=""></p>

<h1 align="center">XidLens</h1>

<p align="center">NVIDIA GPU 日志分析工具</p>

<p align="center">
  <a href="https://github.com/ohhellojie/xidlens/releases/latest">下载 Windows 版</a> ·
  <a href="docs/usage.md">使用说明</a> ·
  <a href="README.en.md">English</a>
</p>

导入日志后，XidLens 会整理设备信息、错误记录和连接关系。你可以从一块 GPU 找到相关异常，再查看参数说明和日志原文。解析在本机完成。

[![XidLens 主页：服务器信息、8 张 GPU 的设备清单和所选 GPU 的详情](docs/images/devices.png)](docs/images/devices.png)

*软件主页：设备清单与 GPU 详情。截图使用演示数据，点击查看原图。*

## 下载使用

1. 从 [Releases](https://github.com/ohhellojie/xidlens/releases/latest) 下载 Windows x64 ZIP 包。
2. 解压，双击 `XidLens.exe`。
3. 点击“导入日志”，选择一份或多份文件。

支持 Windows 10 和 Windows 11，需安装 Microsoft Edge WebView2 Runtime。界面为中文。

可读取 `nvidia-bug-report`、`dmesg`、`journalctl`、`nvidia-smi` 和 `lspci` 的文本输出，也支持 GZ、ZIP、TAR 压缩包。

## 找到需要关注的设备

“异常检查”按设备集中展示 PCIe、ECC 和行重映射等检查结果，标出错误、待核实项和缺失数据。点击一项，即可查看判断依据和原文。

[![异常检查：在设备矩阵中选择 ECC 记录，右侧显示计数和判断依据](docs/images/checks.png)](docs/images/checks.png)

需要进一步查看时，“状态解析”提供 `nvidia-smi -q` 的参数和说明；“错误记录”汇总 Xid、初始化失败和 PCIe 错误，并保留原文行号。

检查结论限于日志中已有的证据。数据缺失不代表正常，累计错误计数也不能直接说明错误发生的时间。

## 查看设备之间的连接

“机器拓扑”将 `lspci` 和 `nvidia-smi topo` 的输出整理为 PCIe 连接树和互联矩阵。选择两个设备，可以查看连接类型、PCI 地址和 CPU 亲和性，再到连接树中定位。

[![机器拓扑：8 张 GPU 与 4 张网卡的互联矩阵，右侧解释所选连接](docs/images/topology.png)](docs/images/topology.png)

设备多时，可以只看 GPU 之间的连接、GPU 与网卡的连接，或聚焦单个设备。无法确认的连接会保留为未关联；槽位仍需结合设备标签核对。

## 对比日志，导出结果

选择两份报告，可对比设备参数和错误记录，并排查看原文。GPU 按唯一的序列号或 UUID 匹配；无法匹配的设备会单独列出。

设备清单可复制到 Excel，也可导出清单、日志摘要和完整 JSON 证据。内置 Xid 查询和排查手册，可查阅错误说明及排查步骤。

## 更新与文档

软件会在后台检查新版本，发现更新后由你选择是否安装。手动升级时，先退出软件，再替换 `XidLens.exe`，保留同目录的 `runtime` 文件夹，其中存放报告、日志副本和设置。

- [使用说明](docs/usage.md)：导入、对比、导出和更新。
- [状态与拓扑](docs/diagnostics.md)：采集命令、字段含义和判断范围。
- [资料更新](docs/reference-packages.md)与[解析规则](docs/catalog.md)：更新内置资料，导入自定义规则。
- [源码运行与构建](docs/development.md) · [贡献说明](CONTRIBUTING.md) · [更新记录](https://github.com/ohhellojie/xidlens/releases)

遇到解析问题，请在 [Issues](https://github.com/ohhellojie/xidlens/issues/new?template=bug_report.yml) 提供可复现的脱敏日志片段。

代码采用 [MIT](LICENSE) 许可证。中文资料为非官方译文，保留官方来源；第三方资料权利见 [NOTICE](NOTICE.md)。
