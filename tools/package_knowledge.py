"""Validate and package a JSON reference release."""
import argparse
import hashlib
import json
from pathlib import Path
import sys

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'app'))
from knowledge import checked


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('kind',choices=('xid','manual'))
    parser.add_argument('--input',type=Path)
    parser.add_argument('--output',type=Path,default=ROOT/'dist/knowledge')
    args=parser.parse_args()
    pack=checked((args.input or ROOT/'app/knowledge'/(args.kind+'.json')).read_bytes(),args.kind)
    args.output.mkdir(parents=True,exist_ok=True)
    name='XidLens-'+args.kind+'.json';raw=(json.dumps(pack,ensure_ascii=False,indent=2)+'\n').encode('utf-8')
    (args.output/name).write_bytes(raw)
    (args.output/(args.kind+'-SHA256SUMS.txt')).write_text(hashlib.sha256(raw).hexdigest()+'  '+name+'\n',encoding='ascii')
    print('Validated reference package:',name)
    print('Release tag: knowledge-'+args.kind+'-v'+pack['version'])


if __name__=='__main__':main()
