"""User-created collections of immutable source references for offline analysis."""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import threading
import uuid

from gpu_summary_core import timestamp

MAX_MEMBERS = 32
MAX_EVENTS = 50000
MAX_CHECKS = 10000
MAX_SNAPSHOTS = 10000
ID = re.compile(r'^[a-f0-9]{32}$')
UNAVAILABLE = {'', '冲突', '多个采集值', 'unknown', 'n/a', 'none', '—', '0', 'not specified'}


def identifier(value):
    if not isinstance(value, str) or not ID.fullmatch(value):
        raise ValueError('无效记录编号')
    return value


def text(value, limit=200):
    return str(value or '')[:limit]


def values(fields, key, fallback=''):
    rows = fields.get(key, []) if isinstance(fields, dict) else []
    found = {str(row.get('value', '')).strip() for row in rows if isinstance(row, dict)}
    if not found and fallback:
        found.add(str(fallback).strip())
    return {value for value in found if value.lower() not in UNAVAILABLE}


def unique_identity(record, key):
    fallback = record.get('sn' if key == 'serial' else key, '')
    found = values(record.get('fields', {}), key, fallback)
    return next(iter(found)) if len(found) == 1 else ''


def aware_time(raw):
    """Only explicit full calendar times with a zone can order separate files."""
    if not isinstance(raw, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})', raw):
        return None
    try:
        value = datetime.fromisoformat(raw.replace('Z', '+00:00'))
        return value.astimezone(timezone.utc).isoformat() if value.tzinfo else None
    except ValueError:
        return None


def event_time(event):
    parsed = dict(event.get('timeInfo') or timestamp(str(event.get('raw', ''))))
    raw = str(event.get('time', ''))
    if parsed['kind'] == 'unknown' and raw not in ('', '—'):
        if re.fullmatch(r'\d+(?:\.\d+)?', raw):
            parsed = {'kind': 'uptime_seconds', 'raw': raw}
        else:
            parsed = timestamp(raw)
    if parsed['kind'] == 'calendar' and not aware_time(parsed['raw']):
        parsed['kind'] = 'calendar_without_zone'
    return {**parsed, 'utc': aware_time(parsed['raw']), 'boot': event.get('boot')}


def reference(report_id, report, evidence):
    result = deepcopy(evidence) if isinstance(evidence, dict) else {}
    result.update(reportId=report_id, source=report['source'])
    if report.get('sourceMember'):
        result['sourceMember'] = report['sourceMember']
    return result


def machine_identity(report):
    server = report.get('server', {})
    result = {key: unique_identity(server, key) for key in ('sn', 'uuid')}
    result['conflicted'] = any(len(values(server.get('fields', {}), key, server.get(key, ''))) > 1
                               or server.get(key, '') in ('冲突', '多个采集值') for key in ('sn', 'uuid'))
    return result


def machine_conflict(a, b):
    return a.get('conflicted', False) or b.get('conflicted', False) or any(a[key] and b[key] and a[key] != b[key] for key in ('sn', 'uuid'))


def occurrence_count(event):
    count = event.get('occurrenceCount', 1)
    return count if type(count) is int and count >= 0 else 1


def combine(manifest, loaded):
    """Build a source-aware view; never rewrite or concatenate member reports."""
    members, devices, events, lifecycle_events, snapshots, checks, warnings = [], [], [], [], [], [], []
    seen_content, active, report_machines = {}, {}, {}
    counts = {'reports': len(manifest['members']), 'available': 0, 'devices': 0, 'events': 0, 'lifecycleEvents': 0, 'snapshots': 0, 'checks': 0}
    row_counts = {'events': 0, 'lifecycleEvents': 0, 'snapshots': 0, 'checks': 0}
    incomplete = False
    for member in manifest['members']:
        key = member['reportId']
        item = {'reportId': key, 'source': member['source'], 'revision': member['revision'], 'state': 'missing'}
        pair = loaded.get(key)
        if not pair:
            members.append(item)
            warnings.append({'kind': 'missing', 'reportId': key, 'message': '成员报告已删除或暂时无法读取。'})
            incomplete = True
            continue
        report, revision = pair
        item.update(source=report['source'], currentRevision=revision,
                    state='ready' if revision == member['revision'] else 'changed',
                    complete=report.get('complete', True), time=text(report.get('server', {}).get('time'), 500),
                    gpus=len(report.get('gpus', [])), events=sum(occurrence_count(event) for event in report.get('events', [])))
        server = report.get('server', {})
        item['machine'] = {field: text(server.get(field), 500) for field in ('sn', 'uuid', 'host')}
        item['machineEvidence'] = {field: [{**deepcopy(row), 'evidence': reference(key, report, row.get('evidence'))}
                                            for row in server.get('fields', {}).get(field, [])]
                                   for field in ('sn', 'uuid')}
        if report.get('sourceMember'):
            item['sourceMember'] = report['sourceMember']
        counts['available'] += 1
        if item['state'] == 'changed':
            warnings.append({'kind': 'changed', 'reportId': key, 'message': '报告内容已变化，刷新关联后才纳入联合视图。'})
            incomplete = True
            members.append(item)
            continue
        digest = report.get('contentSha256')
        if digest and digest in seen_content:
            item.update(state='duplicate', duplicateOf=seen_content[digest])
            members.append(item)
            warnings.append({'kind': 'duplicate', 'reportId': key, 'message': '内容与另一成员相同，联合统计只计一次。'})
            continue
        if digest:
            seen_content[digest] = key
        members.append(item)
        active[key] = report
        report_machines[key] = machine_identity(report)
        incomplete |= not report.get('complete', True)
        for gpu in report.get('gpus', []):
            device = {k: deepcopy(gpu.get(k)) for k in ('id', 'pci', 'label', 'model', 'sn', 'uuid')}
            device.update(key=f'{key}:{gpu["id"]}', reportId=key, source=report['source'], identity={})
            device['identity'] = {field: unique_identity(gpu, field) for field in ('serial', 'uuid')}
            device['identityConflict'] = any(len(values(gpu.get('fields', {}), field,
                                                        gpu.get('sn' if field == 'serial' else field, ''))) > 1
                                             or gpu.get('sn' if field == 'serial' else field, '') in ('冲突', '多个采集值')
                                             for field in ('serial', 'uuid'))
            device['fields'] = {field: [{**deepcopy(row), 'evidence': reference(key, report, row.get('evidence'))}
                                       for row in rows] for field, rows in gpu.get('fields', {}).items()}
            devices.append(device)
        counts['devices'] += len(report.get('gpus', []))
        for name, target in (('events', events), ('lifecycleEvents', lifecycle_events)):
            counts[name] += sum(occurrence_count(event) for event in report.get(name, []))
            row_counts[name] += len(report.get(name, []))
            for event in report.get(name, [])[:max(0, MAX_EVENTS - len(target))]:
                row = deepcopy(event)
                row.update(id=f'{key}:{event.get("id", "")}', reportId=key, source=report['source'],
                           sourceEventId=event.get('id', ''), timeInfo=event_time(event))
                if event.get('kind') == 'sxid' or event.get('deviceNamespace') == 'nvswitch':
                    row.update(gpu=None, deviceNamespace='nvswitch', deviceKey=f'{key}:nvswitch:{event.get("address", "")}')
                elif event.get('gpu') is not None:
                    row['deviceKey'] = f'{key}:{event["gpu"]}'
                elif event.get('kind') == 'goe':
                    target_uuid = event.get('targetUUID') or event.get('structured', {}).get('deviceUUID', '')
                    row.update(deviceNamespace='gpu', targetUUID=target_uuid, deviceKey=f'{key}:gpu-uuid:{target_uuid}')
                if report.get('sourceMember'):
                    row['sourceMember'] = report['sourceMember']
                if row.get('association', {}).get('refs'):
                    row['association']['refs'] = [{**ref, 'evidence': reference(key, report, ref.get('evidence'))}
                                                   for ref in row['association']['refs']]
                if isinstance(row.get('structured'), dict):
                    structured = row['structured']
                    if 'evidence' in structured:
                        structured['evidence'] = reference(key, report, structured['evidence'])
                    if 'representations' in structured:
                        structured['representations'] = [reference(key, report, ref) for ref in structured['representations']]
                target.append(row)
        source_snapshots = report.get('diagnostics', {}).get('snapshots', [])
        counts['snapshots'] += len(source_snapshots)
        row_counts['snapshots'] += len(source_snapshots)
        for snapshot in source_snapshots[:max(0, MAX_SNAPSHOTS - len(snapshots))]:
            row = deepcopy(snapshot)
            row.update(id=f'{key}:{snapshot.get("id", "")}', sourceSnapshotId=snapshot.get('id', ''),
                       reportId=key, source=report['source'],
                       evidence=reference(key, report, snapshot.get('evidence') or {'line': snapshot.get('line', 0)}))
            if report.get('sourceMember'):
                row['sourceMember'] = report['sourceMember']
            for field in row.get('fields', []):
                field['evidence'] = reference(key, report, field.get('evidence'))
            snapshots.append(row)
        source_checks = report.get('diagnostics', {}).get('checks', [])
        counts['checks'] += len(source_checks)
        row_counts['checks'] += len(source_checks)
        for check in source_checks[:max(0, MAX_CHECKS - len(checks))]:
            row = deepcopy(check)
            row.update(id=f'{key}:{check.get("id", "")}', reportId=key, source=report['source'],
                       evidence=[reference(key, report, ref) for ref in check.get('evidence', [])])
            checks.append(row)

    # Never infer device identity from an address, ordinal, model name or hostname.
    identity_index = {}
    for device in devices:
        if device['identityConflict']:
            warnings.append({'kind': 'identity-conflict', 'deviceKeys': [device['key']],
                             'message': '设备身份字段包含多个值，未进行跨文件匹配。'})
            continue
        for field, value in device['identity'].items():
            if value:
                identity_index.setdefault((field, value), []).append(device)
    candidates, blocked = {}, set()
    for (field, value), rows in identity_index.items():
        by_report = {}
        for row in rows:
            by_report.setdefault(row['reportId'], []).append(row)
        if any(len(matched) > 1 for matched in by_report.values()):
            warnings.append({'kind': 'ambiguous-device', 'message': f'{field} 在同一报告内不唯一，未进行跨文件匹配。'})
            continue
        for i, first in enumerate(rows):
            for second in rows[i + 1:]:
                if first['reportId'] == second['reportId']:
                    continue
                pair_key = tuple(sorted((first['key'], second['key'])))
                identity_conflict = any(first['identity'][f] and second['identity'][f]
                                        and first['identity'][f] != second['identity'][f] for f in ('uuid', 'serial'))
                host_conflict = machine_conflict(report_machines[first['reportId']], report_machines[second['reportId']])
                if identity_conflict or host_conflict:
                    blocked.add(pair_key)
                    warnings.append({'kind': 'identity-conflict', 'deviceKeys': list(pair_key),
                                     'message': '设备或机器身份存在冲突，两个来源保持分开。'})
                else:
                    candidates.setdefault(pair_key, []).append({'field': field, 'value': value})

    # Reject a transitive group when any member pair has a contradictory strong ID.
    parents = {device['key']: device['key'] for device in devices}
    by_key = {device['key']: device for device in devices}
    components = {device['key']: [device] for device in devices}
    def root(key):
        while parents[key] != key:
            parents[key] = parents[parents[key]]
            key = parents[key]
        return key
    links = []
    for pair_key, basis in sorted(candidates.items()):
        if pair_key in blocked:
            continue
        a, b = map(root, pair_key)
        if a != b:
            left, right = components[a], components[b]
            incompatible = any(x['reportId'] == y['reportId'] or
                               machine_conflict(report_machines[x['reportId']], report_machines[y['reportId']]) or
                               any(x['identity'][f] and y['identity'][f] and x['identity'][f] != y['identity'][f]
                                   for f in ('uuid', 'serial')) for x in left for y in right)
            if incompatible:
                warnings.append({'kind': 'identity-conflict', 'deviceKeys': list(pair_key),
                                 'message': '关联后的身份不一致，未继续合并设备。'})
                continue
            parents[b] = a
            left.extend(components.pop(b))
        links.append({'deviceKeys': list(pair_key), 'basis': basis, 'method': 'unique-identity'})
    grouped = {}
    for device in devices:
        grouped.setdefault(root(device['key']), []).append(device['key'])
    groups = [{'key': key, 'deviceKeys': keys} for key, keys in grouped.items()]
    differences = []
    for group in groups:
        keys = group['deviceKeys']
        if len(keys) < 2:
            continue
        fields = {}
        for key in keys:
            for field, rows in by_key[key]['fields'].items():
                for row in rows:
                    fields.setdefault(field, []).append({**deepcopy(row), 'deviceKey': key})
        for field, rows in fields.items():
            if len({row['value'] for row in rows}) > 1:
                differences.append({'groupKey': group['key'], 'field': field, 'values': rows,
                                    'message': '来源值不同，需结合各文件采集时间核对。'})

    machine_keys = list(report_machines)
    for i, first in enumerate(machine_keys):
        for second in machine_keys[i + 1:]:
            if machine_conflict(report_machines[first], report_machines[second]):
                warnings.append({'kind': 'machine-conflict', 'reportIds': [first, second],
                                 'message': '机器身份字段不同；人工归组不表示同一台机器或同次启动。'})
    for name, limit, rows in (('events', MAX_EVENTS, events), ('lifecycleEvents', MAX_EVENTS, lifecycle_events), ('snapshots', MAX_SNAPSHOTS, snapshots), ('checks', MAX_CHECKS, checks)):
        if row_counts[name] > len(rows):
            incomplete = True
            label = {'events': '事件', 'lifecycleEvents': '动作记录', 'snapshots': '状态快照', 'checks': '检查'}[name]
            warnings.append({'kind': 'limit', 'message': f'联合视图最多显示 {limit} 条{label}，完整记录保留在各来源报告中。'})
    all_events = events + lifecycle_events
    fully_anchored = bool(all_events) and all(row['timeInfo']['utc'] for row in all_events)
    if fully_anchored:
        events.sort(key=lambda row: (row['timeInfo']['utc'], row['reportId'], row.get('line', 0)))
        lifecycle_events.sort(key=lambda row: (row['timeInfo']['utc'], row['reportId'], row.get('line', 0)))
    else:
        warnings.append({'kind': 'time', 'message': '部分时间缺少年份、时区或仅为启动后秒数；按来源及原文顺序展示，不推断跨文件先后。'})
    return {'members': members, 'devices': devices, 'deviceGroups': groups, 'links': links,
            'fieldDifferences': differences, 'events': events, 'lifecycleEvents': lifecycle_events, 'snapshots': snapshots, 'checks': checks, 'counts': counts,
            'timeOrder': 'calendar' if fully_anchored else 'source', 'complete': not incomplete,
            'warnings': warnings}


class SessionStore:
    """Persist manifests separately from reports. Caller retains normal API auth."""
    def __init__(self, root, load_report):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.load_report = load_report
        self.lock = threading.RLock()

    def _path(self, key):
        path = self.root / (identifier(key) + '.json')
        if path.is_symlink() or path.resolve().parent != self.root:
            raise ValueError('无效关联路径')
        return path

    def _read(self, key):
        path = self._path(key)
        if path.stat().st_size > 65536:
            raise ValueError('关联记录过大')
        manifest = json.loads(path.read_text(encoding='utf-8'))
        if not isinstance(manifest, dict) or manifest.get('version') != 1 or manifest.get('id') != key:
            raise ValueError('关联记录格式不正确')
        members = manifest.get('members')
        if not isinstance(members, list) or not 2 <= len(members) <= MAX_MEMBERS:
            raise ValueError('关联成员格式不正确')
        seen = set()
        for member in members:
            if not isinstance(member, dict):
                raise ValueError('关联成员格式不正确')
            report_id = identifier(member.get('reportId'))
            if report_id in seen or not all(isinstance(member.get(k), str) for k in ('source', 'revision')):
                raise ValueError('关联成员格式不正确')
            seen.add(report_id)
        if not isinstance(manifest.get('name'), str):
            raise ValueError('关联名称格式不正确')
        if not isinstance(manifest.get('createdAt'), str) or manifest.get('method') != 'user-selected':
            raise ValueError('关联来源格式不正确')
        return manifest

    def _write(self, manifest):
        path = self._path(manifest['id'])
        temporary = self.root / (manifest['id'] + '.' + uuid.uuid4().hex + '.pending')
        try:
            with temporary.open('x', encoding='utf-8') as handle:
                json.dump(manifest, handle, ensure_ascii=False, separators=(',', ':'))
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)

    def create(self, ids, name=''):
        if not isinstance(ids, list) or not 2 <= len(ids) <= MAX_MEMBERS:
            raise ValueError(f'请选择 2 至 {MAX_MEMBERS} 份报告')
        for key in ids:
            identifier(key)
        if len(set(ids)) != len(ids):
            raise ValueError('同一份报告不能重复关联')
        if not isinstance(name, str) or len(name) > 120 or any(ord(c) < 32 for c in name):
            raise ValueError('关联名称不能超过 120 个字符或含控制字符')
        with self.lock:
            members = []
            for key in ids:
                report, revision = self.load_report(key)
                members.append({'reportId': key, 'source': report['source'], 'revision': revision})
            manifest = {'version': 1, 'id': uuid.uuid4().hex, 'name': name.strip() or '联合分析',
                        'method': 'user-selected', 'createdAt': datetime.now(timezone.utc).isoformat(),
                        'members': members}
            self._write(manifest)
            return self.get(manifest['id'])

    def get(self, key):
        with self.lock:
            manifest = self._read(key)
            loaded = {}
            for member in manifest['members']:
                try:
                    loaded[member['reportId']] = self.load_report(member['reportId'])
                except (OSError, ValueError):
                    pass
            return {'manifest': manifest, 'view': combine(manifest, loaded)}

    def list(self):
        with self.lock:
            rows, unreadable = [], 0
            for path in self.root.glob('*.json'):
                try:
                    manifest = self._read(path.stem)
                    rows.append({key: manifest[key] for key in ('id', 'name', 'createdAt', 'members', 'method')})
                except (OSError, ValueError, KeyError, TypeError):
                    unreadable += 1
            return {'sessions': sorted(rows, key=lambda row: (row['createdAt'], row['id']), reverse=True),
                    'unreadable': unreadable}

    def delete(self, key):
        with self.lock:
            self._path(key).unlink(missing_ok=True)
            return {'deleted': key}

    def refresh(self, key):
        """Explicitly accept reparsed content, but keep references to missing members."""
        with self.lock:
            manifest = self._read(key)
            for member in manifest['members']:
                try:
                    report, revision = self.load_report(member['reportId'])
                    member.update(source=report['source'], revision=revision)
                except (OSError, ValueError):
                    pass
            manifest['refreshedAt'] = datetime.now(timezone.utc).isoformat()
            self._write(manifest)
            return self.get(key)
