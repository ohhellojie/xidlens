<p align="center"><img src="app/logo.png" width="64" alt=""></p>

<h1 align="center">XidLens</h1>

<p align="center">
  <a href="https://github.com/ohhellojie/xidlens/releases/latest">下载 Windows 版</a> ·
  <a href="docs/usage.md">使用说明</a> ·
  <a href="README.en.md">English</a>
</p>

XidLens 在本机离线解析 NVIDIA GPU 日志，快速呈现设备状态、错误记录、PCIe 拓扑和前后对比，支持原文定位与官方 Xid / 排查手册对照。

[![设备信息：服务器信息、GPU 清单和设备详情](docs/images/devices.jpg)](docs/images/devices.jpg)

## 下载

1. 从 [Releases](https://github.com/ohhellojie/xidlens/releases/latest) 下载 Windows x64 ZIP 包。
2. 解压后双击 `XidLens.exe`。
3. 点击顶部的「导入日志」，选择文件。

支持 Windows 10 和 Windows 11，需安装 Microsoft Edge WebView2 Runtime。界面为中文。

## 核心功能

支持 `nvidia-bug-report`、`dmesg`、`journalctl`、`nvidia-smi` 和 `lspci` 的文本输出，以及 GZ、ZIP 和 TAR 压缩包。

- **设备状态**：提取服务器与 GPU 身份（SN、UUID、PCI 地址、槽位参考）、PCIe 链路、ECC 与行重映射状态，支持筛选异常卡与一键复制到 Excel。
- **错误记录**：支持按类型聚合与按时间顺序查看 Xid、SXid、初始化失败与 PCIe AER，右侧按 NVIDIA 官方 Xid Catalog 展示中英双语说明、即时操作与调查操作。
- **机器拓扑**：提供 PCIe 连接树与互联矩阵。除解析 `nvidia-smi topo -m` 外，还可依据日志中已有的 `lspci -t` / `lspci -Dnnvv` 桥结构与 NUMA 节点自动推导 GPU / 网卡的 PCIe 互联矩阵（`PIX / PXB / PHB / NODE / SYS`）与公共上游路径。
- **日志对比**：按唯一 SN 或 UUID 匹配两份报告的 GPU，筛选变化字段并并排核对两侧原文。
- **完整日志与原文抽屉**：任意结果行号点击即可右侧滑出原文抽屉定位，并可一键切入支持虚拟滚动、搜索、行号跳转的完整日志阅读器。
- **官方 Xid 目录与排查手册**：内置 NVIDIA Xid Catalog 中英双语目录与 GPU Debug Guidelines 排查手册，提供可放大与点击跳转章节的 GPU 分流流程图（图 1～图 3），支持 `Ctrl+K` 速查及在线独立更新。

## 文档与更新

设备清单可复制到 Excel 或导出为 TSV，排障摘要导出为 TXT，完整记录导出为 JSON。报告、日志副本与设置保存在 `runtime` 目录，升级时需保留。

可在左下角「软件更新」中统一检查软件、解析规则与官方资料包更新，软件自动检查可按需关闭；下载与安装需用户确认。

- [使用说明](docs/usage.md) · [状态与拓扑](docs/diagnostics.md) · [结构化诊断结果](docs/structured-events.md)
- [资料更新](docs/reference-packages.md) · [离线规则](docs/catalog.md) · [源码运行与构建](docs/development.md) · [贡献说明](CONTRIBUTING.md)

代码采用 [MIT](LICENSE) 许可证。中文资料为非官方译文，保留官方来源；第三方资料权利见 [NOTICE](NOTICE.md)。
