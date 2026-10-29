"""Bounded, offline readers for diagnostic results and operational events.

DCGM JSON is a release-specific output, not a stable NVIDIA schema. GOE JSON
uses the explicitly named XidLens interchange format; GOE text is experimental.
No function in this module executes commands or accesses the network.
"""
from __future__ import annotations

from bisect import bisect_right
from datetime import datetime, timezone
import json
import math
import re

import gpu_summary_core as core

PARSER_VERSION = 'structured-v1'
MAX_JSON_BYTES = 16 * 1024 * 1024
MAX_RECORDS = 10000
MAX_NODES = 200000
MAX_DEPTH = 64
MAX_EVIDENCE = 16384
DCGM_ROOTS = ('DCGM Diagnostic', 'DCGM GPU Diagnostic')
DCGM_DOC = 'https://docs.nvidia.com/datacenter/dcgm/latest/reference/command-line-reference/dcgmi/dcgmi-diag.html'
SXID_DOC = 'https://docs.nvidia.com/datacenter/tesla/fabric-manager-user-guide/index.html#runtime-nvswitch-and-gpu-errors'
GOE_DOC = 'https://docs.nvidia.com/deploy/gpu-operational-events/analyzing-gpu-operational-events.html'
GOE_PREVIEW = 'GOE 为实验性解析；保留原始字段，需按产生记录的驱动版本核对。'
STATUS = {'pass': '通过', 'fail': '失败', 'warn': '警告', 'skip': '已跳过',
          'not_run': '未运行', 'not_recorded': '未记录结果', 'unknown': '未知结果'}
CHECK_STATUS = {'pass': 'ok', 'fail': 'error', 'warn': 'review', 'skip': 'missing',
                'not_run': 'missing', 'not_recorded': 'missing', 'unknown': 'missing'}
SXID_RE = re.compile(r'\bnvidia-nvswitch(?P<switch>\d+):\s*SXid\s*\(PCI:(?P<address>'
                     + core.BDF + r')\):\s*(?P<code>\d{1,8})\s*,?\s*(?P<message>.*)', re.I)
GOE_FIELDS = {'Source Module': 'moduleSignature', 'Module Signature': 'moduleSignature',
              'Category': 'category', 'Module Event Code': 'moduleEventCode',
              'Severity': 'severity', 'Log Level': 'logLevel', 'Scope': 'scope',
              'Originator': 'originator', 'Device UUID': 'deviceUUID', 'GPU UUID': 'deviceUUID',
              'Instance ID': 'instanceId', 'Timestamp': 'timestamp', 'Trace ID': 'traceId',
              'Group Cursor': 'groupCursor', 'Group Position': 'groupPosition',
              'Attributes': 'attributes', 'Group Attributes': 'groupAttributes',
              'Legacy Xid': 'legacyXid'}


class StructuredInputError(ValueError):
    """The input is malformed or exceeds a documented import bound."""


def _reject_constant(value):
    raise StructuredInputError('JSON 不允许非有限数值。')


def _finite_float(value):
    result = float(value)
    if not math.isfinite(result):
        raise StructuredInputError('JSON 数值超出有限数范围。')
    return result


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise StructuredInputError('JSON 含重复字段，未选择其中任一值。')
        result[key] = value
    return result


def _pointer(parent, value):
    return parent + '/' + str(value).replace('~', '~0').replace('/', '~1')


class JsonDocument:
    """Preserve the full document and locate values without guessing line numbers."""
    def __init__(self, text, source, max_bytes=MAX_JSON_BYTES):
        if not isinstance(text, str):
            raise StructuredInputError('JSON 输入必须为文本。')
        if len(text) > max_bytes or len(text.encode('utf-8')) > max_bytes:
            raise StructuredInputError('结构化 JSON 超过 16 MiB 读取上限。')
        self.text, self.source = text.lstrip('\ufeff'), source
        self.lines = [m.start() for m in re.finditer('\n', self.text)]
        # Bound nesting before the standard decoder allocates nested containers.
        quoted = escaped = False
        depth = 0
        for ch in self.text:
            if quoted:
                if escaped:
                    escaped = False
                elif ch == '\\':
                    escaped = True
                elif ch == '"':
                    quoted = False
            elif ch == '"':
                quoted = True
            elif ch in '[{':
                depth += 1
                if depth > MAX_DEPTH:
                    raise StructuredInputError('JSON 嵌套超过 64 层上限。')
            elif ch in ']}':
                depth -= 1
        try:
            self.data = json.loads(self.text, object_pairs_hook=_unique_object,
                                   parse_constant=_reject_constant, parse_float=_finite_float)
        except (json.JSONDecodeError, RecursionError, ValueError) as exc:
            if isinstance(exc, StructuredInputError):
                raise
            raise StructuredInputError('JSON 内容不完整或格式无效。') from exc
        self.positions = {}
        self.decoder = json.JSONDecoder()
        self._index(self._space(0), '')

    def _space(self, i):
        while i < len(self.text) and self.text[i] in ' \r\n\t':
            i += 1
        return i

    def _index(self, i, pointer):
        if len(self.positions) >= MAX_NODES:
            raise StructuredInputError('JSON 字段数量超过 200000 项上限。')
        start = i
        self.positions[pointer] = (start, start)
        opening = self.text[i]
        if opening == '{':
            i = self._space(i + 1)
            while self.text[i] != '}':
                key, i = self.decoder.raw_decode(self.text, i)
                i = self._space(self._space(i) + 1)  # colon
                i = self._space(self._index(i, _pointer(pointer, key)))
                if self.text[i] == ',':
                    i = self._space(i + 1)
                else:
                    break
            end = i + 1
        elif opening == '[':
            i, index = self._space(i + 1), 0
            while self.text[i] != ']':
                i = self._space(self._index(i, _pointer(pointer, index)))
                index += 1
                if self.text[i] == ',':
                    i = self._space(i + 1)
                else:
                    break
            end = i + 1
        else:
            _, end = self.decoder.raw_decode(self.text, i)
        self.positions[pointer] = (start, end)
        return end

    def evidence(self, pointer):
        start, end = self.positions.get(pointer, self.positions[''])
        return {'source': self.source, 'line': bisect_right(self.lines, start) + 1,
                'endLine': bisect_right(self.lines, max(start, end - 1)) + 1,
                'jsonPointer': pointer, 'text': self.text[start:min(end, start + MAX_EVIDENCE)],
                'truncated': end - start > MAX_EVIDENCE, 'section': '结构化 JSON',
                'time': {'kind': 'unknown', 'raw': ''}, 'boot_marker': None}


def _bundle(source, format_name=''):
    return {'format': format_name, 'parserVersion': PARSER_VERSION, 'source': source,
            'recognized': False, 'complete': True, 'warnings': [], 'events': [],
            'dcgm': {'runs': [], 'results': [], 'summaries': []}}


def _text(value):
    return str(value) if isinstance(value, (str, int, float)) and not isinstance(value, bool) else ''


def _status(value):
    key = re.sub(r'[\s_-]+', '', _text(value)).lower()
    return {'pass': 'pass', 'fail': 'fail', 'warn': 'warn', 'warning': 'warn',
            'skip': 'skip', 'skipped': 'skip', 'notrun': 'not_run'}.get(key, 'unknown')


def _list(value):
    return value if isinstance(value, list) else []


def _dcgm_runs(root):
    if not isinstance(root, dict):
        return []
    if any(key in root for key in DCGM_ROOTS):
        return [(root, '')]
    iterations = root.get('iterations')
    if isinstance(iterations, list) and any(isinstance(r, dict) and any(k in r for k in DCGM_ROOTS) for r in iterations):
        return [(r, '/iterations/' + str(i)) for i, r in enumerate(iterations)]
    return []


def _dcgm(document, max_records):
    root = document.data
    runs = _dcgm_runs(root)
    if not runs:
        return None
    bundle = _bundle(document.source, 'dcgm-json')
    bundle['recognized'] = True
    bundle['rawDocument'] = root  # Includes unknown fields; never silently drop them.
    bundle['dcgm']['overallResult'] = root.get('Overall Result')
    def add(row, pointer, run, category, name, result_kind='entity'):
        rows = bundle['dcgm']['results'] if result_kind == 'entity' else bundle['dcgm']['summaries']
        if len(bundle['dcgm']['results']) + len(bundle['dcgm']['summaries']) >= max_records:
            bundle['complete'] = False
            if 'DCGM 结果达到保存上限。' not in bundle['warnings']:
                bundle['warnings'].append('DCGM 结果达到保存上限。')
            return
        status = _status(row.get('status')) if 'status' in row else 'not_recorded'
        entity = {k: row[k] for k in ('entity_group', 'entity_group_id', 'entity_id', 'gpu_id', 'gpu_ids') if k in row}
        rows.append({'id': 'dcgm-' + str(len(bundle['dcgm']['results'])) + '-' + str(len(bundle['dcgm']['summaries'])),
                     'run': run, 'category': category, 'test': name, 'entity': entity,
                     'resultKind': result_kind, 'status': status, 'statusRaw': row.get('status'),
                     'statusLabel': STATUS[status], 'warnings': row.get('warnings', []),
                     'info': row.get('info', []), 'raw': row, 'evidence': document.evidence(pointer)})
    for run_number, (run, base) in enumerate(runs, 1):
        if not isinstance(run, dict):
            bundle['complete'] = False
            bundle['warnings'].append('DCGM 迭代结果格式无效。')
            continue
        names = [key for key in DCGM_ROOTS if key in run]
        if len(names) != 1 or not isinstance(run.get(names[0]), dict):
            bundle['complete'] = False
            bundle['warnings'].append('DCGM 诊断根字段无效或存在多个版本。')
            continue
        body = run[names[0]]
        body_pointer = _pointer(base, names[0])
        metadata = run.get('metadata') if isinstance(run.get('metadata'), dict) else {}
        version = _text(metadata.get('version') or body.get('version') or run.get('version'))
        bundle['dcgm']['runs'].append({'run': run_number, 'version': version, 'rawPointer': base,
            'driverVersion': _text(metadata.get('Driver Version Detected') or body.get('Driver Version Detected') or run.get('Driver Version Detected')),
            'metadata': metadata, 'entityGroups': run.get('entity_groups', []),
            'runtimeError': body.get('runtime_error', run.get('runtime_error')),
            'runtimeEvidence': document.evidence(_pointer(body_pointer if 'runtime_error' in body else base, 'runtime_error'))
                               if 'runtime_error' in body or 'runtime_error' in run else None,
            'warning': body.get('Warning', run.get('Warning')), 'evidence': document.evidence(body_pointer)})
        if not version:
            bundle['warnings'].append('DCGM 产生版本未记录，需核对原始结果。')
        categories = body.get('test_categories')
        if categories is not None and not isinstance(categories, list):
            bundle['complete'] = False
            bundle['warnings'].append('DCGM test_categories 不是列表。')
            continue
        for ci, category in enumerate(_list(categories)):
            cp = _pointer(_pointer(body_pointer, 'test_categories'), ci)
            if not isinstance(category, dict):
                bundle['complete'] = False
                continue
            if not isinstance(category.get('tests'), list):
                bundle['complete'] = False
                bundle['warnings'].append('DCGM tests 不是列表。')
            for ti, test in enumerate(_list(category.get('tests'))):
                tp = _pointer(_pointer(cp, 'tests'), ti)
                if not isinstance(test, dict):
                    bundle['complete'] = False
                    continue
                name = _text(test.get('name')) or '未命名测试'
                result_rows = test.get('results')
                if result_rows is not None and not isinstance(result_rows, list):
                    bundle['complete'] = False
                    bundle['warnings'].append('DCGM results 不是列表，未解释为测试通过。')
                for ri, result in enumerate(_list(result_rows)):
                    if isinstance(result, dict):
                        add(result, _pointer(_pointer(tp, 'results'), ri), run_number, _text(category.get('category')), name)
                    else:
                        bundle['complete'] = False
                summary = test.get('test_summary')
                if isinstance(summary, dict):
                    add(summary, _pointer(tp, 'test_summary'), run_number, _text(category.get('category')), name, 'summary')
                elif not result_rows:
                    add({}, tp, run_number, _text(category.get('category')), name, 'summary')
    if not bundle['dcgm']['results'] and not bundle['dcgm']['summaries']:
        bundle['warnings'].append('DCGM 未记录可读取的测试结果。')
    bundle['warnings'] = list(dict.fromkeys(bundle['warnings']))
    return bundle


def parse_dcgm_json(text, source='', *, max_bytes=MAX_JSON_BYTES, max_records=MAX_RECORDS):
    """Return a bundle for recognized DCGM JSON, None for another JSON schema."""
    return _dcgm(JsonDocument(text, source, max_bytes), max_records)


def _uint(value, bits=64):
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        number = value
    elif isinstance(value, str) and re.fullmatch(r'(?:0x[0-9a-fA-F]+|[0-9]+)', value.strip()):
        try:
            number = int(value, 16 if value.strip().lower().startswith('0x') else 10)
        except ValueError:
            return None
    else:
        return None
    return number if 0 <= number < 2**bits else None


def _display_number(value, bits=64):
    direct = _uint(value, bits)
    if direct is not None:
        return direct
    # The preview CLI prints an unknown label alongside a valid numeric code.
    matches = re.findall(r'(?<![\w])(?:0x[0-9a-fA-F]+|\d+)(?![\w])', _text(value))
    return _uint(matches[0], bits) if len(matches) == 1 else None


def _goe_record(raw, evidence, *, rendered=False, driver_version=''):
    module = _text(raw.get('moduleSignature'))
    category = _display_number(raw.get('category'), 16)
    code = _display_number(raw.get('moduleEventCode'), 16)
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,15}', module) or category is None or code is None:
        return None
    stamp = _uint(raw.get('timestamp'))
    time = {'kind': 'unknown', 'raw': _text(raw.get('timestamp'))}
    if stamp is not None:
        # Do not pass microsecond timestamps through a JS number (2**53 bound).
        try:
            seconds, micros = divmod(stamp, 1000000)
            iso = datetime.fromtimestamp(seconds, timezone.utc).replace(microsecond=micros).isoformat()
            time = {'kind': 'calendar', 'raw': iso, 'epochMicroseconds': str(stamp)}
        except (ValueError, OverflowError, OSError):
            pass
    elif time['raw']:
        parsed = core.timestamp(time['raw'])
        if parsed['kind'] != 'unknown':
            time = parsed
    legacy = _display_number(raw.get('legacyXid'), 32)
    ev = {'kind': 'goe', 'address': '', 'code': f'{module}/{category:#06x}/{code:#06x}',
          'moduleSignature': module, 'category': category, 'moduleEventCode': code,
          'deviceUUID': _text(raw.get('deviceUUID')), 'severity': raw.get('severity'),
          'severityDomain': 'host-cper' if rendered else 'event-scope',
          'logLevel': raw.get('logLevel'), 'scope': raw.get('scope'),
          'originator': _text(raw.get('originator')), 'instanceId': _text(raw.get('instanceId')),
          'timestamp': time, 'traceId': _text(raw.get('traceId')), 'groupCursor': _text(raw.get('groupCursor')),
          'groupPosition': raw.get('groupPosition'), 'legacyXid': legacy,
          'driverVersion': driver_version, 'experimental': True, 'rawFields': raw,
          'evidence': evidence, 'representations': [evidence], 'occurrences': 1}
    ev['evidence']['time'] = time
    if legacy is not None:
        ev['relations'] = [{'kind': 'legacy-xid-hint', 'code': str(legacy), 'merged': False,
                            'reason': 'no-verified-same-source-reference'}]
    if rendered:
        ev['severityNote'] = 'event-log 的 Severity 按 CPER 主机范围显示，不能直接解释为 GPU 影响。'
    return ev


def _goe_key(event):
    keys = ('deviceUUID', 'originator', 'instanceId', 'moduleSignature', 'category', 'moduleEventCode')
    if not all(event.get(k) not in (None, '') for k in keys):
        return None
    stamp = event.get('timestamp', {}).get('epochMicroseconds')
    if stamp is None:
        return None
    return tuple(event[k] for k in keys) + (stamp,)


def deduplicate_goe(events):
    """Only merge repeated representations of an exactly identified occurrence.

    A Trace ID denotes an incident and cannot identify one event. A legacy Xid
    code alone is likewise not a safe deduplication key.
    """
    result, known = [], {}
    for event in events:
        key = _goe_key(event) if event.get('kind') == 'goe' else None
        previous = known.get(key) if key is not None else None
        if previous is not None:
            # Conflicting payloads may be separate events or a decoder mismatch.
            # Preserve both instead of choosing a representation silently.
            if previous.get('rawFields') == event.get('rawFields'):
                previous['representations'].extend(event.get('representations', [event['evidence']]))
                continue
            event['identityConflict'] = previous['identityConflict'] = True
        result.append(event)
        if key is not None and previous is None:
            known[key] = event
    return result


def _goe(document, max_records):
    root = document.data
    if not isinstance(root, dict) or root.get('format') != 'xidlens-goe':
        return None
    if type(root.get('formatVersion')) is not int or root['formatVersion'] != 1:
        raise StructuredInputError('不支持的 XidLens GOE 交换格式版本。')
    if not isinstance(root.get('events'), list):
        raise StructuredInputError('GOE events 必须为列表。')
    bundle = _bundle(document.source, 'xidlens-goe-v1')
    bundle.update(recognized=True, experimental=True, rawDocument=root)
    bundle['warnings'].append(GOE_PREVIEW)
    for index, raw in enumerate(root['events']):
        if index >= max_records:
            bundle['complete'] = False
            bundle['warnings'].append('GOE 事件达到保存上限。')
            break
        event = _goe_record(raw, document.evidence('/events/' + str(index)),
                            driver_version=_text(root.get('driverVersion'))) if isinstance(raw, dict) else None
        if event:
            bundle['events'].append(event)
        else:
            bundle['complete'] = False
            bundle['warnings'].append(f'第 {index + 1} 项 GOE 缺少有效的模块、类别或事件码，原始项已保留。')
    bundle['events'] = deduplicate_goe(bundle['events'])
    return bundle


def parse_goe_json(text, source='', *, max_bytes=MAX_JSON_BYTES, max_records=MAX_RECORDS):
    """Read the documented XidLens format, never infer an NVIDIA JSON schema."""
    return _goe(JsonDocument(text, source, max_bytes), max_records)


def parse_sxid_line(line, n=1, source='', section='输入正文', boot=None):
    match = SXID_RE.search(line)
    if not match:
        return None
    message = match['message']
    severity = 'non-fatal' if re.match(r'Non[- ]fatal\b', message, re.I) else 'fatal' if re.match(r'Fatal\b', message, re.I) else 'unknown'
    continuation = bool(re.match(r'(?:Severity\s+\d|Data\s*\{)', message, re.I))
    link = re.search(r'\bLink\s+(\d+)\b', message, re.I)
    evidence = {'source': source, 'line': n, 'text': line[:MAX_EVIDENCE],
                'truncated': len(line) > MAX_EVIDENCE, 'section': section,
                'boot_marker': boot, 'time': core.timestamp(line)}
    return {'kind': 'sxid', 'address': core.bdf(match['address']), 'code': match['code'],
            'switch': int(match['switch']), 'severity': severity, 'continuation': continuation,
            'link': int(link[1]) if link else None, 'message': message[:MAX_EVIDENCE],
            'evidence': evidence, 'representations': [evidence], 'occurrences': 1,
            'lastLine': n}


class Collector:
    """Streaming companion to parser.Parser; accepts unmodified source lines."""
    def __init__(self, source, max_json_bytes=MAX_JSON_BYTES, max_records=MAX_RECORDS):
        self.source, self.max_json_bytes, self.max_records = source, max_json_bytes, max_records
        self.result = _bundle(source)
        self.json_mode = None
        self.json_lines, self.json_bytes, self.json_overflow = [], 0, False
        self.goe_enabled = False
        self.goe_lines, self.goe_fields, self.goe_start = [], {}, None
        self.goe_device = ''
        self.goe_driver = ''
        self.sxid_previous = None
        self.finished = False

    def _append(self, event):
        if len(self.result['events']) >= self.max_records:
            self.result['complete'] = False
            warning = '结构化事件达到保存上限。'
            if warning not in self.result['warnings']:
                self.result['warnings'].append(warning)
            return
        self.result['recognized'] = True
        self.result['events'].append(event)

    def _flush_goe(self):
        if not self.goe_fields:
            return
        raw = dict(self.goe_fields)
        if self.goe_device and not raw.get('deviceUUID'):
            raw['deviceUUID'] = self.goe_device
        text = '\n'.join(line for _, line in self.goe_lines)
        evidence = {'source': self.source, 'line': self.goe_start or 1,
                    'endLine': self.goe_lines[-1][0] if self.goe_lines else self.goe_start,
                    'text': text[:MAX_EVIDENCE], 'truncated': len(text) > MAX_EVIDENCE,
                    'section': 'nvidia-smi event-log', 'boot_marker': None,
                    'time': {'kind': 'unknown', 'raw': ''}}
        event = _goe_record(raw, evidence, rendered=True, driver_version=self.goe_driver)
        if event:
            self._append(event)
            self.result['experimental'] = True
            if GOE_PREVIEW not in self.result['warnings']:
                self.result['warnings'].append(GOE_PREVIEW)
        elif any(k in raw for k in ('moduleSignature', 'category', 'moduleEventCode')):
            self.result['complete'] = False
            self.result['warnings'].append('event-log 块缺少有效的事件标识，未推断类别或事件码。')
        self.goe_lines, self.goe_fields, self.goe_start = [], {}, None

    def consume(self, line, n, section='输入正文', boot=None):
        if self.finished:
            raise ValueError('Collector 已结束。')
        if not isinstance(line, str) or type(n) is not int or n < 1:
            raise ValueError('需要文本和有效原始行号。')
        stripped = line.lstrip('\ufeff').strip()
        if self.json_mode is None and not stripped:
            # Retain leading blank lines so JSON pointers report real line numbers.
            self.json_lines.append(line)
            self.json_bytes += len(line.encode('utf-8')) + 1
            if self.json_bytes > self.max_json_bytes:
                self.json_overflow = True
                self.json_lines.clear()
            return False
        if self.json_mode is None:
            # Supported JSON documents have object roots. Kernel timestamps use
            # square brackets and must never trigger the JSON reader.
            self.json_mode = stripped.startswith('{')
            if not self.json_mode:
                self.json_lines.clear()
        if self.json_mode:
            self.json_bytes += len(line.encode('utf-8')) + 1
            if self.json_bytes > self.max_json_bytes:
                self.json_overflow = True
                self.json_lines.clear()
            elif not self.json_overflow:
                self.json_lines.append(line)
            return False
        sxid = parse_sxid_line(line, n, self.source, section, boot)
        if sxid:
            previous = self.sxid_previous
            if (sxid['continuation'] and previous and previous['lastLine'] == n - 1
                    and previous['address'] == sxid['address'] and previous['code'] == sxid['code']
                    and previous['switch'] == sxid['switch'] and previous['evidence']['boot_marker'] == boot):
                previous['representations'].append(sxid['evidence'])
                previous['lastLine'] = n
            else:
                self._append(sxid)
                self.sxid_previous = sxid
            return True
        if re.search(r'\bnvidia-smi\s+event-log\b', line) or re.match(r'^\s*(?:=+\s*)?GPU Operational Events?\b', line, re.I):
            self._flush_goe()
            self.goe_enabled = True
            self.goe_device = ''
            return False
        if core.section_boundary(line) or stripped.startswith('-- Boot'):
            self._flush_goe()
            self.goe_enabled = 'nvidia-smi event-log' in line
            self.goe_device = ''
        if not self.goe_enabled:
            return False
        if re.match(r'^\s*(?:Event|Event Group)\s+(?:\d+|#\d+)\s*:?.*$', line, re.I):
            self._flush_goe()
        pair = re.match(r'^\s*([^:]{1,80})\s*:\s*(.*?)\s*$', line)
        if pair:
            name, value = pair[1].strip(), pair[2]
            key = GOE_FIELDS.get(name)
            if key == 'moduleSignature' and 'moduleSignature' in self.goe_fields:
                self._flush_goe()
            if name == 'Driver Version':
                self.goe_driver = value
            if key == 'deviceUUID':
                if ('moduleSignature' in self.goe_fields and self.goe_fields.get('deviceUUID')
                        and self.goe_fields['deviceUUID'] != value):
                    self._flush_goe()
                self.goe_device = value
            if key or self.goe_fields:
                self.goe_fields[key or name] = value
                if self.goe_start is None:
                    self.goe_start = n
                self.goe_lines.append((n, line))
        elif self.goe_fields and stripped:
            self.goe_lines.append((n, line))
        if len(self.goe_lines) > 512:
            self._flush_goe()
            self.result['complete'] = False
            self.result['warnings'].append('event-log 块超过 512 行，已按读取边界保留。')
        return bool(self.goe_fields)

    def finish(self):
        if self.finished:
            return self.result
        self.finished = True
        self._flush_goe()
        if self.json_mode:
            if self.json_overflow:
                self.result['complete'] = False
                self.result['warnings'].append('结构化 JSON 超过读取上限，未解析剩余内容。')
            else:
                try:
                    document = JsonDocument('\n'.join(self.json_lines), self.source, self.max_json_bytes)
                    parsed = _dcgm(document, self.max_records) or _goe(document, self.max_records)
                    if parsed:
                        self.result = parsed
                except StructuredInputError as exc:
                    self.result['complete'] = False
                    self.result['warnings'].append(str(exc))
        self.result['events'] = deduplicate_goe(self.result['events'])
        self.result['warnings'] = list(dict.fromkeys(self.result['warnings']))
        return self.result


def merge_into_report(report, bundle):
    """Attach parsed data to an app report without inventing GPU identities.

    DCGM entity indices stay report-local. GOE joins an existing GPU only when
    its non-conflicting UUID is unique in that report. SXid remains NVSwitch.
    """
    if not bundle.get('recognized') and not bundle.get('warnings'):
        return report
    report['structured'] = bundle
    bundle['deduplicationScope'] = 'within-source-complete-goe-identity'
    report['recognized'] = bool(report.get('recognized') or bundle.get('recognized'))
    report['complete'] = bool(report.get('complete', True) and bundle.get('complete', True))
    report['warnings'] = list(dict.fromkeys(report.get('warnings', []) + bundle.get('warnings', [])))
    if bundle.get('recognized'):
        report['warnings'] = [w for w in report['warnings'] if w != '未识别到支持的 GPU 日志结构或错误记录。']
    gpus = report.get('gpus', [])
    for record in bundle.get('events', []):
        ev = record['evidence']
        gpu = None
        if record['kind'] == 'goe' and record.get('deviceUUID'):
            matching = [g for g in gpus if g.get('uuid') == record['deviceUUID'] and g.get('uuid') != '冲突']
            if len(matching) == 1:
                gpu = matching[0]
        time = record.get('timestamp', ev.get('time', {}))
        row = {'id': 'structured-e' + str(len(report.setdefault('events', []))),
               'gpu': gpu['id'] if gpu else None, 'address': gpu['pci'] if gpu else record.get('address', ''),
               'kind': record['kind'], 'code': record['code'], 'time': time.get('raw') or '—',
               'timeKind': time.get('kind', 'unknown'), 'timeInfo': dict(time),
               'title': ('NVSwitch SXid ' if record['kind'] == 'sxid' else 'GOE ') + record['code'],
               'description': record.get('message', record.get('severityNote', GOE_PREVIEW)), 'actions': [],
               'line': ev['line'], 'raw': ev['text'], 'truncated': ev.get('truncated', False),
               'section': ev.get('section', ''), 'boot': ev.get('boot_marker'), 'manual': None,
               'source': bundle['source'], 'structured': record,
               'deviceNamespace': 'nvswitch' if record['kind'] == 'sxid' else 'gpu',
               'occurrenceCount': 1, 'representationCount': len(record.get('representations', []))}
        if record['kind'] == 'goe':
            row['targetUUID'] = record.get('deviceUUID', '')
            if record.get('legacyXid') is not None:
                row['relations'] = [{'kind': 'legacy-xid-hint', 'code': str(record['legacyXid']),
                                     'merged': False, 'reason': 'no-verified-same-source-reference'}]
        report['events'].append(row)
    checks = report.setdefault('diagnostics', {}).setdefault('checks', [])
    dcgm = bundle.get('dcgm', {})
    for run in dcgm.get('runs', []):
        if run.get('runtimeError'):
            checks.append({'id': 'structured-dcgm-runtime-' + str(run['run']), 'rule': 'dcgm',
                           'address': '', 'status': 'review', 'title': 'DCGM 运行未完成',
                           'observation': _text(run['runtimeError']) or '原始结果含运行错误。',
                           'basis': '执行错误需结合原文核对，不能视为硬件测试失败或通过。',
                           'evidence': [run.get('runtimeEvidence') or run['evidence']], 'source': DCGM_DOC, 'structured': run})
    # Summaries remain accessible but do not double-count already listed entity results.
    rows = list(dcgm.get('results', []))
    indexed = {(r['run'], r['category'], r['test']) for r in rows}
    rows += [r for r in dcgm.get('summaries', []) if (r['run'], r['category'], r['test']) not in indexed]
    for row in rows:
        entity = row['entity']
        target = (f"{entity.get('entity_group', '实体')} {entity['entity_id']}" if 'entity_id' in entity
                  else 'GPU ' + _text(entity.get('gpu_id', entity.get('gpu_ids'))) if entity else '测试汇总')
        checks.append({'id': 'structured-' + row['id'], 'rule': 'dcgm', 'address': '',
                       'status': CHECK_STATUS[row['status']], 'title': 'DCGM · ' + row['test'],
                       'observation': f"{target} · {row['statusLabel']} · 第 {row['run']} 次结果",
                       'basis': '仅表示该次测试结果；实体编号未作为跨文件设备身份。',
                       'evidence': [row['evidence']], 'source': DCGM_DOC, 'structured': row})
    return report
