"""Local evidence bookmarks and reviewable, pseudonymized exports."""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
import hashlib
import hmac
import ipaddress
import json
import os
import re
import secrets
import tempfile
import threading
import uuid

from version import VERSION

MAX_RANGE = 200
MAX_BOOKMARKS = 1000
MAX_EXPORT_ITEMS = 100
MAX_EXPORT_BYTES = 2 * 1024 * 1024
MAX_STORE_BYTES = 8 * 1024 * 1024
KEY = re.compile(r'[a-f0-9]{32}')
HASH = re.compile(r'[a-f0-9]{64}')
_UNSET = object()
CATEGORIES = ('host', 'serial', 'uuid', 'ip', 'path')
WARNING = '自动脱敏不能覆盖全部自由文本。请检查预览中的名称、备注和原文，再下载分享。'


class EvidenceError(ValueError):
    """Fixed messages safe to expose through the local evidence API."""
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def bounded_text(value, limit, label):
    if not isinstance(value, str) or len(value) > limit or '\x00' in value:
        raise EvidenceError(label + '格式无效或超出长度限制')
    return value.strip()


def valid_revision(value):
    return isinstance(value, str) and 0 < len(value) <= 128 and not any(ord(char) < 32 or ord(char) == 127 for char in value)


def normalize_options(options):
    if options is None:
        options = {}
    if not isinstance(options, dict):
        raise EvidenceError('脱敏选项无效')
    if set(options) - {'redact', 'extra'}:
        raise EvidenceError('脱敏选项无效')
    selected = options.get('redact', {})
    if not isinstance(selected, dict) or any(k not in CATEGORIES or type(v) is not bool for k, v in selected.items()):
        raise EvidenceError('脱敏类别无效')
    extra = options.get('extra', [])
    if not isinstance(extra, list) or len(extra) > 100:
        raise EvidenceError('自定义替换内容最多 100 项')
    return {k: selected.get(k, True) for k in CATEGORIES}, sorted(set(bounded_text(x, 200, '自定义替换内容') for x in extra if x))


class Redactor:
    """Aliases remain stable within a local report; the secret is never exported."""
    def __init__(self, report, secret, texts, options=None):
        self.enabled, extra = normalize_options(options)
        self.secret = bytes.fromhex(secret)
        self.entries = {}
        self.counts = {}
        self.total = 0
        self._structured(report)
        for text in texts:
            self._discover(text)
        for value in extra:
            self._add('custom', value)
        # One regex replacement prevents a new alias from being processed again.
        keys = sorted(self.entries, key=lambda x: (-len(x), x))
        self.rules = [self.entries[key] for key in keys]
        patterns = []
        for index, key in enumerate(keys):
            category = self.entries[key][0]
            pattern = re.escape(key)
            if category in {'host', 'uuid'} or (category == 'path' and (re.match(r'^[A-Za-z]:', key) or key.startswith('\\\\'))):
                pattern = '(?i:'+pattern+')'
            patterns.append(f'(?P<r{index}>{pattern})')
        self.pattern = re.compile('|'.join(patterns)) if patterns else None

    def _add(self, category, value):
        if category in self.enabled and not self.enabled[category]:
            return
        if not isinstance(value, str):
            return
        value = value.strip()
        if not value or value.lower() in {'unknown', 'n/a', 'none', 'not available', '冲突', '0'}:
            return
        if len(value) > (4096 if category == 'secret' else 2048):
            raise EvidenceError('敏感字段过长，无法生成脱敏预览')
        # Structured identity fields win over later regex discoveries.
        if value not in self.entries:
            canonical = value.lower() if category in {'host', 'uuid'} else value
            if category == 'uuid' and re.fullmatch(r'gpu-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', canonical):
                canonical = canonical[4:]
            if category == 'path' and (re.match(r'^[A-Za-z]:', value) or value.startswith('\\\\')):
                canonical = re.sub(r'[\\/]+', '/', value).lower()
            if category == 'ip':
                canonical = str(ipaddress.ip_address(value))
            digest = hmac.new(self.secret, (category+'\0'+canonical).encode('utf-8'), hashlib.sha256).hexdigest()[:10]
            self.entries[value] = (category, '<'+category.upper()+'-'+digest+'>')

    def _structured(self, report):
        def fields(record, mapping):
            for key, category in mapping.items():
                self._add(category, record.get(key))
                for row in record.get('fields', {}).get(key, []):
                    self._add(category, row.get('value'))
        fields(report.get('server') or {}, {'host': 'host', 'sn': 'serial', 'uuid': 'uuid'})
        for gpu in report.get('gpus') or []:
            fields(gpu, {'sn': 'serial', 'serial': 'serial', 'uuid': 'uuid'})
        member = report.get('sourceMember')
        source_names = [report.get('source'), member.get('name') if isinstance(member, dict) else member]
        if isinstance(report.get('input'), dict):
            source_names.append(report['input'].get('name'))
        for value in source_names:
            if isinstance(value, str) and value:
                self._add('source', value)
                self._add('source', value.replace('\\', '/').rsplit('/', 1)[-1])

    def _discover(self, text):
        if not isinstance(text, str):
            return
        for match in re.finditer(r'\b(?:GPU-[A-Za-z0-9-]{3,}|[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12})\b', text, re.I):
            self._add('uuid', match[0])
        for match in re.finditer(r'(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])', text):
            try:
                ipaddress.ip_address(match[0])
                self._add('ip', match[0])
            except ValueError:
                pass
        for match in re.finditer(r'(?<![\w:])(?:[a-fA-F0-9]{0,4}:){2,}[a-fA-F0-9:.]*(?:%[A-Za-z0-9_.-]+)?(?![\w:])', text):
            try:
                value = match[0].rstrip('.')
                ipaddress.ip_address(value)
                self._add('ip', value)
            except ValueError:
                pass
        for match in re.finditer(r'''(?im)\b(?:serial number|board serial|serial|GPU SN|SN)["']?\s*[:=]\s*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s,;}\]]+))''', text):
            self._add('serial', next(value for value in match.groups() if value is not None))
        for match in re.finditer(r'''(?im)\b(?:hostname|host name|host_name|host|node name|node_name)["']?\s*[:=]\s*["']?([A-Za-z0-9_.-]+)''', text):
            self._add('host', match[1])
        for match in re.finditer(r'(?m)^(?:[A-Z][a-z]{2}\s+\d{1,2}\s+\d\d:\d\d:\d\d|\d{4}-\d\d-\d\dT\S+)\s+([A-Za-z0-9][A-Za-z0-9_.-]+)\s+', text):
            self._add('host', match[1])
        # Quoted paths may contain spaces; unquoted paths stop at separators.
        for match in re.finditer(r'''["']((?:[A-Za-z]:[\\/]|/|\\\\)[^\r\n"']+)["']|(?<![\w])((?:[A-Za-z]:[\\/]|/(?!/)|\\\\)[^\s<>"'|,;]+)''', text):
            self._add('path', match[1] or match[2])
        credentials = r'''(?im)\b(?P<key>password|passwd|pwd|api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|authorization)["']?\s*[:=]\s*(?:(?:Bearer|Basic)\s+)?(?:"(?P<double>(?:\\.|[^"\\\r\n])*)"|'(?P<single>(?:\\.|[^'\\\r\n])*)'|(?P<plain>[^\s,;]+))'''
        for match in re.finditer(credentials, text):
            value = next(value for value in (match['double'], match['single'], match['plain']) if value is not None)
            if match['key'].lower() == 'authorization':
                scheme = re.match(r'(?i)^(?:Bearer|Basic)\s+(.+)$', value)
                if scheme:
                    value = scheme[1]
            self._add('secret', value)
        for match in re.finditer(r'\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{24,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})(?![A-Za-z0-9_-])', text):
            self._add('secret', match[0])

    def text(self, text):
        def replace(match):
            category, alias = self.rules[int(match.lastgroup[1:])]
            self.counts[category] = self.counts.get(category, 0) + 1
            self.total += 1
            return alias
        return self.pattern.sub(replace, text) if self.pattern else text


class EvidenceStore:
    """Coordinates are bound to source content, while each operation checks revision."""
    def __init__(self, root, resolve, read):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.resolve, self.read = resolve, read
        self.lock = threading.RLock()

    def _path(self, key):
        if not isinstance(key, str) or not KEY.fullmatch(key):
            raise EvidenceError('报告不存在')
        path = self.root / (key+'.json')
        if path.is_symlink():
            raise EvidenceError('证据记录路径无效')
        return path

    def _current(self, key, revision=_UNSET, identity=_UNSET):
        self._path(key)
        if revision is not _UNSET and not valid_revision(revision):
            raise EvidenceError('报告修订无效，请刷新后重试')
        if identity is not _UNSET and (not isinstance(identity, str) or not HASH.fullmatch(identity)):
            raise EvidenceError('原文校验值无效，请刷新后重试')
        _, report, current_revision = self.resolve(key)
        current_identity = report.get('contentSha256')
        if not valid_revision(current_revision):
            raise EvidenceError('报告修订无效，请刷新后重试')
        if not isinstance(current_identity, str) or not HASH.fullmatch(current_identity):
            raise EvidenceError('此报告缺少内容校验值，请重新解析原日志')
        if revision is not _UNSET and revision != current_revision:
            raise EvidenceError('报告已变更，请刷新后重试')
        if identity is not _UNSET and identity != current_identity:
            raise EvidenceError('原日志内容已变更，不能沿用旧行号')
        return report, current_revision, current_identity

    def _load(self, key):
        path = self._path(key)
        if not path.exists():
            return {'version': 1, 'redactionKey': secrets.token_hex(32), 'items': []}
        try:
            if path.stat().st_size > MAX_STORE_BYTES:
                raise EvidenceError('记录超出大小限制')
            data = json.loads(path.read_text(encoding='utf-8'))
            if not isinstance(data, dict) or set(data) != {'version', 'redactionKey', 'items'} or type(data.get('version')) is not int or data['version'] != 1 or not isinstance(data.get('redactionKey'), str) or not HASH.fullmatch(data['redactionKey']):
                raise EvidenceError('记录格式无效')
            items = data.get('items')
            if not isinstance(items, list) or len(items) > MAX_BOOKMARKS:
                raise EvidenceError('记录数量无效')
            seen = set()
            for item in items:
                if not isinstance(item, dict) or set(item) != {'id', 'identity', 'revision', 'created', 'updated', 'start', 'end', 'title', 'note', 'tags'} or not KEY.fullmatch(item.get('id', '')) or item['id'] in seen or not HASH.fullmatch(item.get('identity', '')):
                    raise EvidenceError('书签格式无效')
                if not valid_revision(item['revision']):
                    raise EvidenceError('书签修订无效')
                for name in ('created', 'updated'):
                    value = item[name]
                    if not isinstance(value, str) or not 1 <= len(value) <= 64 or datetime.fromisoformat(value).tzinfo is None:
                        raise EvidenceError('书签时间无效')
                seen.add(item['id'])
                self._entry(item)
            return data
        except (OSError, ValueError, TypeError, KeyError) as error:
            raise EvidenceError('证据记录无法读取，原文件已保留；请恢复记录文件后重试', 422) from error

    def _write(self, key, data):
        payload = json.dumps(data, ensure_ascii=False, indent=2).encode('utf-8')
        if len(payload) > MAX_STORE_BYTES:
            raise EvidenceError('证据记录超出大小限制')
        path = self._path(key)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode='wb', prefix='.evidence-', suffix='.tmp', dir=self.root, delete=False) as out:
                temporary = Path(out.name)
                out.write(payload)
                out.flush()
                os.fsync(out.fileno())
            os.replace(temporary, path)
        except OSError as error:
            raise EvidenceError('证据记录保存失败，已有记录未覆盖', 503) from error
        finally:
            if temporary is not None:
                try:
                    temporary.unlink(missing_ok=True)
                except OSError:
                    pass

    @staticmethod
    def _entry(entry):
        if not isinstance(entry, dict):
            raise EvidenceError('书签内容无效')
        start, end = entry.get('start'), entry.get('end')
        if type(start) is not int or type(end) is not int or not 1 <= start <= end or end-start+1 > MAX_RANGE:
            raise EvidenceError('请选择连续的 1–200 行')
        tags = entry.get('tags', [])
        if not isinstance(tags, list) or len(tags) > 12:
            raise EvidenceError('标签最多 12 项')
        return {'start': start, 'end': end, 'title': bounded_text(entry.get('title', ''), 120, '标题'), 'note': bounded_text(entry.get('note', ''), 4000, '备注'), 'tags': list(dict.fromkeys(bounded_text(t, 40, '标签') for t in tags if t))}

    def _lines(self, key, revision, start, end):
        result = self.read(key, revision, start, end-start+1)
        if not isinstance(result, dict) or result.get('revision') != revision or result.get('start') != start:
            raise EvidenceError('原文读取版本不匹配，请刷新后重试')
        lines = result.get('lines')
        if not isinstance(lines, list) or len(lines) != end-start+1 or any(not isinstance(line, str) for line in lines):
            raise EvidenceError('所选范围超出可读取的原文')
        if sum(len(line.encode('utf-8')) for line in lines) > MAX_EXPORT_BYTES:
            raise EvidenceError('所选片段过大，请缩小行号范围')
        return lines

    def list(self, key):
        report, revision, identity = self._current(key)
        with self.lock:
            data = self._load(key)
        items = [{k: v for k, v in item.items() if k != 'revision'} | {'stale': item['identity'] != identity, 'reparsed': item.get('revision') != revision} for item in data['items']]
        return {'id': key, 'revision': revision, 'identity': identity, 'items': items, 'lines': report.get('lines', 0)}

    def save(self, key, revision, identity, entry):
        self._current(key, revision, identity)
        clean = self._entry(entry)
        self._lines(key, revision, clean['start'], clean['end'])
        record_id = entry.get('id')
        if record_id is not None and (not isinstance(record_id, str) or not KEY.fullmatch(record_id)):
            raise EvidenceError('书签编号无效')
        with self.lock:
            data = self._load(key)
            old = next((item for item in data['items'] if item['id'] == record_id), None)
            if record_id and old is None:
                raise EvidenceError('书签不存在，请刷新后重试')
            if old and old['identity'] != identity:
                raise EvidenceError('书签对应的原文已变化，请重新选取片段')
            if not old and len(data['items']) >= MAX_BOOKMARKS:
                raise EvidenceError('每份报告最多保存 1000 个书签')
            self._current(key, revision, identity)
            now = datetime.now(timezone.utc).isoformat(timespec='seconds')
            item = clean | {'id': record_id or uuid.uuid4().hex, 'identity': identity, 'revision': revision, 'created': old['created'] if old else now, 'updated': now}
            data['items'] = [x for x in data['items'] if x['id'] != item['id']] + [item]
            self._write(key, data)
        return {'saved': True, 'item': item}

    def delete(self, key, revision, identity, bookmark_id):
        self._current(key, revision, identity)
        if not isinstance(bookmark_id, str) or not KEY.fullmatch(bookmark_id):
            raise EvidenceError('书签编号无效')
        with self.lock:
            data = self._load(key)
            if not any(item['id'] == bookmark_id for item in data['items']):
                raise EvidenceError('书签不存在，请刷新后重试')
            data['items'] = [item for item in data['items'] if item['id'] != bookmark_id]
            self._current(key, revision, identity)
            self._write(key, data)
        return {'deleted': True}

    def remove_report(self, key):
        """Remove annotations after the owning report has been deleted."""
        with self.lock:
            self._path(key).unlink(missing_ok=True)

    def preview(self, key, revision, identity, ids, options=None):
        report, _, _ = self._current(key, revision, identity)
        if not isinstance(ids, list) or not 1 <= len(ids) <= MAX_EXPORT_ITEMS or any(not isinstance(x, str) or not KEY.fullmatch(x) for x in ids) or len(set(ids)) != len(ids):
            raise EvidenceError('请选择 1–100 个不同的证据书签')
        normalize_options(options)
        with self.lock:
            data = self._load(key)
        index = {item['id']: item for item in data['items']}
        if any(item_id not in index for item_id in ids):
            raise EvidenceError('部分书签不存在，请刷新后重试')
        selected = sorted((index[item_id] for item_id in ids), key=lambda item: (item['start'], item['end'], item['id']))
        entries, texts, size = [], [], 0
        for item in selected:
            if item['identity'] != identity:
                raise EvidenceError('所选书签包含旧版本内容，请重新选取片段')
            lines = self._lines(key, revision, item['start'], item['end'])
            values = [item['title'], item['note'], *item['tags'], *lines]
            size += sum(len(value.encode('utf-8')) for value in values)
            if size > MAX_EXPORT_BYTES:
                raise EvidenceError('导出内容超过 2 MiB，请减少选中的片段')
            texts.extend(values)
            entries.append({'start': item['start'], 'end': item['end'], 'title': item['title'], 'note': item['note'], 'tags': item['tags'], 'lines': lines})
        redactor = Redactor(report, data['redactionKey'], texts, options)
        safe = []
        for item in entries:
            safe.append({'start': item['start'], 'end': item['end'], 'title': redactor.text(item['title']), 'note': redactor.text(item['note']), 'tags': [redactor.text(tag) for tag in item['tags']], 'lines': [redactor.text(line) for line in item['lines']]})
        self._current(key, revision, identity)
        package = {'format': 'xidlens-evidence', 'version': 1, 'generator': 'XidLens '+VERSION, 'source': '报告 1', 'warning': WARNING, 'redacted': [k for k, enabled in redactor.enabled.items() if enabled], 'items': safe}
        plain = ['XidLens 日志证据', WARNING, '']
        for i, item in enumerate(safe, 1):
            line_range = str(item['start']) if item['start'] == item['end'] else f"{item['start']}–{item['end']}"
            plain.append(f"{i}. {item['title'] or '证据片段'} · 第 {line_range} 行")
            if item['tags']:
                plain.append('标签：'+'、'.join(item['tags']))
            if item['note']:
                plain.append('备注：'+item['note'])
            plain.extend(f"{item['start']+offset}: {line}" for offset, line in enumerate(item['lines']))
            plain.append('')
        # Only already-redacted payloads leave this boundary. No alias map or secret.
        return {'package': package, 'text': '\n'.join(plain), 'json': json.dumps(package, ensure_ascii=False, indent=2), 'replacements': redactor.counts, 'warning': WARNING}
