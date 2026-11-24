<p align="center"><img src="app/logo.png" width="64" alt=""></p>

<h1 align="center">XidLens</h1>

<p align="center">
  <a href="https://github.com/ohhellojie/xidlens/releases/latest">Download for Windows</a> ·
  <a href="docs/usage.md">Usage (Chinese)</a> ·
  <a href="README.md">简体中文</a>
</p>

XidLens parses NVIDIA GPU logs offline on your machine to present device status, error records, PCIe topology, and side-by-side report comparison, with direct source line navigation and built-in NVIDIA Xid & troubleshooting references.

[![Device status with server details, GPU inventory, and device inspection](docs/images/devices.jpg)](docs/images/devices.jpg)

## Download

1. Download the Windows x64 ZIP from [Releases](https://github.com/ohhellojie/xidlens/releases/latest).
2. Extract it and open `XidLens.exe`.
3. Click 导入日志 (Import logs) at the top and select files.

Requires Windows 10 or Windows 11 and Microsoft Edge WebView2 Runtime. The interface is in Chinese.

## Core Features

Supports text output from `nvidia-bug-report`, `dmesg`, `journalctl`, `nvidia-smi`, and `lspci`, as well as GZ, ZIP, and TAR archives.

- **Device Status**: extracts server and GPU identities (SN, UUID, PCI address, slot reference), PCIe link status, ECC counts, and row remapping status, with fault filtering and one-click copy to Excel.
- **Error Records**: browse Xid, SXid, initialization failures, and PCIe AER errors grouped by type or chronologically, with bilingual NVIDIA Xid Catalog descriptions, immediate actions, and investigative actions on the right.
- **Machine Topology**: displays both a PCIe tree and connectivity matrix. Beyond `nvidia-smi topo -m`, XidLens derives a GPU/NIC PCIe connectivity matrix (`PIX / PXB / PHB / NODE / SYS`) and shared upstream path directly from `lspci -t` / `lspci -Dnnvv` bridges and NUMA nodes when `topo -m` is absent.
- **Report Comparison**: matches GPUs across two reports by unique SN or UUID, highlights changed fields, and opens both source snippets side by side.
- **Source Drawer & Full Log Reader**: click any line reference to open a slide-over source drawer, or jump straight into the virtual-scrolling full log reader with text search and line navigation.
- **Official Xid Catalog & Troubleshooting Manual**: ships with a bilingual NVIDIA Xid Catalog and GPU Debug Guidelines manual featuring interactive, zoomable bilingual triage flowcharts (Figures 1–3), `Ctrl+K` quick search, and independent online updates.

## Documentation & Updates

Device inventories can be copied to Excel or exported as TSV, troubleshooting summaries as TXT, and full records as JSON. Reports, log copies, and settings are stored in the `runtime` folder — keep it when upgrading.

Open the bottom-left Software Updates dialog to check for new versions of the app, NVIDIA parsing rules, the Xid catalog, and the troubleshooting manual. Automatic app update checks can be toggled off; downloads and installs always require confirmation.

Documentation is in Chinese:

- [Usage](docs/usage.md) · [Status & Topology](docs/diagnostics.md) · [Structured Events](docs/structured-events.md)
- [Reference Updates](docs/reference-packages.md) · [Offline Rules](docs/catalog.md) · [Run from Source & Build](docs/development.md) · [Contributing](CONTRIBUTING.md)

Report parsing issues in [Issues](https://github.com/ohhellojie/xidlens/issues/new?template=bug_report.yml) with a minimal redacted log sample. See [Releases](https://github.com/ohhellojie/xidlens/releases) for version history.

Code is licensed under [MIT](LICENSE). Chinese reference content is an unofficial translation with official source links; third-party rights are listed in [NOTICE](NOTICE.md).
