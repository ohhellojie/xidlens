<p align="center"><img src="app/logo.png" width="64" alt=""></p>

<h1 align="center">XidLens</h1>

<p align="center">
  <a href="https://github.com/ohhellojie/xidlens/releases/latest">下载 Windows 版</a> ·
  <a href="docs/usage.md">使用说明</a> ·
  <a href="README.en.md">English</a>
</p>

XidLens 在本机解析 NVIDIA GPU 日志，整理设备信息、错误和状态检查结果，并提供原文定位。支持多份日志联合分析、事件时间线、报告对比和脱敏片段分享。

[![设备信息：服务器信息、GPU 清单和设备详情](docs/images/devices.jpg)](docs/images/devices.jpg)

*设备信息页。截图使用演示数据，点击查看原图。*

## 下载

1. 从 [Releases](https://github.com/ohhellojie/xidlens/releases/latest) 下载 Windows x64 ZIP 包。
2. 解压，双击 `XidLens.exe`。
3. 点击导入日志，选择文件；也可先查看内置示例。

支持 Windows 10 和 Windows 11，需安装 Microsoft Edge WebView2 Runtime。界面为中文。

## 诊断与原文

支持 `nvidia-bug-report`、`dmesg`、`journalctl`、`nvidia-smi` 和 `lspci` 的文本输出，以及 GZ、ZIP 和 TAR 压缩包。

- **诊断概览**：筛选重点发现，查看判断依据、证据和下一步。未见异常、数据缺失和字段冲突分别显示。
- **设备与状态**：提取服务器和 GPU 身份，查看 `nvidia-smi -q` 采集记录，检查 PCIe 链路、ECC 和行重映射等状态。
- **事件时间线**：按设备、类型和时间筛选错误、驱动加载、明确的重置结果及状态快照，保留来源与启动区间。

[![异常检查：在设备矩阵中选择 ECC 记录，右侧显示计数和说明](docs/images/checks.jpg)](docs/images/checks.jpg)

分析结果可跳到对应原文。完整日志支持全文搜索、行号跳转和专注阅读，切换页面或报告后保留阅读位置。

[![完整日志阅读：全文搜索、行号跳转和右侧位置标记](docs/images/reader.jpg)](docs/images/reader.jpg)

## 多份日志与对比

在报告管理中选择同次采集的文件建立联合分析，集中查看设备、事件、检查和时间线。每条来源都能打开对应报告的原始行。

选择两份报告可对比设备参数、错误记录和计数字段。GPU 按唯一且一致的 SN 或 UUID 匹配；计数变化需满足可比条件，缺失、冲突和不可比原因分别保留。两侧原文可并排核对，操作与判断条件见[使用说明](docs/usage.md)。

## 证据与分享

在日志中选择行范围，保存带备注和标签的证据书签。选择书签后生成脱敏预览，检查或编辑片段、来源名和备注，确认后导出 TXT 或 JSON。

选择书签后点击整理摘要，默认在本机摘录，不调用 AI。摘要保留引用，可编辑、复制。

也可使用本机模型或自选 HTTPS 兼容 API。核对发送预览后，点击确认发送至模型；仅发送本次选中的片段和补充说明。模型结果需核对原文，配置与数据处理条件见[整理摘要](docs/evidence-assistant.md)。

## DCGM 与事件格式

导入 DCGM JSON 后，按结果、实体或测试名称筛选，多次运行时可按运行筛选。通过、失败、警告、跳过、未运行和未知结果分别显示，运行错误单列；详情保留原始行号和 JSON Pointer。

NVSwitch SXid 与 GPU Xid 分开归属。GOE 为实验性解析，保留完整事件类型、作用范围和来源。支持格式与版本条件见[结构化诊断结果与事件](docs/structured-events.md)。

## 拓扑可视化

将 `lspci` 和 `nvidia-smi topo` 输出转换为 PCIe 连接树和互联矩阵，展示 GPU、网卡等设备的连接关系。支持设备筛选、路径定位和亲和性查询。

[![机器拓扑：GPU 互联矩阵，右侧显示连接类型与亲和性](docs/images/topology.jpg)](docs/images/topology.jpg)

上游未确认的设备单独列出。字段含义、采集命令和槽位核对方法见[状态与拓扑](docs/diagnostics.md)。

## 文档与更新

设备清单可复制到 Excel 或导出为 TSV，日志摘要导出为 TXT，完整记录导出为 JSON。报告、日志副本、书签和设置保存在 `runtime` 文件夹，升级时需保留。

内置 Xid 说明和排查手册可独立更新。软件默认联网检查新版本，可在设置中关闭；下载与安装由用户确认。

- [使用说明](docs/usage.md) · [日志采集与判断范围](docs/diagnostics.md)
- [结构化结果](docs/structured-events.md) · [整理摘要](docs/evidence-assistant.md)
- [资料更新](docs/reference-packages.md) · [解析规则](docs/catalog.md)
- [源码运行与构建](docs/development.md) · [贡献说明](CONTRIBUTING.md)

解析问题请提交至 [Issues](https://github.com/ohhellojie/xidlens/issues/new?template=bug_report.yml)，附上可复现问题的脱敏日志片段。版本变化见 [Releases](https://github.com/ohhellojie/xidlens/releases)。

代码采用 [MIT](LICENSE) 许可证。中文资料为非官方译文，保留官方来源；第三方资料权利见 [NOTICE](NOTICE.md)。
