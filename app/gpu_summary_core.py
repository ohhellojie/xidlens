#!/usr/bin/env python3
"""离线分析 GPU 日志，逐文件生成摘要与证据。"""
from __future__ import annotations

import argparse
import csv
from datetime import date, datetime
import gzip
import hashlib
import json
from pathlib import Path
import re
import sys
import tarfile
import time
import uuid
import zipfile
import zlib

VERSION = '0.1.0'
REFERENCE = 'https://docs.nvidia.com/deploy/xid-errors/analyzing-xid-catalog.html'
BDF = r'(?:[0-9a-fA-F]{4,8}:)?[0-9a-fA-F]{2}:[0-9a-fA-F]{2}(?:\.[0-7])?'
BDF_RE = re.compile(r'(?<![\w:])((?:[0-9a-fA-F]{4,8}:)?[0-9a-fA-F]{2}:[0-9a-fA-F]{2}\.[0-7])(?![\w.])')
XID_RE = re.compile(r'NVRM:\s*Xid\s*\(PCI:(' + BDF + r')\):\s*(\d+)', re.I)
INIT_RE = re.compile(r'NVRM:.*?GPU\s+(' + BDF + r'):.*?RmInitAdapter failed!?\s*(\([^\r\n]*\))?', re.I)
HEADER_GPU = re.compile(r'^\s*(?:NVIDIA GPU Details\s*\|\s*|\|\s*)(NVIDIA[^,]+),\s*([^,]+),[^,]+,[^,]+,\s*(' + BDF + r'),\s*(\S+)')
LSPCI_RE = re.compile(r'^(' + BDF + r')\s+(?:3D controller|VGA compatible controller|Display controller).*?(?:NVIDIA|\[10de:)', re.I)
SMI_GPU_RE = re.compile(r'^GPU\s+(' + BDF + r')\s*$')
GPU_AT_RE = re.compile(r'NVRM:\s*GPU at PCI:(' + BDF + r'):\s*(GPU-[\w-]+)', re.I)
# NVSentinel janitor result and the kernel module's loading banner are observed
# records, not commands or proof that a device passed a later health check.
# https://github.com/NVIDIA/NVSentinel/blob/main/health-monitors/syslog-health-monitor/pkg/xid/types.go
# https://github.com/NVIDIA/open-gpu-kernel-modules/blob/main/kernel-open/nvidia/nv.c
GPU_RESET_RE = re.compile(r'\bGPU reset executed:\s*(GPU-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}),\s*success:\s*(true|false)(?![\w])', re.I)
DRIVER_LOAD_RE = re.compile(r'NVRM:\s*loading\s+NVIDIA\s+[^\r\n]{0,160}?Kernel Module[^\r\n]{0,100}?\s(\d{3,}\.\d+(?:\.\d+)?)(?=\s|$)', re.I)
RECOVERY_ACTION_RE = re.compile(r'GPU recovery action changed from\s+(0x[0-9a-f]+)\s*\(([^)\r\n]+)\)\s+to\s+(0x[0-9a-f]+)\s*\(([^)\r\n]+)\)', re.I)
KNOWN_XIDS = {13: '图形引擎异常', 31: 'GPU 内存访问页错误', 45: '应用清理记录',
              48: '不可纠正 ECC 错误', 79: 'GPU 经 PCIe 不可访问',
              119: 'GSP RPC 超时', 120: 'GSP 异常', 154: '恢复动作通知'}
LABELS = {'xid': 'Xid', 'init': '初始化失败', 'aer': 'PCIe/AER 记录',
          'fallen': 'GPU 不可访问', 'smi_error': 'nvidia-smi 访问异常',
          'lockup': '内核 soft lockup', 'channel': 'GPU 通道超时',
          'ecc': 'ECC 错误记录', 'mods': 'MODS 错误/结果', 'thermal': '温度阈值/传感器错误'}
TEXT_EXT = {'.log', '.txt', '.out', '.xml', '.csv', '.json'}
COMMAND_RE = re.compile(r'^(?:(?:\$\s*|[^\s]+[#$]\s+))?(?:sudo\s+)?((?:lspci|lscpu|dmidecode|nvidia-smi(?:\s+topo)?)(?:\s+-.*)?)\s*$')


def section_boundary(line):
    s = line.strip()
    return (line.startswith('*** ') and not line.startswith('*** ls:')) or (s.startswith('__________') and set(s) == {'_'}) or s.startswith('-- Boot ') or s == '-- Reboot --' or bool(COMMAND_RE.fullmatch(s))

def nvidia_driver_version(line):
    match = re.match(r'^\s*\|?\s*(?:NVIDIA-SMI\s+\S+\s+)?Driver Version\s*:\s*(\d[\d.]+)(?=\s|\||$)', line, re.I)
    if not match and 'NVRM version:' in line:
        match = re.search(r'Kernel Module.*?(\d{3,}\.\d+(?:\.\d+)?)', line)
    return match[1] if match else ''


class AnalysisCancelled(Exception):
    pass


def check_cancel(cancel_event):
    if cancel_event is not None and cancel_event.is_set():
        raise AnalysisCancelled()


def bdf(value):
    parts = value.lower().split(':')
    if len(parts) == 2:
        parts.insert(0, '0000')
    parts[0] = f'{int(parts[0], 16):04x}'
    if '.' not in parts[-1]:
        parts[-1] += '.0'
    return ':'.join(parts)


def clean(text):
    return ''.join(c for c in text if c in '\t' or ord(c) >= 32).strip()[:1600]


def timestamp(line):
    # 保留原始时区/年份缺失；不把 uptime 换算成故障发生日期。
    m = re.match(r'^(\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:\.\d+)?(Z|[+-]\d\d:?\d\d)?)(?=\s|$)', line)
    if m:
        return {'kind': 'calendar', 'raw': m[1], 'timezone': m[2] or None}
    m = re.match(r'^([A-Z][a-z]{2}\s+\d{1,2}\s+\d\d:\d\d:\d\d)', line)
    if m:
        return {'kind': 'calendar_without_year_or_zone', 'raw': m[1]}
    m = re.match(r'^\[\s*(\d+(?:\.\d+)?)\]', line)
    if m:
        return {'kind': 'uptime_seconds', 'raw': m[1]}
    return {'kind': 'unknown', 'raw': ''}


class Parser:
    def __init__(self, source, max_bytes=512*1024*1024, max_groups=2000, cancel_event=None, progress=None):
        self.cancel_event = cancel_event
        self.progress = progress
        self.r = {'source': source, 'complete': True, 'bytes_read': 0, 'lines_read': 0,
                  'sha256_content': None, 'warnings': [], 'collection_time': [],
                  'driver_versions': [], 'gpu_inventory': {}, 'pci_gpu_addresses': [],
                  'smi_snapshots': [], 'health_counters': [], 'events': [],
                  'lifecycle_records': [], 'recognized': False}
        self.max_bytes, self.max_groups = max_bytes, max_groups
        self.groups, self.pci = {}, set()
        self.section = '输入正文'
        self.boot = None
        self.smi = None
        self.current_gpu = None
        self.proc_gpu = None
        self.pending_serial = None
        self.encoding_replacements = 0
        self.nul_lines = 0
        self.health_block = None
        self.health_scope = ''

    def warn(self, value):
        if value not in self.r['warnings']:
            self.r['warnings'].append(value)

    def recover_line_error(self):
        self.current_gpu = self.proc_gpu = self.smi = self.pending_serial = None
        self.health_block = None

    def evidence(self, n, line):
        return {'line': n, 'section': self.section, 'boot_marker': self.boot,
                'time': timestamp(line), 'text': clean(line)}

    def field(self, address, key, value, n, line, origin):
        if not address or not value or value in {'N/A', 'Unknown', '0', 'None'} or '?' in value:
            return
        gpu = self.r['gpu_inventory'].setdefault(address, {'address': address, 'fields': {}})
        vals = gpu['fields'].setdefault(key, [])
        if not any(v['value'] == value for v in vals):
            vals.append({'value': value, 'origin': origin, 'evidence': self.evidence(n, line)})
        if len(vals) > 1:
            self.warn(f'{address} 的 {key} 存在多个值，请核对字段来源。')

    def event(self, kind, address, code, n, line):
        self.r['recognized'] = True
        key = (kind, address, str(code))
        if key not in self.groups:
            if len(self.groups) >= self.max_groups:
                self.r['complete'] = False
                self.warn('错误分组数量达到上限，部分错误未纳入摘要。')
                return
            self.groups[key] = {'kind': kind, 'address': address, 'code': str(code),
                                'matched_lines': 0, 'samples': [], 'last_sample': None}
        group = self.groups[key]
        group['matched_lines'] += 1
        ev = self.evidence(n, line)
        if len(group['samples']) < 3:
            group['samples'].append(ev)
        group['last_sample'] = ev

    def lifecycle(self, kind, n, line, **metadata):
        self.r['recognized'] = True
        if len(self.r['lifecycle_records']) >= 10000:
            self.r['complete'] = False
            self.warn('动作记录达到 10000 条，后续记录未保存。')
            return
        self.r['lifecycle_records'].append({'kind': kind, 'evidence': self.evidence(n, line), **metadata})

    def consume(self, line, n):
        s = line.strip()
        if section_boundary(line):
            self.current_gpu = self.proc_gpu = self.smi = self.pending_serial = None
            self.health_block = None
            command = COMMAND_RE.fullmatch(s)
            if command: self.section = clean(command[1])
        if n <= 100 and ('NVIDIA bug report log file' in line or 'MODS start:' in line):
            self.r['recognized'] = True
        if line.startswith('*** ') and not line.startswith('*** ls:'):
            self.section = clean(line[4:])
            self.current_gpu = None
            self.proc_gpu = None
            self.pending_serial = None
            self.smi = None
            self.health_block = None
            m = re.search(r'/proc/driver/nvidia/gpus/(' + BDF + r')/information', line)
            if m:
                self.proc_gpu = bdf(m[1])
        if s.startswith('-- Boot ') or s == '-- Reboot --':
            self.boot = clean(s)
            self.pending_serial = None
        if n <= 100 and s.startswith(('Date:', 'MODS start:')):
            self.r['collection_time'].append({'raw': s.split(':', 1)[1].strip(), 'line': n})
        driver = nvidia_driver_version(line)
        if driver and driver not in self.r['driver_versions']:
            self.r['driver_versions'].append(driver)
        reset = GPU_RESET_RE.search(line) if 'GPU reset executed:' in line else None
        if reset:
            self.lifecycle('reset', n, line, targetUUID=reset[1],
                           outcome='completed' if reset[2].lower() == 'true' else 'failed')
        loading = DRIVER_LOAD_RE.search(line) if 'NVRM:' in line else None
        if loading:
            self.lifecycle('driver_load', n, line, driverVersion=loading[1], outcome='observed')
        m = HEADER_GPU.match(line) if n < 200 else None
        if m:
            address = bdf(m[3])
            self.field(address, 'model', m[1].strip(), n, line, 'report_header')
            self.field(address, 'serial', m[4], n, line, 'report_header')
        m = LSPCI_RE.match(line)
        if m:
            self.pci.add(bdf(m[1]))
            self.r['recognized'] = True
        m = GPU_AT_RE.search(line) if 'NVRM:' in line else None
        if m:
            address = bdf(m[1])
            self.pending_serial = (address, n)
            self.field(address, 'uuid', m[2], n, line, 'kernel_history')
        elif 'NVRM: GPU Board Serial Number:' in line:
            if self.pending_serial and n == self.pending_serial[1] + 1:
                self.field(self.pending_serial[0], 'serial', line.split('Number:', 1)[1].strip(),
                           n, line, 'kernel_history_adjacent')
            else:
                self.warn('部分 GPU SN 缺少唯一的 PCIe 对应关系。')
            self.pending_serial = None
        if self.proc_gpu:
            for prefix, key in [('Model:', 'model'), ('GPU UUID:', 'uuid'), ('Serial Number:', 'serial')]:
                if s.startswith(prefix):
                    self.field(self.proc_gpu, key, s[len(prefix):].strip(), n, line, 'proc_information')
        m = re.match(r'Attached GPUs\s*:\s*(\d+)', s)
        if m:
            self.smi = {'attached': int(m[1]), 'line': n, 'section': self.section, 'gpus': []}
            self.r['smi_snapshots'].append(self.smi)
            self.current_gpu = None
            self.r['recognized'] = True
        m = SMI_GPU_RE.match(line)
        if m and self.smi is not None:
            self.current_gpu = bdf(m[1])
            self.health_block = None
            if self.current_gpu not in self.smi['gpus']:
                self.smi['gpus'].append(self.current_gpu)
        if self.current_gpu and self.smi is not None:
            m = re.match(r'(Product Name|Serial Number|GPU UUID)\s*:\s*(.+)', s)
            if m:
                key = {'Product Name': 'model', 'Serial Number': 'serial', 'GPU UUID': 'uuid'}[m[1]]
                self.field(self.current_gpu, key, m[2].strip(), n, line, 'nvidia_smi_snapshot')
            indent = len(line) - len(line.lstrip())
            if s in {'ECC Errors', 'Retired Pages', 'Remapped Rows'}:
                self.health_block = (s, indent)
                self.health_scope = ''
            elif self.health_block:
                if s and indent <= self.health_block[1]:
                    self.health_block = None
                elif s and ':' not in s:
                    self.health_scope = s
                elif ':' in s:
                    key, value = (x.strip() for x in s.split(':', 1))
                    if (value.isdigit() and int(value) > 0) or value.lower() == 'yes':
                        if len(self.r['health_counters']) < 1000:
                            self.r['health_counters'].append({'address': self.current_gpu,
                                'path': '/'.join([self.health_block[0], self.health_scope, key]),
                                'value': value, 'evidence': self.evidence(n, line)})
                        else:
                            self.r['complete'] = False
                            self.warn('非零健康计数达到保存上限。')
        # 只提取实际记录；不把 lspci 的能力、掩码或 "UESta: ...-" 当成 AER 故障。
        if 'NVRM:' in line:
            m = XID_RE.search(line)
            if m:
                self.event('xid', bdf(m[1]), m[2], n, line)
            m = INIT_RE.search(line)
            if m:
                self.event('init', bdf(m[1]), m[2] or '', n, line)
            if 'fallen off the bus' in line.lower() and not XID_RE.search(line):
                m = BDF_RE.search(line)
                self.event('fallen', bdf(m[1]) if m else None, '', n, line)
            if not XID_RE.search(line) and re.search(r'(?:channel.*timed?\s*out|channel.*timeout)', line, re.I):
                m = BDF_RE.search(line)
                self.event('channel', bdf(m[1]) if m else None, '', n, line)
        if 'AER:' in line or 'PCIe Bus Error:' in line:
            if re.search(r'PCIe Bus Error:|AER:.*(?:error|aer_status:\s*0x0*[1-9a-f]|severity=|Uncorrect|Corrected)', line, re.I):
                m = BDF_RE.search(line)
                self.event('aer', bdf(m[1]) if m else None, '', n, line)
        if 'soft lockup' in line.lower() and ('watchdog' in line.lower() or 'BUG:' in line):
            self.event('lockup', None, '', n, line)
        if re.search(r'Unable to determine the device handle|Failed: No devices were found|NVIDIA-SMI has failed|^No devices were found', line, re.I):
            m = BDF_RE.search(line)
            self.event('smi_error', bdf(m[1]) if m else None, '', n, line)
        if 'NVRM:' in line and not XID_RE.search(line) and re.search(r'uncorrectable.*ECC|ECC.*uncorrectable|double.bit.*ECC', line, re.I):
            m = BDF_RE.search(line)
            self.event('ecc', bdf(m[1]) if m else None, '', n, line)
        if 'Error Code =' in line or 'Nonmemory error code' in line or 'NONMEMORY FAILURE' in line:
            m = re.search(r'(?:Error Code\s*=|Nonmemory error code)\s*(\d+)', line)
            self.event('mods', None, m[1] if m else 'NONMEMORY_FAILURE', n, line)
        if 'Acceptable temperature limits exceeded' in line:
            self.event('thermal', None, '', n, line)

    def parse(self, stream):
        digest = hashlib.sha256()
        last_progress = 0
        try:
            while True:
                check_cancel(self.cancel_event)
                raw = stream.readline(min(1024*1024, self.max_bytes-self.r['bytes_read']+1))
                if not raw:
                    break
                self.r['bytes_read'] += len(raw)
                if self.r['bytes_read'] > self.max_bytes:
                    self.r['complete'] = False
                    self.warn('解压后字节数达到上限，读取未完成。')
                    break
                if len(raw) >= 1024*1024 and not raw.endswith(b'\n'):
                    self.r['complete'] = False
                    self.warn('遇到超长行，已停止读取。')
                    break
                digest.update(raw)
                self.r['lines_read'] += 1
                if b'\x00' in raw:
                    if not self.r['recognized']:
                        self.r['complete'] = False
                        self.warn('遇到二进制/UTF-16 内容，停止读取；请先导出文本日志。')
                        break
                    self.nul_lines += 1
                    raw = raw.replace(b'\x00', b'\\0')
                try:
                    line = raw.decode('utf-8-sig' if self.r['lines_read'] == 1 else 'utf-8')
                except UnicodeDecodeError:
                    line = raw.decode('gb18030', errors='replace')
                    self.encoding_replacements += 1
                try:
                    self.consume(line.rstrip('\r\n'), self.r['lines_read'])
                except (ValueError, OverflowError, csv.Error) as exc:
                    self.recover_line_error()
                    self.r['complete'] = False
                    if len(self.r['warnings']) < 100:
                        self.warn(f"第 {self.r['lines_read']} 行字段无法解析（{type(exc).__name__}），已继续读取后续日志。")
                if self.progress and (self.r['lines_read'] % 128 == 0 or len(raw) > 65536):
                    now = time.monotonic()
                    if now-last_progress >= .15:
                        self.progress(self.r['bytes_read'], self.r['lines_read'])
                        last_progress = now
        except (OSError, EOFError, RuntimeError, ValueError, zipfile.BadZipFile, zlib.error) as exc:
            self.r['complete'] = False
            self.warn(f'读取失败：{type(exc).__name__}；结果仅覆盖已读部分。')
        self.r['sha256_content'] = digest.hexdigest() if self.r['complete'] else None
        check_cancel(self.cancel_event)
        if self.progress:self.progress(self.r['bytes_read'], self.r['lines_read'])
        if self.encoding_replacements:
            self.warn(f'{self.encoding_replacements} 行非 UTF-8，已尝试 GB18030 解码；非 ASCII 内容需核对。')
        if self.nul_lines:
            self.warn(f'{self.nul_lines} 行含嵌入 NUL，证据中显示为 \\0；继续读取了后续日志。')
        self.r['pci_gpu_addresses'] = sorted(self.pci)
        self.r['events'] = list(self.groups.values())
        if not self.r['recognized']:
            self.warn('未识别到支持的 GPU 日志结构或错误记录。')
        return self.r


def log_member(name):
    p = Path(name.lower())
    return p.suffix in TEXT_EXT or (p.suffix == '.gz' and not name.lower().endswith('.tar.gz')) or p.name in {'syslog', 'messages', 'dmesg', 'kern.log'}


class ReadBudget:
    """限制 tar 容器解压量，包括跳过的非文本成员。"""
    def __init__(self, stream, limit, cancel_event=None):
        self.stream, self.remaining = stream, limit
        self.cancel_event = cancel_event

    def read(self, size=-1):
        check_cancel(self.cancel_event)
        size = self.remaining + 1 if size < 0 else min(size, self.remaining + 1)
        data = self.stream.read(size)
        self.remaining -= len(data)
        if self.remaining < 0:
            raise ValueError('tar 解压总量达到上限')
        return data


def analyze_path(path, max_bytes=512*1024*1024, max_members=100, max_total_bytes=2*1024*1024*1024, cancel_event=None, progress=None):
    check_cancel(cancel_event)
    path = Path(path).resolve()
    result = {'path': str(path), 'reports': [], 'warnings': [], 'complete': True}
    used = 0

    def read(stream, label, gz=False, total_bytes=None, member=None):
        nonlocal used
        check_cancel(cancel_event)
        remaining = max_total_bytes - used
        if remaining <= 0:
            result['complete'] = False
            result['warnings'].append('压缩包总读取量达到上限，剩余成员未读。')
            return
        def report_progress(size, lines):
            if progress:progress({'phase':'parsing','source':label,'bytes':size,'lines':lines,'totalBytes':None if gz else total_bytes})
        report_progress(0,0)
        parser = Parser(label, min(max_bytes, remaining), cancel_event=cancel_event, progress=report_progress if progress else None)
        if gz:
            with gzip.GzipFile(fileobj=stream) as inner:
                report = parser.parse(inner)
        else:
            report = parser.parse(stream)
        used += report['bytes_read']
        if member is not None: report['source_member'] = member
        result['reports'].append(report)
        result['complete'] = result['complete'] and report['complete']

    try:
        lower = path.name.lower()
        if lower.endswith('.zip'):
            with zipfile.ZipFile(path) as archive:
                entries = archive.infolist()
                members = [m for m in entries if not m.is_dir()]
                member_indices = {id(m): i for i, m in enumerate(entries)}
                selected = [m for m in members if log_member(m.filename)]
                skipped = len(members) - len(selected)
                if skipped:
                    result['warnings'].append(f'{skipped} 个非支持文本成员未解析（包括嵌套压缩包）。')
                for m in selected[:max_members]:
                    check_cancel(cancel_event)
                    if used >= max_total_bytes:
                        result['complete'] = False
                        result['warnings'].append('压缩包总读取量达到上限，剩余成员未读。')
                        break
                    try:
                        with archive.open(m) as f:
                            read(f, f'{path.name}!{m.filename}', m.filename.lower().endswith('.gz'), m.file_size, {'name':m.filename,'index':member_indices[id(m)]})
                    except (OSError, EOFError, ValueError, RuntimeError, zipfile.BadZipFile, zlib.error) as exc:
                        result['complete'] = False
                        result['warnings'].append(f'成员 {m.filename} 读取失败：{type(exc).__name__}')
                if len(selected) > max_members:
                    result['complete'] = False
                    result['warnings'].append('成员数量达到上限，剩余日志未读。')
        elif lower.endswith(('.tar.gz', '.tgz', '.tar')):
            opener = gzip.open if lower.endswith(('.tar.gz', '.tgz')) else open
            with opener(path, 'rb') as container, tarfile.open(fileobj=ReadBudget(container, max_total_bytes, cancel_event), mode='r|') as archive:
                count = 0
                skipped = 0
                for member_index, m in enumerate(archive):
                    check_cancel(cancel_event)
                    if m.isdir():
                        continue
                    if not m.isfile() or not log_member(m.name):
                        skipped += 1
                        continue
                    count += 1
                    if count > max_members:
                        result['complete'] = False
                        result['warnings'].append('成员数量达到上限，剩余日志未读。')
                        break
                    if used >= max_total_bytes:
                        result['complete'] = False
                        result['warnings'].append('压缩包总读取量达到上限，剩余成员未读。')
                        break
                    f = archive.extractfile(m)
                    if f:
                        with f:
                            read(f, f'{path.name}!{m.name}', m.name.lower().endswith('.gz'), m.size, {'name':m.name,'index':member_index})
                if skipped:
                    result['warnings'].append(f'{skipped} 个非支持文本/链接成员未解析。')
        else:
            with path.open('rb') as f:
                read(f, path.name, lower.endswith('.gz'), path.stat().st_size)
    except (OSError, EOFError, ValueError, RuntimeError, tarfile.TarError, zipfile.BadZipFile, zlib.error) as exc:
        result['complete'] = False
        result['warnings'].append(f'文件读取失败：{type(exc).__name__}。')
    if not result['reports']:
        result['complete'] = False
        result['warnings'].append('没有可用文本报告。')
    return result


def field_value(report, address, key):
    vals = report['gpu_inventory'].get(address, {}).get('fields', {}).get(key, [])
    return vals[0]['value'] if len(vals) == 1 else None


def primary_events(report):
    # Xid 45/154 保留在证据中，不把仅有清理/恢复通知的其他 GPU 列为主要故障卡。
    return [e for e in report['events'] if not (e['kind'] == 'xid' and int(e['code']) in {45, 154})]


def format_summary(report, report_date=None, note=None):
    d = date.fromisoformat(report_date) if report_date else None
    out = [f'{d.year}年{d.month}月{d.day}日'] if d else []
    events = primary_events(report)
    addresses = sorted({e['address'] for e in events if e['address'] and e['kind'] != 'aer'})
    inits = sorted({e['address'] for e in events if e['kind'] == 'init' and e['address']})
    models = sorted({field_value(report, a, 'model') for a in addresses} - {None})
    model = ('（' + '、'.join(models[:2]) + '）') if models and len(models) <= 2 else ''
    if inits:
        gpu_name = models[0].removeprefix('NVIDIA ') + ' ' if len(models) == 1 else ''
        out.append(f'检查 NVIDIA 日志，记录到 {len(inits)} 张 {gpu_name}显卡初始化失败。')
    elif any(e['kind'] in {'xid', 'fallen'} for e in events):
        out.append(f'检查 NVIDIA 日志，发现 GPU 错误记录{model}。')
    elif events:
        out.append('检查日志，发现以下异常记录。')
    else:
        out.append('已读内容中未提取到主要 GPU 错误。')
    snapshots = report['smi_snapshots']
    counts = sorted({s['attached'] for s in snapshots})
    if len(counts) == 1:
        pci = len(report['pci_gpu_addresses'])
        prefix = f'报告中 PCIe 枚举到 {pci} 张 NVIDIA 显卡，' if pci and pci != counts[0] else '采集时 '
        out.append(prefix + f'nvidia-smi 报告 {counts[0]} 张卡。')
    elif len(counts) > 1:
        out.append('nvidia-smi 各快照的卡数不同：' + '、'.join(map(str, counts)) + '，需按采集位置核对。')
    if addresses:
        out.append('')
        for address in addresses[:8]:
            sn = field_value(report, address, 'serial')
            display = address[5:] if address.startswith('0000:') else address
            out.append(f'{display}，SN：{sn or "未可靠取得"}')
        if len(addresses) > 8:
            out.append(f'另有 {len(addresses)-8} 个位置，见证据明细。')
    codes = sorted({int(e['code']) for e in events if e['kind'] == 'xid'})
    core = []
    if codes:
        core.append('、'.join(f'Xid {c}' + (f'（{KNOWN_XIDS[c]}）' if c in KNOWN_XIDS else '') for c in codes[:8]))
    if inits:
        init_codes = sorted({e['code'] for e in events if e['kind'] == 'init' and e['code']})
        core.append('RmInitAdapter failed' + (' ' + '、'.join(init_codes[:2]) if init_codes else ''))
    for kind in ['aer', 'lockup', 'channel', 'ecc', 'smi_error', 'thermal', 'mods']:
        if any(e['kind'] == kind for e in events):
            core.append(LABELS[kind])
    if core:
        out.extend(['', '核心记录：' + '；'.join(core) + '。'])
    counters = [c for c in report['health_counters'] if any(k in c['path'].lower() for k in ['uncorrectable', 'double bit', 'pending', 'failure', 'threshold'])]
    if counters:
        out.append('另有不可纠正 ECC、页面或重映射告警计数，范围及数值见证据明细。')
    if any(e['kind'] == 'aer' for e in events):
        out.append('PCIe AER 记录需结合报错设备及上下游拓扑定位。')
    if note:
        out.append('补充说明：' + note.rstrip('。') + '。')
    if report['events']:
        out.append('具体原因待核实。')
    if not report['complete']:
        out.append('本次日志未完整读取，摘要仅覆盖已读内容。')
    return '\n'.join(out) + '\n'


def evidence_text(report):
    lines = [f'来源：{report["source"]}', f'读取完整：{report["complete"]}；行数：{report["lines_read"]}',
             '内容 SHA-256：' + str(report['sha256_content']),
             '采集时间：' + '、'.join(x['raw'] for x in report['collection_time']),
             '驱动版本：' + '、'.join(report['driver_versions']),
             'PCI 枚举的 NVIDIA 显示/计算设备：' + '、'.join(report['pci_gpu_addresses']),
             '计数按匹配行统计，包含 syslog、journal、dmesg 中的重复采集。',
             '时间保留原文；缺少年份、时区或使用 uptime 的记录按日志顺序查看。',
             'SN 来源与冲突见 evidence.json；当前设备身份按最新采集记录核对。', '']
    for warning in report['warnings']:
        lines.append('读取提示：' + warning)
    if report['health_counters']:
        lines.append('\n非零 ECC、页面与重映射计数（统计范围见字段路径）：')
        for item in report['health_counters']:
            lines.append(f'L{item["evidence"]["line"]} | {item["address"]} | {item["path"]} = {item["value"]}')
    for event in report['events']:
        lines.append(f'\n{LABELS[event["kind"]]} {event["code"]} | {event["address"] or "位置未确定"} | 匹配 {event["matched_lines"]} 行')
        samples = list(event['samples'])
        if event['last_sample'] and event['last_sample']['line'] not in {s['line'] for s in samples}:
            samples.append(event['last_sample'])
        for sample in samples:
            lines.append(f'L{sample["line"]} [{sample["section"]}] [{sample["time"]["kind"]}] ' + sample['text'])
    lines.extend(['', 'Xid 释义参考（2026-10-11 核对）：' + REFERENCE])
    return '\n'.join(lines) + '\n'


def write_results(inputs, out_root, report_date=None, note=None, max_bytes=512*1024*1024):
    # 独立新目录，绝不覆盖输入或前一次结果；失败保留可审计的未完成状态。
    if note and (len(inputs) != 1 or str(inputs[0]).lower().endswith(('.zip', '.tar', '.tgz', '.tar.gz'))):
        raise ValueError('补充说明仅适用于单份日志文件。')
    folder = Path(out_root) / (datetime.now().strftime('%Y%m%d-%H%M%S') + '-' + uuid.uuid4().hex[:8])
    folder.mkdir(parents=True, exist_ok=False)
    manifest = {'version': VERSION, 'complete': False, 'user_context': {'date': report_date, 'note': note},
                'inputs': [], 'duplicates': [], 'outputs': []}
    manifest_path = folder/'manifest.json'
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    seen = {}
    index = []
    for input_path in inputs:
        result = analyze_path(input_path, max_bytes=max_bytes)
        manifest['inputs'].append(result)
        for report in result['reports']:
            digest = report['sha256_content']
            if digest and digest in seen:
                manifest['duplicates'].append({'source': report['source'], 'same_as': seen[digest]})
                continue
            number = len(manifest['outputs']) + 1
            name = f'{number:03d}'
            target = folder/name
            target.mkdir()
            (target/'日志摘要.txt').write_text(format_summary(report, report_date, note), encoding='utf-8-sig')
            (target/'证据明细.txt').write_text(evidence_text(report), encoding='utf-8-sig')
            (target/'evidence.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
            timeline = {s['line']: s for e in report['events'] for s in e['samples']+[e['last_sample']] if s}
            (target/'时间记录.txt').write_text('\n'.join([
                '错误样本按原文行号排列，保留各自的时间格式。',
                *[f'L{n} | {s["time"]["kind"]} | {s["time"]["raw"]} | {s["text"]}' for n,s in sorted(timeline.items())]
            ]), encoding='utf-8-sig')
            manifest['outputs'].append({'folder': name, 'source': report['source']})
            index.append(f'{name} | {report["source"]} | 读取{"完整" if report["complete"] else "不完整"}')
            if digest:
                seen[digest] = report['source']
    manifest['complete'] = bool(manifest['inputs']) and all(r['complete'] for r in manifest['inputs'])
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    notes = [w for r in manifest['inputs'] for w in r['warnings']]
    (folder/'结果索引.txt').write_text('\n'.join([
        '每份日志分别生成报告。',
        '摘要日期和补充说明按输入参数填写。',
        '证据文件含原始设备信息及日志片段，仅在本地保存。', '', *index, '',
        f'内容相同的重复报告：{len(manifest["duplicates"])} 份，详见 manifest.json。', *notes]), encoding='utf-8-sig')
    return folder, manifest


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('inputs', nargs='*', help='普通日志、gz、zip、tar、tar.gz、tgz；每份独立分析')
    ap.add_argument('--out', default='results', help='输出根目录，每次建立新子目录')
    ap.add_argument('--date', help='摘要日期 YYYY-MM-DD，可选')
    ap.add_argument('--note', help='附在摘要中的补充说明，仅适用于单份日志文件')
    ap.add_argument('--max-mib', type=int, default=512, help='单份日志解压后上限，默认 512 MiB')
    ap.add_argument('--pick', action='store_true', help='弹窗选择日志（需要 Python tkinter）')
    ap.add_argument('--version', action='version', version=VERSION)
    args = ap.parse_args(argv)
    if args.date:
        try:
            date.fromisoformat(args.date)
        except ValueError:
            ap.error('--date 必须是 YYYY-MM-DD')
    if args.max_mib < 1:
        ap.error('--max-mib 必须大于 0')
    if args.pick:
        try:
            from tkinter import Tk, filedialog
            window = Tk()
            window.withdraw()
            args.inputs.extend(filedialog.askopenfilenames(title='选择 GPU 日志（可多选）'))
            window.destroy()
        except Exception as exc:
            ap.error(f'无法打开选文件窗口（{type(exc).__name__}），请用命令行传入日志路径。')
    if not args.inputs:
        if args.pick:
            print('已取消，未生成结果。')
            return 0
        ap.error('请指定日志文件或使用 --pick')
    if args.note and (len(args.inputs) != 1 or args.inputs[0].lower().endswith(('.zip', '.tar', '.tgz', '.tar.gz'))):
        ap.error('--note 仅适用于单份日志文件')
    folder, manifest = write_results(args.inputs, args.out, args.date, args.note, args.max_mib*1024*1024)
    print('结果目录：' + str(folder.resolve()))
    print(f'生成 {len(manifest["outputs"])} 份草稿，跳过 {len(manifest["duplicates"])} 份内容相同的报告。')
    if not manifest['complete']:
        print('部分输入未完整读取，请先查看结果索引及证据中的提示。')
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main())
