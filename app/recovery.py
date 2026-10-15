"""Recover interrupted report transactions without discarding the prior results."""
import json
import os
from pathlib import Path
import re
import shutil


def valid_id(value):
    return isinstance(value, str) and re.fullmatch('[0-9a-f]{32}', value) is not None


def write_json(path, data):
    temporary = path.with_name(path.name + '.writing')
    with temporary.open('w', encoding='utf-8') as stream:
        json.dump(data, stream, ensure_ascii=False)
        stream.flush(); os.fsync(stream.fileno())
    temporary.replace(path)


def durable_copy(source, target):
    with source.open('rb') as src, target.open('wb') as dst:
        shutil.copyfileobj(src, dst)
        dst.flush(); os.fsync(dst.fileno())


def prepare(folder, results, ids):
    entries = []
    for key in ids:
        if not valid_id(key): raise ValueError('无效报告编号')
        target = results / (key + '.json')
        if target.is_symlink(): raise ValueError('报告位置无效')
        existed = target.exists()
        if existed: durable_copy(target, folder / (key + '.backup'))
        entries.append({'id': key, 'existed': existed})
    write_json(folder / 'transaction.json', {'state': 'prepared', 'entries': entries})


def settle(folder, results, commit=False):
    journal = folder / 'transaction.json'
    data = json.loads(journal.read_text(encoding='utf-8'))
    entries = data['entries']
    if not isinstance(entries, list) or not entries: raise ValueError('恢复记录无效')
    for entry in entries:
        if not valid_id(entry['id']) or type(entry['existed']) is not bool: raise ValueError('恢复记录无效')
        for path in (results / (entry['id'] + '.json'), folder / (entry['id'] + '.backup')):
            if path.is_symlink(): raise ValueError('恢复位置无效')
    if data['state'] not in ('prepared', 'committed', 'rolledback'): raise ValueError('恢复状态无效')
    if commit:
        data['state'] = 'committed'; write_json(journal, data)
    elif data['state'] == 'prepared':
        # Check every backup before modifying any report. Keep backups until rollback is durable.
        for entry in entries:
            if entry['existed'] and not (folder / (entry['id'] + '.backup')).is_file():
                raise ValueError('报告备份缺失')
        for entry in entries:
            target = results / (entry['id'] + '.json')
            if entry['existed']:
                temp = folder / (entry['id'] + '.restore')
                durable_copy(folder / (entry['id'] + '.backup'), temp); temp.replace(target)
            else: target.unlink(missing_ok=True)
        data['state'] = 'rolledback'; write_json(journal, data)
    return data['state']


def clean_folder(folder):
    # Only direct files in the app-owned upload directory; never recurse through links.
    for path in folder.iterdir():
        if path.name == 'transaction.json': continue
        if path.is_symlink() or path.resolve().parent != folder.resolve() or not path.is_file():
            raise ValueError('临时目录包含未知内容')
        path.unlink()
    (folder / 'transaction.json').unlink(missing_ok=True)
    folder.rmdir()


def recover(runtime):
    results, uploads = runtime / 'results', runtime / 'uploads'
    summary = {'recovered': 0, 'interrupted': 0, 'pending': 0}
    for folder in uploads.iterdir():
        if not valid_id(folder.name) or folder.is_symlink() or not folder.is_dir() or folder.resolve().parent != uploads.resolve(): continue
        try:
            journal = folder / 'transaction.json'
            if journal.exists():
                if journal.is_symlink(): raise ValueError('恢复位置无效')
                state = settle(folder, results)
                if state == 'rolledback': summary['recovered'] += 1
            else:
                # Older versions moved the old report aside before replacing it.
                for backup in folder.glob('*.backup'):
                    if not valid_id(backup.stem) or backup.is_symlink(): raise ValueError('恢复记录无效')
                    target = results / (backup.stem + '.json')
                    if not target.exists():
                        temp=folder/(backup.stem+'.restore')
                        durable_copy(backup,temp);temp.replace(target);summary['recovered'] += 1
                summary['interrupted'] += 1
            clean_folder(folder)
        except (OSError, ValueError, KeyError, TypeError): summary['pending'] += 1
    # Remove only unreferenced app-owned source copies, and preserve all when a report is unreadable.
    try:
        used = set()
        for path in results.glob('*.json'):
            if path.is_symlink(): raise ValueError('报告位置无效')
            report = json.loads(path.read_text(encoding='utf-8'))
            if not isinstance(report, dict): raise ValueError('报告格式无效')
            ref = report.get('input') or {}
            if ref.get('key'): used.add(ref['key'])
        if not summary['pending']:
            for path in (runtime / 'sources').iterdir():
                if valid_id(path.name) and path.name not in used and path.is_file() and not path.is_symlink(): path.unlink()
    except (OSError, ValueError, TypeError, AttributeError): pass
    return summary
