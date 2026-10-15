# XidLens

Offline NVIDIA GPU log triage: device inventory, PCIe topology, and error evidence.

[简体中文](README.md) · [Usage](docs/usage.md)

Import a report, find a GPU by serial number, UUID, or PCI address, and follow its errors and upstream path. Original lines and field sources stay available for verification.

## Features

- Server and GPU serial numbers, UUIDs, models, and reported metrics.
- Search by serial number, UUID, or PCI address; copy inventory to Excel.
- Xid, initialization, and PCIe/AER records with original log text.
- Error groups with record counts and first/last evidence.
- Compare device fields, drivers, links, ECC, and errors by serial number or UUID, with source text from both reports.
- Report search, filters, sorting, batch reparse, and deletion.
- Import Xid rules or fetch NVIDIA's official English catalog, with source details.
- Browse GPU troubleshooting steps and their official references.
- Check for app updates, download and restart to install; optional daily checks.
- PCIe paths and system-reported slot references.
- TSV inventory, text summaries, and JSON evidence export.

Reads nvidia-bug-report, dmesg / journal, nvidia-smi -q text, GZ, ZIP, and TAR. Reports stay separate and are processed locally.

Windows desktop application with a Chinese interface.

## Run

Download the Windows ZIP from [Releases](https://github.com/ohhellojie/xidlens/releases), extract it, and open `XidLens.exe`.

### From source

Windows, Python 3.12+, and Microsoft Edge WebView2 Runtime.

```sh
git clone https://github.com/ohhellojie/xidlens.git
cd xidlens
python -m pip install -r requirements-desktop.txt
python app/main.py
```

The interface opens in its own window. Close the window to exit the application.

Results are stored in `runtime/results` beside the application.

## Xid reference

The built-in Xid library includes searchable Chinese descriptions, English source text, and troubleshooting topics. Parsing rules can be imported, inspected, or restored to the bundled Chinese catalog. The Xid reference and troubleshooting manual update independently, with version and source details. Failed or cancelled updates keep the existing content. Software updates have a separate entry. See [catalog setup](docs/catalog.md).

Descriptions and suggested actions come from matching rules; fault causes require further verification. Missing serial numbers remain empty, conflicting fields are preserved, and physical slot locations require verification.

## Develop and build

```sh
python -m unittest discover -s tests -v
node tests/test_analysis.cjs
node tests/test_topology.cjs
node tests/test_report_time.cjs
node tests/test_exports.cjs
python tools/check_repository.py
```

On Windows x64:

```sh
python -m pip install -r requirements-build.txt
cd frontend
npm ci
npm run build
cd ..
python tools/build_windows.py
```

Output: `dist/XidLens.exe`.

See [contributing](CONTRIBUTING.md), [MIT license](LICENSE), and [third-party notices](NOTICE.md).
