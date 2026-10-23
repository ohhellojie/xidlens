"""Structured offline snapshots and evidence-based checks. No hardware operations."""
from __future__ import annotations

import re
import math
from types import SimpleNamespace
import gpu_summary_core as core

SMI_DOC = 'https://docs.nvidia.com/deploy/nvidia-smi/index.html'
AER_DOC = 'https://docs.kernel.org/PCI/pcieaer-howto.html'
STATUS = {'error': '发现错误', 'review': '待核实', 'ok': '未见异常', 'missing': '数据不足'}
READ_ERRORS = {'gpu requires reset', 'unknown error', 'gpu is lost', 'insufficient permissions'}
BDF = r'(?:[\da-fA-F]{4,8}:)?[\da-fA-F]{2}:[\da-fA-F]{2}\.[0-7]'
PCI = re.compile(r'^(' + BDF + r')\s+(.+)')
RELATION = re.compile(r'X|SYS|NODE|PHB|PXB|PIX|NV\d+')
RELATION_TOKEN = re.compile(r'[A-Z][A-Z0-9_/-]{0,23}')
LOG_PREFIX = re.compile(r'^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[,.]\d+)?\s+-\s+(?:DEBUG|INFO|WARNING|ERROR|CRITICAL)\s+-\s*')
ANSI_CSI = re.compile(r'\x1b\[[0-?]*[ -/]*[@-~]')


def unique(fields, key):
    values = {v['value'] for v in fields.get(key, [])}
    return next(iter(values)) if len(values) == 1 else ''


def numeric(value):
    m = re.fullmatch(r'(\d+(?:\.\d+)?)\s*(?:W|C|%|MHz|MiB|GT/s|x)?', value)
    number = float(m[1]) if m else None
    return number if number is not None and math.isfinite(number) else None


def group(path):
    if any(x in path for x in ('ECC', 'Memory', 'Remapped', 'Retired')): return '显存与 ECC'
    if any(x in path for x in ('Power', 'Temperature', 'Temp', 'Fan')): return '温度与功耗'
    if path.startswith('PCI/') or 'Replay' in path: return 'PCIe 链路'
    if any(x in path for x in ('Clock', 'Performance', 'Utilization')): return '时钟与性能'
    if any(x in path for x in ('Mode', 'MIG', 'Accounting')): return '配置与模式'
    return '概览'


def describe(path):
    leaf = path.split('/')[-1]
    if 'ECC Errors/' in path:
        period = '自驱动加载以来累计' if '/Volatile/' in path else '设备保留的累计计数' if '/Aggregate/' in path else '按日志所列统计范围记录'
        return f'ECC 错误计数，{period}。纠错类型与内存位置由字段路径指定。单位：次。'
    if 'Remapped Rows/' in path:
        if 'Failure' in leaf: return '行重映射是否发生失败，Yes 表示检测到失败状态。'
        if 'Pending' in leaf: return '是否存在等待 GPU 复位后生效的行重映射。'
        return 'GPU 显存行重映射统计；可用性与 GPU 架构及驱动支持有关。'
    if 'Retired Pages/' in path: return '因显存错误退出使用的页及待处理状态，按单比特或双比特错误分类。'
    if 'Link Width' in path: return 'PCIe 链路通道数。Current 为采集时协商宽度；Max 为报告的最大宽度。当前值应结合链路两端能力、插槽布线和运行状态核对。'
    if 'Link Gen' in path or 'PCIe Generation' in path: return 'PCIe 链路代际。Current 为采集时协商代际；Max 为报告的最大代际。空闲状态可能降低当前链路速率。'
    if 'Replay' in path: return 'PCIe 重传相关累计计数。需结合相同统计周期内的增量与 AER 记录评估。'
    if 'FB Memory Usage/' in path: return 'GPU 帧缓冲显存容量或占用量，单位由采集值给出；Used 包括驱动与系统保留的相关占用。'
    if 'Temperature/' in path: return 'GPU 或显存的温度读数及设备报告的温度阈值。单位：摄氏度。'
    if 'Power' in path: return '设备报告的功率读数或功率限制。单位：瓦；Average 与 Instantaneous 分别表示平均和瞬时读数。'
    if 'Clocks Event Reasons/' in path or 'Clocks Throttle Reasons/' in path: return '时钟受到限制的原因。Active 表示该条件在采集时生效；功率限制等条件需结合运行负载判断。'
    if 'Clocks/' in path: return '对应时钟域的运行频率。单位：MHz。'
    if 'Utilization/' in path: return '采样周期内对应引擎或内存接口忙碌时间的百分比。'
    if leaf == 'Performance State': return 'GPU 性能状态，P0 为最高性能状态，P12 为最低性能状态。'
    if 'MIG Mode/' in path: return '多实例 GPU 模式。Current 为当前模式，Pending 为待生效模式。'
    if leaf == 'Persistence Mode': return '持久化模式控制无活动客户端时 NVIDIA 驱动是否保持加载。'
    if leaf == 'Compute Mode': return 'GPU 对计算上下文的接入策略。'
    return '设备在该字段路径下报告的采集值；保留原始单位、支持状态和采集范围。'


class Collector:
    """Bounded, independently scoped parser for diagnostic sections."""
    def __init__(self, owner):
        self.owner = owner
        self.snapshots, self.matrices, self.paths, self.cpu_rows = [], [], {}, []
        self.nic_paths = {}
        self.sysfs_nic = None
        self.snapshot = self.matrix = self.pci = None
        self.hierarchy = []
        self.mode = 'unknown'
        self.cpu_columns = None
        self.count = 0

    def evidence(self, n, line):
        return self.owner.evidence(n, line)

    def consume(self, line, n):
        s = LOG_PREFIX.sub('', ANSI_CSI.sub('', line).strip())
        boundary = core.section_boundary(s)
        command = re.search(r'\bnvidia-smi\s+topo\s+(-mp|-m)(?:\s|$)', s)
        other_topo = re.search(r'\bnvidia-smi\s+topo\s+-(?!mp\b|m\b)\S+', s)
        if boundary or command or other_topo or re.match(r'(?:\$\s*)?(?:sudo\s+)?(?:lspci|lscpu|nvidia-smi)\b', s):
            self.snapshot = self.matrix = self.pci = None
            self.hierarchy = []
            self.cpu_columns = None
            self.mode = 'mp' if command and command[1] == '-mp' else 'm' if command else 'unsupported' if other_topo else 'unknown'
            nic = re.search(r'/sys/class/(?:infiniband|net)/([^/\s]+)/device', s)
            self.sysfs_nic = nic[1] if nic else None
        if self.count >= 50000:
            self.owner.r['complete'] = False
            self.owner.warn('状态与拓扑字段达到 50000 条保存上限。')
            return
        m = core.SMI_GPU_RE.match(line)
        if m:
            self.snapshot = {'id': f's{len(self.snapshots)}', 'address': core.bdf(m[1]), 'line': n, 'fields': [], 'evidence': self.evidence(n, line)}
            self.snapshots.append(self.snapshot); self.count += 1
            self.hierarchy = []; self.pci = self.matrix = None
            self.owner.r['recognized'] = True
            return
        if re.match(r'Attached GPUs\s*:', s): self.snapshot = None
        if self.snapshot and s:
            indent = len(line.expandtabs(8)) - len(line.expandtabs(8).lstrip())
            if not indent:
                self.snapshot = None
            else:
                while self.hierarchy and self.hierarchy[-1][0] >= indent: self.hierarchy.pop()
                pair = re.match(r'([^:]+?)\s*:\s*(.*)$', s)
                if pair and pair[2]:
                    key, value = pair[1].strip(), pair[2].strip()
                    if key == 'Index' and self.hierarchy and self.hierarchy[-1][1] == 'MIG Device':
                        self.hierarchy[-1] = (self.hierarchy[-1][0], 'MIG Device ' + value)
                    path = '/'.join([x[1] for x in self.hierarchy] + [key])
                    if not self.hierarchy and key in {'Product Name', 'Serial Number', 'GPU UUID'}:
                        self.owner.field(self.snapshot['address'], {'Product Name': 'model', 'Serial Number': 'serial', 'GPU UUID': 'uuid'}[key], value, n, line, 'nvidia-smi -q')
                    self.snapshot['fields'].append({'path': path, 'name': key, 'value': value, 'group': group(path), 'description': describe(path), 'evidence': self.evidence(n, line)})
                    self.count += 1
                else: self.hierarchy.append((indent, s.rstrip(':').strip()))
                return
        tokens = s.split()
        if self.mode != 'unsupported' and tokens and re.fullmatch(r'(GPU|NIC)\d+', tokens[0]) and len(tokens) > 1 and (re.fullmatch(r'(GPU|NIC)\d+', tokens[1]) or re.match(r'^GPU\d+\s+CPU Affinity', s)):
            self.matrix = None
            labels = []
            for token in tokens:
                if not re.fullmatch(r'(GPU|NIC)\d+', token): break
                labels.append(token)
            if len(labels) != len(set(labels)):
                self.owner.r['recognized'] = True
                self.owner.r['complete'] = False
                self.owner.warn(f'第 {n} 行矩阵表头设备重复，未解析该采集块。')
                return
            if len(labels) > 256:
                self.matrix = None
                self.owner.r['recognized'] = True
                self.owner.r['complete'] = False
                self.owner.warn('互联矩阵超过 256 个设备的读取上限，未解析该采集块。')
                return
            if len(labels) == len(set(labels)) and len(labels) <= 256:
                columns = re.findall(r'CPU Affinity|NUMA Affinity|GPU NUMA ID', ' '.join(tokens[len(labels):]))
                self.matrix = {'id': f'm{len(self.matrices)}', 'mode': self.mode, 'labels': labels, 'affinityColumns': columns, 'rows': [], 'evidence': self.evidence(n, line), 'warnings': []}
                self.matrices.append(self.matrix); self.count += 1
                self.owner.r['recognized'] = True
                return
        if self.matrix and tokens and re.fullmatch(r'(GPU|NIC)\d+', tokens[0]):
            size = len(self.matrix['labels'])
            if len(tokens) < size + 1 or tokens[0] not in self.matrix['labels'] or not all(RELATION_TOKEN.fullmatch(t) for t in tokens[1:size+1]):
                if len(self.matrix['warnings']) < 25: self.matrix['warnings'].append(f'第 {n} 行矩阵格式不完整或包含未知关系。')
            elif any(r['label'] == tokens[0] for r in self.matrix['rows']):
                if len(self.matrix['warnings']) < 25: self.matrix['warnings'].append(f'第 {n} 行设备行重复。')
            else:
                unknown = sorted({t for t in tokens[1:size+1] if not RELATION.fullmatch(t)})
                if unknown and len(self.matrix['warnings']) < 25:
                    self.matrix['warnings'].append(f"第 {n} 行包含未识别关系码：{', '.join(unknown)}；已保留原值。")
                affinity = tokens[size+1:]
                columns = self.matrix['affinityColumns']
                values = dict(zip(columns, affinity)) if len(columns) == len(affinity) else {}
                self.matrix['rows'].append({'label': tokens[0], 'cells': tokens[1:size+1], 'affinity': affinity, 'affinityValues': values, 'evidence': self.evidence(n, line)})
                self.count += 1
            return
        nic = re.fullmatch(r'(NIC\d+):\s*(\S+)', s)
        if nic and self.matrix:
            self.matrix.setdefault('nicNames', {}).setdefault(nic[1], []).append({'name': nic[2], 'evidence': self.evidence(n, line)})
            self.count += 1
        m = PCI.match(line)
        if m:
            self.pci = core.bdf(m[1]); self.owner.r['recognized'] = True
        elif s and not line[:1].isspace(): self.pci = None
        # Existing adapter creates the PCI node later in this line.
        if m:
            desc = m[2]
            numeric_class = re.match(r'([\da-fA-F]{4}):\s+([\da-fA-F]{4}):', desc)
            if not numeric_class:
                numeric_class = re.match(r'Class\s+\[([\da-fA-F]{4})\]:\s+Device\s+\[([\da-fA-F]{4}):', desc, re.I)
            cls, vendor = (numeric_class[1].lower(), numeric_class[2].lower()) if numeric_class else ('', '')
            kind = 'bridge' if re.search(r'PCI bridge|\[0604\]', desc, re.I) or cls == '0604' else 'gpu' if core.LSPCI_RE.match(line) or (cls in {'0300', '0302', '0380'} and vendor == '10de') else 'nic' if re.search(r'Ethernet|Network|InfiniBand', desc, re.I) or cls.startswith('02') else 'nvme' if re.search(r'Non-Volatile|NVMe', desc, re.I) or cls == '0108' else 'device'
            node = self.owner.r['pci_nodes'].setdefault(self.pci, {'address': self.pci, 'fields': {}})
            node.update(kind=kind, bridge=kind == 'bridge', gpu=kind == 'gpu', description=desc, evidence=self.evidence(n, line))
        if self.pci and not m:
            sriov = re.match(r'(IOVCtl|Initial VFs|VF offset):\s*(.+)', s)
            if sriov:
                self.owner.put(self.owner.r['pci_nodes'][self.pci]['fields'], sriov[1], sriov[2], n, line, 'lspci SR-IOV')
            pair = re.match(r'(Kernel driver in use|LnkCap|LnkSta|CESta|UESta|UEMsk|UESvrt|DevSta):\s*(.+)', s)
            if pair:
                key = {'Kernel driver in use': 'driver'}.get(pair[1], pair[1])
                fields = self.owner.r['pci_nodes'][self.pci]['fields']
                values = fields.setdefault(key, [])
                if len(values) < 100:
                    values.append({'value': pair[2], 'origin': 'lspci', 'evidence': self.evidence(n, line)})
                    self.count += 1
        # readlink/realpath output: explicit PCI ancestor chain, no inferred switches.
        if s.startswith('/sys/devices/'):
            chain = [core.bdf(p) for p in s.split('/') if re.fullmatch(BDF, p)]
            if chain:
                if self.sysfs_nic:
                    self.nic_paths.setdefault(self.sysfs_nic, []).append({'address': chain[-1], 'evidence': self.evidence(n, line)})
                    self.sysfs_nic = None
                for address in chain:
                    self.owner.r['pci_nodes'].setdefault(address, {'address': address, 'fields': {}, 'bridge': False, 'gpu': False, 'kind': 'device'})
                self.paths.setdefault(chain[-1], []).append({'path': chain, 'evidence': self.evidence(n, line)})
                for i in range(len(chain)-1):
                    self.paths.setdefault(chain[i], []).append({'path': chain[:i+1], 'evidence': self.evidence(n, line)})
                self.count += 1
                self.owner.r['recognized'] = True
        cols = s.lstrip('#').strip().replace(',', ' ').split()
        if 'CPU' in cols and 'NODE' in cols and 'SOCKET' in cols:
            self.cpu_columns = cols
        elif self.cpu_columns and s and not s.startswith('#'):
            vals = s.replace(',', ' ').split()
            if len(vals) == len(self.cpu_columns) and all(vals[self.cpu_columns.index(k)].isdigit() for k in ('CPU', 'NODE', 'SOCKET')):
                self.cpu_rows.append({k: vals[self.cpu_columns.index(k)] for k in ('CPU', 'NODE', 'SOCKET')} | {'evidence': self.evidence(n, line)})
                self.owner.r['recognized'] = True
                self.count += 1
            else: self.cpu_columns = None


def identify_virtual_functions(nodes, cancel_event=None):
    """Resolve only enumerated VFs with a consistent, enabled SR-IOV capability.

    Routing-ID arithmetic follows Linux drivers/pci/iov.c. Ambiguous or
    cross-boot evidence leaves the device unclassified.
    """
    candidates = {}
    for address, node in nodes.items():
        core.check_cancel(cancel_event)
        fields = node['fields']
        control, count, layout = (unique(fields, k) for k in ('IOVCtl', 'Initial VFs', 'VF offset'))
        count = re.search(r'Number of VFs:\s*(\d{1,5})(?:,|$)', count)
        layout = re.fullmatch(r'(\d{1,5}),\s*stride:\s*(\d{1,5}),\s*Device ID:\s*([\da-fA-F]{4})', layout)
        vendor = re.search(r'\[([\da-fA-F]{4}):[\da-fA-F]{4}\]|\b[\da-fA-F]{4}:\s+([\da-fA-F]{4}):[\da-fA-F]{4}', node.get('description', ''))
        if not re.search(r'\bEnable\+', control) or not count or not layout or not vendor: continue
        total, offset, stride = int(count[1]), int(layout[1]), int(layout[2])
        if not 0 < total <= 65535 or not 0 < offset <= 65535 or not 0 < stride <= 65535: continue
        refs = [fields[k][0]['evidence'] for k in ('IOVCtl', 'Initial VFs', 'VF offset')]
        if len({(e.get('boot_marker'), e.get('section')) for e in refs}) != 1 or max(e['line'] for e in refs)-min(e['line'] for e in refs) > 8: continue
        domain, bus, devfn = address.split(':'); device, function = devfn.split('.')
        base = (int(bus, 16)<<8) + (int(device, 16)<<3) + int(function)
        vendor_id = (vendor[1] or vendor[2]).lower()
        # Iterate the bounded enumeration, rather than an untrusted VF count.
        for target, child in nodes.items():
            if not target.startswith(domain+':') or target == address: continue
            _, target_bus, target_devfn = target.split(':'); target_dev, target_fn = target_devfn.split('.')
            delta = (int(target_bus,16)<<8)+(int(target_dev,16)<<3)+int(target_fn)-base-offset
            if delta < 0 or delta % stride or delta//stride >= total: continue
            if f'{vendor_id}:{layout[3].lower()}' not in child.get('description','').lower(): continue
            if child.get('evidence',{}).get('boot_marker') != refs[0].get('boot_marker'): continue
            candidates.setdefault(target, []).append((address, refs))
    for target, matches in candidates.items():
        if len(matches) != 1: continue
        address, refs = matches[0]
        nodes[target].update(kind='vf', gpu=False, physicalFunction=address, virtualizationEvidence=refs)


def finish(r, collector, gpus, events, cancel_event=None):
    collector = SimpleNamespace(**collector)
    nodes = r['pci_nodes']
    checks = []

    def add(code, address, state, title, observation, basis, refs=(), path='', snapshot=''):
        core.check_cancel(cancel_event)
        checks.append({'id': f'c{len(checks)}', 'rule': code, 'address': address, 'status': state, 'label': STATUS[state], 'title': title, 'observation': observation, 'basis': basis, 'evidence': list(refs), 'path': path, 'snapshot': snapshot})

    for snap in collector.snapshots:
        core.check_cancel(cancel_event)
        by_path = {}
        for f in snap['fields']: by_path.setdefault(f['path'], []).append(f)
        for p, values in by_path.items():
            if not p.endswith('/Current') or not any(x in p for x in ('Link Width/', 'PCIe Generation/', 'Link Gen/')): continue
            maximum = by_path.get(p.rsplit('/', 1)[0] + '/Max', [])
            if len(values) != 1 or len(maximum) != 1: continue
            current, max_field = values[0], maximum[0]
            a, b = numeric(current['value']), numeric(max_field['value'])
            if a is not None and b is not None and a != b:
                add('smi-link', snap['address'], 'review', 'PCIe 采集值与最大值存在差异', f"{p}: {current['value']}；Max: {max_field['value']}", describe(p), [current['evidence'], max_field['evidence']], p, snap['id'])
        failures = {}
        for f in snap['fields']:
            marker = f['value'].strip('[] ').lower()
            f['availability'] = 'error' if marker in READ_ERRORS else 'unavailable' if marker in {'n/a', 'not supported', 'unknown', 'not available'} else 'value'
            if marker in READ_ERRORS: failures.setdefault(marker, []).append(f)
        for values in failures.values():
            add('smi-read', snap['address'], 'error', 'nvidia-smi 字段读取失败', f"{values[0]['value']} · {len(values)} 个字段", '保留工具返回的错误信息；需结合驱动、权限与内核日志核对，不能作为有效参数值使用。', [f['evidence'] for f in values], values[0]['path'], snap['id'])
    topology = []
    parent_index = {}
    for address, node in nodes.items():
        if node.get('bridge'):
            secondary = unique(node['fields'], 'secondary')
            if secondary: parent_index.setdefault((address.split(':')[0], secondary), []).append(address)
    for address, node in nodes.items():
        core.check_cancel(cancel_event)
        matches = [p for p in parent_index.get(tuple(address.split(':')[:2]), []) if p != address]
        explicit = {tuple(x['path']) for x in collector.paths.get(address, [])}
        parent = matches[0] if len(matches) == 1 else ''
        evidence = []
        ambiguous = len(matches) > 1 or len(explicit) > 1
        if explicit:
            evidence = [x['evidence'] for x in collector.paths[address]]
            if len(explicit) == 1:
                chain = next(iter(explicit)); candidate = chain[-2] if len(chain) > 1 else ''
                ambiguous |= bool(parent and candidate and parent != candidate)
                parent = candidate
        if ambiguous: parent = ''
        if parent and not evidence: evidence = [x['evidence'] for x in nodes.get(parent, {}).get('fields', {}).get('secondary', [])]
        if node.get('physicalFunction'):
            parent = node['physicalFunction']; evidence = node['virtualizationEvidence']; ambiguous = False
        root_confirmed = not ambiguous and bool(explicit) and len(next(iter(explicit))) == 1
        topology.append({'address': address, 'parent': parent, 'rootConfirmed': root_confirmed, 'ambiguous': ambiguous, 'evidence': evidence})
    # Reject cycles, including malformed bus numbering.
    parents = {n['address']: n['parent'] for n in topology}
    for node in topology:
        seen = {node['address']}; p = node['parent']
        while p and p not in seen:
            seen.add(p); p = parents.get(p)
        if p: node.update(parent='', ambiguous=True)
    for matrix in collector.matrices:
        core.check_cancel(cancel_event)
        for row in matrix['rows']:
            if any((value == 'X') != (row['label'] == label) for label, value in zip(matrix['labels'], row['cells'])):
                matrix['warnings'].append(f"第 {row['evidence']['line']} 行自身关系与表头不一致。")
        matrix['complete'] = len(matrix['rows']) == len(matrix['labels']) and not matrix['warnings']
        matrix['mapping'] = {}
        matrix['mappingEvidence'] = {}
        for label in matrix['labels']:
            if label.startswith('NIC'):
                names = matrix.get('nicNames', {}).get(label, [])
                if len({v['name'] for v in names}) == 1:
                    refs = collector.nic_paths.get(names[0]['name'], [])
                    refs = [v for v in refs if v['evidence'].get('boot_marker') == matrix['evidence'].get('boot_marker')]
                    if len({v['address'] for v in refs}) == 1:
                        matrix['mapping'][label] = refs[0]['address']
                        matrix['mappingEvidence'][label] = [v['evidence'] for v in names + refs]
                continue
            candidates = [g for g in gpus if g['index'] == label[3:] and all(v['evidence'].get('boot_marker') == matrix['evidence'].get('boot_marker') for v in r['gpu_indices'].get(g['pci'], {}).get('index', []))]
            if len(candidates) == 1:
                matrix['mapping'][label] = candidates[0]['pci']
                matrix['mappingEvidence'][label] = [v['evidence'] for v in r['gpu_indices'][candidates[0]['pci']]['index']]
    for address, node in nodes.items():
        fields = node['fields']
        cap, sta = unique(fields, 'LnkCap'), unique(fields, 'LnkSta')
        maximum = re.search(r'Speed\s+(\d+(?:\.\d+)?)GT/s.*?Width\s+x(\d+)', cap)
        current = re.search(r'Speed\s+(\d+(?:\.\d+)?)GT/s.*?Width\s+x(\d+)', sta)
        refs = [v['evidence'] for k in ('LnkCap', 'LnkSta') for v in fields.get(k, [])]
        if node.get('physicalFunction'):
            pass  # A VF does not represent a separate physical PCIe link.
        elif maximum and current and numeric(maximum[1]) is not None and numeric(current[1]) is not None:
            different = numeric(current[1]) != numeric(maximum[1]) or current[2].lstrip('0') != maximum[2].lstrip('0')
            add('pcie-link', address, 'review' if different else 'ok', '链路协商值与最大能力存在差异' if different else '链路协商值与最大能力一致', f'{current[1]} GT/s ×{current[2]}；最大 {maximum[1]} GT/s ×{maximum[2]}', '比较本端 LnkSta 与 LnkCap；差异需结合链路对端、插槽布线、BIOS 配置与采集时负载核对。', refs)
        elif node.get('gpu') or 'LnkSta' in fields:
            add('pcie-link', address, 'missing', '链路能力或协商值不完整', '缺少可唯一配对的 LnkCap / LnkSta。', '采集 lspci -Dnnvv，并保留同一时刻的上下游端口字段。', refs)
        for key in ('CESta', 'UESta', 'DevSta'):
            for v in fields.get(key, []):
                flags = re.findall(r'\b([A-Za-z][A-Za-z0-9]*)\+', v['value'])
                if key == 'DevSta': flags = [x for x in flags if x in {'CorrErr', 'UncorrErr', 'FatalErr', 'UnsuppReq'}]
                if flags: add('pcie-status', address, 'error', f'{key} 错误状态位置位', ', '.join(flags), '状态寄存器记录已检测的错误；需结合内核 AER 严重级别、时间及链路对端定位。', [v['evidence']])
        if node.get('gpu'):
            driver = unique(fields, 'driver')
            add('driver', address, 'ok' if driver == 'nvidia' else 'review' if driver else 'missing', '内核驱动绑定', driver or '日志未提供唯一的驱动绑定', 'nvidia 为 NVIDIA 内核驱动；vfio-pci 等绑定需结合直通或宿主机用途核对。', [v['evidence'] for v in fields.get('driver', [])])
    for event in events:
        if event['kind'] != 'aer': continue
        m = re.search(r'severity=([^,]+)', event['raw'])
        add('aer', event['address'], 'error', 'PCIe AER · ' + (m[1] if m else '严重级别未提供'), event['raw'], '记录指向报告错误的设备或端口。Corrected 为硬件已纠正；Uncorrectable 按 Non-Fatal / Fatal 区分事务或链路影响。', [{'line': event['line'], 'text': event['raw'], 'section': event['section']}])
    for snap in collector.snapshots:
        for f in snap['fields']:
            p, v = f['path'], f['value']; number = numeric(v)
            state = title = basis = ''
            if 'ECC Errors/' in p and number is not None and number > 0:
                state = 'error' if 'Uncorrect' in p or '/Double Bit/' in p else 'review'
                title = 'ECC 非零计数'; basis = describe(p) + ' 单次采集不提供增长速率。'
            elif 'Remapped Rows/' in p and ('Failure' in p or 'Pending' in p) and v.lower() == 'yes':
                state = 'error' if 'Failure' in p else 'review'; title = '行重映射状态'; basis = describe(p)
            elif ('Retired Pages/' in p and 'Pending' in p and v.lower() == 'yes') or ('Replay' in p and number is not None and number > 0):
                state = 'review'; title = '计数或待处理状态需核对'; basis = describe(p)
            elif ('Clocks Event Reasons/' in p or 'Clocks Throttle Reasons/' in p) and v == 'Active' and ('Thermal' in p or 'HW Power Brake' in p):
                state = 'review'; title = '温度或外部供电限制生效'; basis = describe(p)
            if state: add('smi-health', snap['address'], state, title, f'{p}: {v}', basis, [f['evidence']], p, snap['id'])
    if not collector.snapshots: add('smi-data', '', 'missing', '缺少 GPU 详细状态', '未读取到 nvidia-smi -q 的 GPU 状态块。', '采集 nvidia-smi -q 文本输出。')
    if not collector.matrices: add('topology-data', '', 'missing', '缺少 GPU 互联矩阵', '未读取到 nvidia-smi topo 矩阵。', '采集 nvidia-smi topo -m；需要 PCIe 关系时同时采集 topo -mp。')
    for matrix in collector.matrices:
        if not matrix['complete']: add('topology-data', '', 'missing', '互联矩阵不完整', '；'.join(matrix['warnings']) or '部分设备行缺失。', '重新采集完整矩阵，保留表头和命令。', [matrix['evidence']])
    if not r['complete']: add('incomplete', '', 'missing', '日志读取不完整', '检查结果仅覆盖已读取内容。', '查看读取提示并重新采集完整日志。')
    return {'version': 1, 'snapshots': collector.snapshots, 'matrices': collector.matrices, 'topology': topology, 'cpuRows': collector.cpu_rows, 'checks': checks, 'references': [SMI_DOC, AER_DOC]}
