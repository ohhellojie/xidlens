"""Convert a user-supplied Xid workbook; no workbook is bundled."""
import argparse
import hashlib
import json
from pathlib import Path

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('workbook', type=Path)
    ap.add_argument('--output', type=Path, default=Path('app/xid_catalog.local.json'))
    args = ap.parse_args()
    import openpyxl
    book = openpyxl.load_workbook(args.workbook, read_only=True, data_only=True)
    try:
        if not {'Xids', 'Resolution Buckets'} <= set(book.sheetnames):
            ap.error('Expected Xids and Resolution Buckets worksheets')
        buckets = {str(r[0]).split('\n')[0]: {'label': str(r[0]), 'text': str(r[1] or '')}
                   for r in list(book['Resolution Buckets'].values)[1:] if r[0]}
        rows = list(book['Xids'].values)
        if not rows or len(rows[0]) < 12:
            ap.error('Expected at least 12 columns in Xids')
        codes = {}
        for n, row in enumerate(rows[1:], 2):
            if not isinstance(row[1], (int, float)):
                continue
            code = str(int(row[1]))
            if code in codes or int(row[1]) != row[1]:
                ap.error('Duplicate or non-integer Xid number')
            actions = []
            for value in row[8:10]:
                if value:
                    key = str(value).split('\n')[0]
                    actions.append({'key': key, 'label': str(value), 'text': buckets.get(key, {}).get('text', '')})
            codes[code] = {'row': n, 'sheet': 'Xids', 'title': str(row[3] or row[2] or ''),
                          'symbol': str(row[2] or ''), 'description': str(row[11] or ''), 'actions': actions,
                          'architectures': dict(zip(['A100', 'H100', 'B100', 'GB200'], row[4:8])),
                          'association154': str(row[10] or '')}
        if not codes:
            ap.error('No Xid rows found')
        out = {'file': args.workbook.name, 'sha256': hashlib.sha256(args.workbook.read_bytes()).hexdigest(),
               'headers': rows[0], 'codes': codes, 'buckets': buckets}
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding='utf-8')
        print(f'Generated {len(codes)} codes: {args.output}')
    finally:
        book.close()

if __name__ == '__main__':
    main()
