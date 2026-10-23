<p align="center"><img src="app/logo.png" width="64" alt=""></p>

<h1 align="center">XidLens</h1>

<p align="center">NVIDIA GPU log analysis</p>

<p align="center">
  <a href="https://github.com/ohhellojie/xidlens/releases/latest">Download for Windows</a> ·
  <a href="docs/usage.md">Usage (Chinese)</a> ·
  <a href="README.md">简体中文</a>
</p>

Import logs to explore device information, errors, and connections. Select a GPU, find related issues, and inspect the field descriptions and original log text. All parsing takes place locally.

[![XidLens home screen with server information, eight GPUs, and details for the selected device](docs/images/devices.png)](docs/images/devices.png)

*Home screen with the device inventory and GPU details. Screenshots use sample data; click to view at full resolution.*

## Download and start

1. Download the Windows x64 ZIP from [Releases](https://github.com/ohhellojie/xidlens/releases/latest).
2. Extract it and open `XidLens.exe`.
3. Click “导入日志” (Import logs) and select one or more files.

Requires Windows 10 or Windows 11 and Microsoft Edge WebView2 Runtime. The interface is in Chinese.

Reads text output from `nvidia-bug-report`, `dmesg`, `journalctl`, `nvidia-smi`, and `lspci`. GZ, ZIP, and TAR archives are also supported.

## Find devices that need attention

Diagnostic checks organize PCIe, ECC, and row-remapping results by device, highlighting errors, items to verify, and missing data. Select a result to see its explanation and source evidence.

[![Diagnostic checks with an ECC result selected and its counts and explanation shown on the right](docs/images/checks.png)](docs/images/checks.png)

For a closer look, the status page provides `nvidia-smi -q` fields and descriptions. Error records group Xid, initialization failures, and PCIe errors while preserving the original line numbers.

Results apply only to the evidence in the log. Missing data does not establish that a device is healthy, and cumulative error counts do not identify when errors occurred.

## Explore device connections

The topology page turns `lspci` and `nvidia-smi topo` output into a PCIe tree and connectivity matrix. Select two devices to inspect their connection type, PCI addresses, and CPU affinity, then locate them in the tree.

[![Connectivity matrix for eight GPUs and four network adapters, with details for the selected connection](docs/images/topology.png)](docs/images/topology.png)

For larger systems, filter the matrix to connections between GPUs, connections to network adapters, or a single device. Unconfirmed connections remain unlinked. Verify physical slots against device labels.

## Compare logs and export results

Compare two reports to review device fields and errors, with source text side by side. GPUs are matched by a unique serial number or UUID; unmatched devices are listed separately.

Copy the device inventory to Excel, export a log summary, or save the full evidence as JSON. The built-in Xid reference and troubleshooting manual provide error descriptions and investigation steps.

## Updates and documentation

The app checks for new versions in the background and lets you choose whether to install them. To update manually, close the app and replace `XidLens.exe`. Keep the adjacent `runtime` folder, which stores reports, log copies, and settings.

Documentation is in Chinese:

- [Usage](docs/usage.md): import, compare, export, and update.
- [Status and topology](docs/diagnostics.md): collection commands, field meanings, and interpretation limits.
- [Reference updates](docs/reference-packages.md) and [parsing rules](docs/catalog.md): update bundled references and import custom rules.
- [Run from source and build](docs/development.md) · [Contributing](CONTRIBUTING.md) · [Release notes](https://github.com/ohhellojie/xidlens/releases)

For parsing issues, open an [issue](https://github.com/ohhellojie/xidlens/issues/new?template=bug_report.yml) with a minimal anonymized log sample that reproduces the problem.

Code is licensed under [MIT](LICENSE). Chinese reference content is an unofficial translation with links to official sources. See [NOTICE](NOTICE.md) for third-party rights.
