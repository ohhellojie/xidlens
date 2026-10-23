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
    for node in data['nodes'].values():
        defaults(node, {'address': '', 'fields': {}}, 'node'); field_map(node['fields'])
        if 'evidence' in node: evidence(node['evidence'])
    if 'diagnostics' in data:
        try: diagnostics(data['diagnostics'])
        except (ValueError, KeyError, TypeError):
            data.pop('diagnostics')
            data['complete'] = False
            data['warnings'].append('诊断数据结构不完整，请在报告管理中重新解析原日志。')
    return data
