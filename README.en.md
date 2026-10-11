# XidLens

Offline NVIDIA GPU log triage: device inventory, PCIe topology, and error evidence.

[简体中文](README.md) · [Usage](docs/usage.md)

Import a report, find a GPU by serial number or PCI address, and follow its errors and upstream path. Original lines and field sources stay available for verification.

## Features

- Server and GPU serial numbers, UUIDs, models, and reported metrics.
- Search by serial number or PCI address; copy inventory to Excel.
- Xid, initialization, and PCIe/AER records with original log text.
- PCIe paths and system-reported slot references.
- TSV inventory, text summaries, and JSON evidence export.

Reads nvidia-bug-report, dmesg / journal, nvidia-smi -q text, GZ, ZIP, and TAR. Reports stay separate and are processed locally.

This is a Windows preview with a Chinese interface.

## Run

Windows users can [download the preview ZIP](https://github.com/ohhellojie/xidlens/releases/download/v0.1.0/XidLens_v0.1.0_Windows_x64.zip), extract it, and open `XidLens.exe`. See [Releases](https://github.com/ohhellojie/xidlens/releases) for version notes.

### From source

Python 3.12+; standard library only at runtime.

```sh
git clone https://github.com/ohhellojie/xidlens.git
cd xidlens
python app/main.py
```

The interface opens in your default browser. Import a log and use **退出** to stop the application. Closing the tab leaves it running.

Results are stored in `runtime/results` beside the application.

## Xid reference

Xid numbers, raw records, and the [official reference link](https://docs.nvidia.com/deploy/xid-errors/analyzing-xid-catalog.html) are available by default. Import your own workbook to add offline descriptions and suggested actions; see [catalog setup](docs/catalog.md).

Descriptions and suggested actions come from matching rules; fault causes require further verification. Missing serial numbers remain empty, conflicting fields are preserved, and physical slot locations require verification.

## Develop and build

```sh
python -m unittest discover -s tests -v
python tools/check_repository.py
```

On Windows x64:

```sh
python -m pip install -r requirements-build.txt
python tools/build_windows.py
```

Output: `dist/XidLens.exe`.

See [contributing](CONTRIBUTING.md), [MIT license](LICENSE), and [third-party notices](NOTICE.md).
