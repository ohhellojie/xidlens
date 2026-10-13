# XidLens

Offline NVIDIA GPU log triage: device inventory, PCIe topology, and error evidence.

[简体中文](README.md) · [Usage](docs/usage.md)

Import a report, find a GPU by serial number, UUID, or PCI address, and follow its errors and upstream path. Original lines and field sources stay available for verification.

## Features

- Server and GPU serial numbers, UUIDs, models, and reported metrics.
- Search by serial number, UUID, or PCI address; copy inventory to Excel.
- Xid, initialization, and PCIe/AER records with original log text.
- Error groups with record counts and first/last evidence.
- Two-report comparison of device fields, links, and errors using serial numbers or UUIDs.
- PCIe paths and system-reported slot references.
- TSV inventory, text summaries, and JSON evidence export.

Reads nvidia-bug-report, dmesg / journal, nvidia-smi -q text, GZ, ZIP, and TAR. Reports stay separate and are processed locally.

This is a Windows preview with a Chinese interface.

## Run

Download a Windows preview ZIP from [Releases](https://github.com/ohhellojie/xidlens/releases), extract it, and open `XidLens.exe`.

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

Xid numbers, raw records, and the [official reference link](https://docs.nvidia.com/deploy/xid-errors/analyzing-xid-catalog.html) are available by default. Import your own workbook to add offline descriptions and suggested actions; see [catalog setup](docs/catalog.md).

Descriptions and suggested actions come from matching rules; fault causes require further verification. Missing serial numbers remain empty, conflicting fields are preserved, and physical slot locations require verification.

## Develop and build

```sh
python -m unittest discover -s tests -v
node tests/test_analysis.cjs
node tests/test_topology.cjs
python tools/check_repository.py
```

On Windows x64:

```sh
python -m pip install -r requirements-build.txt
python tools/build_windows.py
```

Output: `dist/XidLens.exe`.

See [contributing](CONTRIBUTING.md), [MIT license](LICENSE), and [third-party notices](NOTICE.md).
