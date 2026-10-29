"""Validate saved reports at the read boundary; never rewrite their source files."""


def require(value, kind, path):
    if type(value) is not kind:
        raise ValueError(f'报告数据格式不正确：{path}')
    return value


def defaults(record, values, path):
    require(record, dict, path)
    for key, value in values.items():
        if key not in record: record[key] = value.copy() if isinstance(value, (list, dict)) else value
        require(record[key], type(value), path + '.' + key)


def evidence(value):
    defaults(value, {'line': 0, 'text': '', 'section': ''}, 'evidence')


def field_map(value):
    require(value, dict, 'fields')
    for rows in value.values():
        for row in require(rows, list, 'fields.values'):
            defaults(row, {'value': '', 'origin': '', 'evidence': {}}, 'field')
            evidence(row['evidence'])
            if 'bus_evidence' in row: evidence(row['bus_evidence'])


def diagnostics(data):
    require(data, dict, 'diagnostics')
    for key in ('snapshots', 'checks', 'topology', 'matrices', 'cpuRows'):
        require(data.get(key), list, 'diagnostics.' + key)
    for snapshot in data['snapshots']:
        defaults(snapshot, {'id': '', 'address': '', 'line': 0, 'fields': []}, 'snapshot')
        for field in snapshot['fields']:
            defaults(field, {'name': '', 'path': '', 'value': '', 'group': '', 'description': '', 'evidence': {}}, 'snapshot.field')
            evidence(field['evidence'])
    for check in data['checks']:
        defaults(check, {'id': '', 'status': '', 'address': '', 'title': '', 'evidence': []}, 'check')
        for ref in check['evidence']: evidence(ref)
    for edge in data['topology']:
        defaults(edge, {'address': '', 'parent': '', 'evidence': []}, 'topology')
        for ref in edge['evidence']: evidence(ref)
    for matrix in data['matrices']:
        defaults(matrix, {'id': '', 'mode': 'unknown', 'labels': [], 'rows': [], 'mapping': {}, 'evidence': {}, 'warnings': [], 'complete': False}, 'matrix')
        labels = matrix['labels']
        for label in labels: require(label, str, 'matrix.label')
        if not labels or len(labels) > 256 or len(set(labels)) != len(labels): raise ValueError('矩阵表头无效')
        evidence(matrix['evidence'])
        for address in matrix['mapping'].values(): require(address, str, 'matrix.mapping')
        for row in matrix['rows']:
            defaults(row, {'label': '', 'cells': [], 'affinity': [], 'evidence': {}}, 'matrix.row')
            for cell in row['cells'] + row['affinity']: require(cell, str, 'matrix.cell')
            if 'affinityValues' in row:
                for value in require(row['affinityValues'], dict, 'affinityValues').values(): require(value, str, 'affinityValues.value')
            evidence(row['evidence'])
        for name_rows in require(matrix.get('nicNames', {}), dict, 'nicNames').values():
            for row in require(name_rows, list, 'nicNames.rows'): defaults(row, {'name': ''}, 'nicName')
        for refs in require(matrix.get('mappingEvidence', {}), dict, 'mappingEvidence').values():
            for ref in require(refs, list, 'mappingEvidence.refs'): evidence(ref)
    for row in data['cpuRows']: defaults(row, {'CPU': '', 'NODE': '', 'SOCKET': ''}, 'cpuRow')


def optional_types(record, fields, path):
    require(record, dict, path)
    for key, kind in fields.items():
        if key in record: require(record[key], kind, path + '.' + key)


def bounded_integer(value, path, minimum=0):
    require(value, int, path)
    if value < minimum or value > 9007199254740991: raise ValueError('记录整数超出范围')


def event_clock(value):
    optional_types(value, {'kind': str, 'raw': str, 'epochMicroseconds': str}, 'time')
    require(value.get('kind'), str, 'time.kind')
    require(value.get('raw'), str, 'time.raw')
    for key in ('boot', 'utc'):
        if value.get(key) is not None: require(value[key], str, 'time.' + key)


def structured_evidence(value):
    optional_types(value, {'line': int, 'endLine': int, 'text': str, 'source': str, 'section': str,
                           'jsonPointer': str, 'truncated': bool}, 'structured.evidence')
    for key in ('line', 'endLine'):
        if key in value:
            bounded_integer(value[key], 'evidence.' + key)
            if value[key] > 2147483647: raise ValueError('来源行号超出范围')
    if 'time' in value: event_clock(value['time'])
    if value.get('boot_marker') is not None: require(value['boot_marker'], str, 'evidence.boot_marker')


def recovery_action(value):
    require(value, dict, 'recoveryAction')
    for key in ('previous', 'current'):
        if key in value: optional_types(value[key], {'code': str, 'label': str}, 'recoveryAction.' + key)


def association(value):
    optional_types(value, {'method': str, 'refs': list}, 'association')
    for row in value.get('refs', []):
        require(row, dict, 'association.ref')
        if 'evidence' in row: structured_evidence(row['evidence'])


def structured_event(value):
    optional_types(value, {'kind': str, 'address': str, 'code': str, 'message': str,
        'moduleSignature': str, 'deviceUUID': str, 'instanceId': str, 'originator': str,
        'traceId': str, 'groupCursor': str, 'driverVersion': str, 'experimental': bool,
        'identityConflict': bool, 'representations': list, 'rawFields': dict}, 'structured.event')
    for key in ('evidence',):
        if key in value: structured_evidence(value[key])
    for item in value.get('representations', []): structured_evidence(item)
    if 'timestamp' in value: event_clock(value['timestamp'])
    for key in ('category', 'moduleEventCode', 'switch', 'occurrences'):
        if key in value: bounded_integer(value[key], 'structured.event.' + key)


def lifecycle_events(value):
    require(value, list, 'lifecycleEvents')
    ids = set()
    for row in value:
        require(row, dict, 'lifecycleEvent')
        for key in ('id', 'kind', 'raw'):
            require(row.get(key), str, 'lifecycleEvent.' + key)
        if row['id'] in ids: raise ValueError('动作记录编号重复')
        ids.add(row['id'])
        optional_types(row, {'address': str, 'title': str, 'time': str, 'outcome': str,
                            'targetUUID': str, 'source': str, 'section': str}, 'lifecycleEvent')
        bounded_integer(row.get('line'), 'lifecycleEvent.line')
        if row.get('gpu') is not None: bounded_integer(row['gpu'], 'lifecycleEvent.gpu')
        if row.get('boot') is not None: require(row['boot'], str, 'lifecycleEvent.boot')
        if 'timeInfo' in row: event_clock(row['timeInfo'])
        if 'association' in row: association(row['association'])
        if 'recoveryAction' in row: recovery_action(row['recoveryAction'])


def structured_data(value):
    require(value, dict, 'structured')
    require(value.get('format'), str, 'structured.format')
    optional_types(value, {'source': str, 'parserVersion': str, 'recognized': bool,
        'complete': bool, 'warnings': list, 'events': list, 'experimental': bool,
        'deduplicationScope': str}, 'structured')
    for warning in value.get('warnings', []): require(warning, str, 'structured.warning')
    for row in value.get('events', []): structured_event(row)
    if value['format'] == 'dcgm-json' or 'dcgm' in value:
        dcgm = require(value.get('dcgm'), dict, 'structured.dcgm')
        for key in ('runs', 'results', 'summaries'): require(dcgm.get(key), list, 'dcgm.' + key)
        for run in dcgm['runs']:
            optional_types(run, {'version': str, 'driverVersion': str, 'metadata': dict, 'rawPointer': str}, 'dcgm.run')
            bounded_integer(run.get('run'), 'dcgm.run', 1)
            if 'evidence' in run: structured_evidence(run['evidence'])
            if run.get('runtimeEvidence') is not None: structured_evidence(run['runtimeEvidence'])
        for row in dcgm['results'] + dcgm['summaries']:
            optional_types(row, {'id': str, 'category': str, 'test': str, 'entity': dict,
                'resultKind': str, 'status': str, 'statusLabel': str}, 'dcgm.result')
            bounded_integer(row.get('run'), 'dcgm.result.run', 1)
            if 'evidence' in row: structured_evidence(row['evidence'])
    # Raw documents, payloads and unknown extensions remain untouched.


def incomplete(data, warning):
    data['complete'] = False
    if warning not in data['warnings']: data['warnings'].append(warning)


def optional_event_data(data):
    for event in data['events']:
        for key, validate in (('timeInfo', event_clock), ('recoveryAction', recovery_action),
                              ('structured', structured_event), ('association', association)):
            if key not in event: continue
            try: validate(event[key])
            except (ValueError, KeyError, TypeError):
                event.pop(key)
                incomplete(data, '部分事件附加数据结构不完整，原始事件仍保留，请重新解析原日志。')
        for key in ('occurrenceCount', 'representationCount'):
            if key not in event: continue
            try: bounded_integer(event[key], 'event.' + key)
            except (ValueError, TypeError):
                event.pop(key)
                incomplete(data, '部分事件附加数据结构不完整，原始事件仍保留，请重新解析原日志。')
        for key in ('deviceNamespace', 'targetUUID', 'source', 'timeKind'):
            if key in event and type(event[key]) is not str:
                event.pop(key)
                incomplete(data, '部分事件附加数据结构不完整，原始事件仍保留，请重新解析原日志。')


def normalize_report(data):
    require(data, dict, 'report')
    for key, kind in (('source', str), ('gpus', list), ('events', list)):
        require(data.get(key), kind, key)
    defaults(data, {'server': {}, 'nodes': {}, 'warnings': [], 'complete': True, 'lines': 0, 'topologyRaw': ''}, 'report')
    for warning in data['warnings']: require(warning, str, 'warnings')
    defaults(data['server'], {'fields': {}}, 'server'); field_map(data['server']['fields'])
    ids = set()
    for gpu in data['gpus']:
        defaults(gpu, {'id': 0, 'pci': '', 'label': '', 'fields': {}, 'pciFields': {}, 'metrics': {}, 'scopedMetrics': {}, 'healthCounters': []}, 'gpu')
        if gpu['id'] in ids: raise ValueError('GPU 编号重复')
        ids.add(gpu['id'])
        for key in ('fields', 'pciFields', 'metrics', 'scopedMetrics', 'healthFields'):
            if key in gpu: field_map(gpu[key])
        for row in gpu['healthCounters']:
            defaults(row, {'path': '', 'value': '', 'evidence': {}}, 'healthCounter'); evidence(row['evidence'])
        for key in ('uuid', 'sn', 'model'):
            if key in gpu: require(gpu[key], str, 'gpu.' + key)
    for event in data['events']:
        defaults(event, {'id': '', 'kind': '', 'code': '', 'address': '', 'raw': '', 'time': '', 'title': '', 'line': 0, 'actions': []}, 'event')
    optional_event_data(data)
    for node in data['nodes'].values():
        defaults(node, {'address': '', 'fields': {}}, 'node'); field_map(node['fields'])
        if 'evidence' in node: evidence(node['evidence'])
    if 'diagnostics' in data:
        try: diagnostics(data['diagnostics'])
        except (ValueError, KeyError, TypeError):
            data.pop('diagnostics')
            data['complete'] = False
            data['warnings'].append('诊断数据结构不完整，请在报告管理中重新解析原日志。')
    for key, validate, warning in (
        ('lifecycleEvents', lifecycle_events, '动作记录结构不完整，其他记录仍保留，请重新解析原日志。'),
        ('structured', structured_data, '结构化结果不完整，其他记录仍保留，请重新解析原日志。')):
        if key not in data: continue
        try: validate(data[key])
        except (ValueError, KeyError, TypeError):
            data.pop(key)
            incomplete(data, warning)
    return data
