"""Convert a user-supplied Xid workbook into an offline rule file."""
import argparse
import json
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'app'))
from catalog import parse_upload

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('workbook',type=Path)
    ap.add_argument('--output',type=Path,default=Path('app/xid_catalog.local.json'))
    args=ap.parse_args()
    try:out=parse_upload(args.workbook.read_bytes(),args.workbook.name)
    except (OSError,ValueError) as exc:ap.error(str(exc))
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text(json.dumps(out,ensure_ascii=False,indent=2),encoding='utf-8')
    print(f"Generated {len(out['codes'])} codes: {args.output}")

if __name__=='__main__':main()
