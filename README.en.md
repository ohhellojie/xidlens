<p align="center"><img src="app/logo.png" width="64" alt=""></p>

<h1 align="center">XidLens</h1>

<p align="center">Analyze NVIDIA GPU logs offline: status, diagnostic checks, and machine topology.</p>

<p align="center">
  <a href="https://github.com/ohhellojie/xidlens/releases/latest">Download for Windows</a> ·
  <a href="docs/usage.md">Usage (Chinese)</a> ·
  <a href="https://github.com/ohhellojie/xidlens/releases">Release notes</a> ·
  <a href="README.md">简体中文</a>
</p>

![Status fields with PCIe parameters, check results, and source evidence](docs/images/status.png)

*Actual interface with sample data.*

## Get started

1. Download the Windows x64 ZIP from [Releases](https://github.com/ohhellojie/xidlens/releases/latest).
2. Extract the ZIP and open `XidLens.exe`.
3. Click “导入日志” (Import logs) and select one or more files.

Requires Windows 10 / 11 x64 and Microsoft Edge WebView2 Runtime. The interface is in Chinese.

Reads nvidia-bug-report, dmesg / journal, nvidia-smi and lspci text, and GZ, ZIP, TAR archives. Logs are parsed locally.

## Features

| Feature | Details |
| --- | --- |
| Device inventory | Server and GPU serial numbers, UUIDs, PCI addresses, metrics, and field sources; search and copy to Excel. |
| Error records | Group Xid, initialization, and PCIe/AER records; inspect original text, line numbers, and rule descriptions. |
| Status fields | Browse nvidia-smi -q fields, descriptions, and source text by GPU, snapshot, and parameter group. |
| Diagnostic checks | Inspect PCIe, ECC, and row-remapping results, with errors, items to verify, and missing data identified. |
| Machine topology | Explore PCIe trees, GPU / NIC connectivity matrices, and affinity; filter and locate devices. |
| Log comparison | Match GPUs by unique serial number or UUID; compare fields and errors with source text side by side. |
| Report management | Search, filter, batch reparse, and delete reports; export TSV, TXT, and JSON. |
| Xid reference | Search Chinese and English descriptions, browse troubleshooting topics, and update references independently. |

<details>
<summary>View diagnostic checks and topology matrices</summary>

### Diagnostic checks

![Device checks with items to verify and ECC errors](docs/images/checks.png)

### GPU / NIC topology

![GPU to NIC connectivity, PCI addresses, and affinity](docs/images/topology.png)

</details>

Fields reflect the imported logs. Missing and conflicting values are preserved; slots are references. Descriptions and suggested actions come from matching rules and require verification against the original logs and device state.

## Updates and data

The app checks for updates daily in the background and notifies you when a new version is available. You choose when to download and install it. You can also close the app and replace the EXE, keeping the adjacent `runtime` folder.

Reports, source copies, and settings are stored in `runtime`. The Xid reference and troubleshooting manual update separately. [Parsing rules](docs/catalog.md) accept XLSX / JSON imports. See [usage](docs/usage.md), [status and topology](docs/diagnostics.md), and [reference updates](docs/reference-packages.md) for details (Chinese).

## Development and feedback

[Run from source and build (Chinese)](docs/development.md) · [Contributing](CONTRIBUTING.md) · [Report an issue](https://github.com/ohhellojie/xidlens/issues/new?template=bug_report.yml)

For parsing issues, include a minimal anonymized log sample that reproduces the problem.

Code is licensed under [MIT](LICENSE). Chinese reference content is an unofficial translation with links to official sources. See [NOTICE](NOTICE.md) for third-party rights.
