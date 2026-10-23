<p align="center"><img src="app/logo.png" width="64" alt=""></p>

<h1 align="center">XidLens</h1>

<p align="center">
  <a href="https://github.com/ohhellojie/xidlens/releases/latest">Download for Windows</a> ·
  <a href="docs/usage.md">Usage (Chinese)</a> ·
  <a href="README.md">简体中文</a>
</p>

XidLens is an offline NVIDIA GPU log analyzer with a full log reader, device inventory, Xid error analysis, diagnostic checks, and topology visualization. Logs are processed locally.

[![XidLens home screen with server information, GPU inventory, and device details](docs/images/devices.jpg)](docs/images/devices.jpg)

*Device information page. Screenshots use sample data; click to view at full resolution.*

## Download

1. Download the Windows x64 ZIP from [Releases](https://github.com/ohhellojie/xidlens/releases/latest).
2. Extract it and open `XidLens.exe`.
3. Click 导入日志 (Import logs) and select your log files.

Requires Windows 10 or Windows 11 and Microsoft Edge WebView2 Runtime. The interface is in Chinese.

## Full log reader

Search the full text and jump to a line, with matches and errors marked on the scrollbar. Open source lines directly from analysis results, switch to focus mode, and keep your reading position when changing pages or logs.

[![Full log reader with text search, line navigation, and scrollbar markers](docs/images/reader.jpg)](docs/images/reader.jpg)

## Log analysis

Supports text output from `nvidia-bug-report`, `dmesg`, `journalctl`, `nvidia-smi`, and `lspci`, as well as GZ, ZIP, and TAR archives.

- **Device inventory**: extracts server information and GPU details, including models, serial numbers, UUIDs, and PCI addresses.
- **Error records**: groups Xid, initialization failures, and PCIe errors by device, preserving source text and line numbers.
- **Status fields**: parses `nvidia-smi -q` parameters with field descriptions and support for multiple snapshots.
- **Diagnostic checks**: checks PCIe links, ECC, and row remapping, identifying errors, items to verify, and missing data.

[![Diagnostic checks with an ECC result selected and its counts and explanation shown on the right](docs/images/checks.jpg)](docs/images/checks.jpg)

Check results include explanations and source evidence, with items that need more data flagged separately. See [status and topology](docs/diagnostics.md) for field descriptions and collection commands.

## Topology visualization

Converts `lspci` and `nvidia-smi topo` output into a PCIe tree and connectivity matrix for GPUs, network adapters, and other devices. Supports device filtering, path navigation, and affinity details.

[![GPU connectivity matrix with connection type and affinity details on the right](docs/images/topology.jpg)](docs/images/topology.jpg)

The tree groups devices with an unconfirmed upstream connection. Use device labels to verify physical slots.

## Comparison and export

Matches GPUs by a unique serial number or UUID, compares device fields and errors, and lists unmatched devices separately. Source text from both logs can be viewed side by side.

Device inventories can be copied to Excel or exported as TSV. Log summaries are exported as TXT, and full records as JSON.

## Documentation

The built-in Xid reference and troubleshooting manual can be updated independently. The app checks for new versions in the background and requires confirmation before updating. Keep the `runtime` folder when upgrading; it stores reports, log copies, and settings.

Documentation is in Chinese:

- [Usage](docs/usage.md) · [Log collection and interpretation](docs/diagnostics.md)
- [Reference updates](docs/reference-packages.md) · [Parsing rules](docs/catalog.md)
- [Run from source and build](docs/development.md) · [Contributing](CONTRIBUTING.md)

Report parsing issues in [Issues](https://github.com/ohhellojie/xidlens/issues/new?template=bug_report.yml) with a minimal anonymized log sample. See [Releases](https://github.com/ohhellojie/xidlens/releases) for version changes.

Code is licensed under [MIT](LICENSE). Chinese reference content is an unofficial translation with links to official sources. See [NOTICE](NOTICE.md) for third-party rights.
