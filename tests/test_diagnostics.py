import io
import json
import unittest
from test_parser import parser, parse


SAMPLE = '''*** lspci -Dnnvv
0000:00:01.0 PCI bridge: Example Root Port [0604]
    Bus: primary=00, secondary=41, subordinate=41
    LnkCap: Port #0, Speed 16GT/s, Width x16
    LnkSta: Speed 16GT/s, Width x8 (downgraded)
0000:41:00.0 3D controller: NVIDIA Example GPU [10de:1234]
    NUMA node: 0
    LnkCap: Port #0, Speed 16GT/s, Width x16
    LnkSta: Speed 16GT/s, Width x8 (downgraded)
    CESta: RxErr+ BadTLP- BadDLLP-
    UESta: DLP- SDES- TLP-
    UEMsk: DLP+ SDES+ TLP+
    UESvrt: DLP+ SDES+ TLP+
    DevSta: CorrErr- UncorrErr- FatalErr- UnsuppReq- AuxPwr+ TransPend+
    Kernel driver in use: nvidia
0000:81:00.0 Ethernet controller: Example NIC
    NUMA node: 1
0000:82:00.0 Non-Volatile memory controller: Example NVMe
    NUMA node: 1
*** nvidia-smi --query-gpu=index,pci.bus_id,uuid --format=csv
index, pci.bus_id, uuid
0, 00000000:41:00.0, GPU-example
*** nvidia-smi -q
Attached GPUs : 1
GPU 00000000:41:00.0
    Product Name : NVIDIA Example GPU
    GPU UUID : GPU-example
    FB Memory Usage
        Total : 81920 MiB
        Used : 0 MiB
    PCI
        PCIe Generation
            Max : 4
            Current : 4
        Link Width
            Max : 16x
            Current : 8x
    ECC Errors
        Volatile
            DRAM Correctable : 0
            DRAM Uncorrectable : 2
        Aggregate
            DRAM Uncorrectable : 5
    Remapped Rows
        Pending : Yes
        Remapping Failure Occurred : No
    Retired Pages
        Single Bit ECC : N/A
    MIG Device
        Index : 0
        FB Memory Usage
            Used : 123 MiB
    Temperature
        GPU Current Temp : 42 C
    GPU Power Readings
        Power Draw : 100 W
*** nvidia-smi topo -m
        GPU0    NIC0    CPU Affinity    NUMA Affinity    GPU NUMA ID
GPU0    X       SYS     0-31            0                N/A
NIC0    SYS     X
Legend:
*** lscpu -e=CPU,NODE,SOCKET
CPU NODE SOCKET
0 0 1
32 1 0
*** dmesg
[ 1.0] pcieport 0000:00:01.0: PCIe Bus Error: severity=Corrected, type=Physical Layer
'''


class DiagnosticTests(unittest.TestCase):
    def test_snapshot_hierarchy_na_zero_and_mig(self):
        report = parse(SAMPLE); d = report['diagnostics']; fields = {f['path']: f for f in d['snapshots'][0]['fields']}
        self.assertEqual(fields['FB Memory Usage/Used']['value'], '0 MiB')
        self.assertEqual(fields['MIG Device 0/FB Memory Usage/Used']['value'], '123 MiB')
        self.assertEqual(fields['Retired Pages/Single Bit ECC']['availability'], 'unavailable')
        self.assertEqual(fields['ECC Errors/Volatile/DRAM Correctable']['value'], '0')
        self.assertEqual(len(d['snapshots']), 1)
        self.assertEqual(report['gpus'][0]['memory'], '0 MiB / 81920 MiB')
        json.dumps(report)

    def test_evidence_points_to_exact_input(self):
        report = parse(SAMPLE)
        for s in report['diagnostics']['snapshots']:
            for f in s['fields']:
                self.assertEqual(SAMPLE.splitlines()[f['evidence']['line']-1], f['evidence']['text'])

    def test_checks_only_error_status_not_mask_or_capability(self):
        checks = parse(SAMPLE)['diagnostics']['checks']
        bits = [c for c in checks if c['rule'] == 'pcie-status']
        self.assertEqual(len(bits), 1)
        self.assertEqual(bits[0]['observation'], 'RxErr')
        self.assertEqual(bits[0]['status'], 'error')
        self.assertTrue(all(c['status'] == 'review' for c in checks if c['rule'] == 'pcie-link'))
        self.assertEqual([c['status'] for c in checks if c['rule'] == 'driver'], ['ok'])
        self.assertEqual(len([c for c in checks if c['rule'] == 'aer']), 1)

    def test_ecc_scope_and_pending(self):
        checks = parse(SAMPLE)['diagnostics']['checks']
        health = [c for c in checks if c['rule'] == 'smi-health']
        self.assertEqual(len(health), 3)
        self.assertTrue(any('Volatile' in c['path'] and c['status'] == 'error' for c in health))
        self.assertTrue(any('Aggregate' in c['path'] for c in health))
        self.assertTrue(any(c['path'] == 'Remapped Rows/Pending' and c['status'] == 'review' for c in health))

    def test_smi_link_difference_has_snapshot_and_both_refs(self):
        checks = parse(SAMPLE)['diagnostics']['checks']
        c = next(c for c in checks if c['rule'] == 'smi-link')
        self.assertEqual(c['status'], 'review')
        self.assertEqual(c['snapshot'], 's0')
        self.assertEqual(len(c['evidence']), 2)

    def test_nic_mapping_requires_name_and_sysfs_path(self):
        sample = SAMPLE.replace('Legend:', 'Legend:\nNIC Legend:\nNIC0: mlx5_0')
        sample += '\n*** readlink -f /sys/class/infiniband/mlx5_0/device\n/sys/devices/pci0000:80/0000:81:00.0\n'
        m = parse(sample)['diagnostics']['matrices'][0]
        self.assertEqual(m['mapping']['NIC0'], '0000:81:00.0')
        self.assertEqual(len(m['mappingEvidence']['NIC0']), 2)

    def test_matrix_index_mapping_does_not_cross_boot(self):
        d = parse(SAMPLE.replace('*** nvidia-smi topo -m', '-- Reboot --\n*** nvidia-smi topo -m'))['diagnostics']
        self.assertEqual(d['matrices'][0]['mapping'], {})

    def test_repeated_snapshots_never_merge(self):
        d = parse(SAMPLE + '\n*** nvidia-smi -q\nGPU 0000:41:00.0\n    Temperature\n        GPU Current Temp : 70 C\n')['diagnostics']
        self.assertEqual(len(d['snapshots']), 2)
        self.assertEqual(d['snapshots'][1]['fields'][0]['value'], '70 C')
        self.assertNotEqual(d['snapshots'][0]['id'], d['snapshots'][1]['id'])

    def test_bare_gpu_block_and_identity(self):
        r = parse('GPU 0000:41:00.0\n    Product Name : Example\n    GPU UUID : GPU-example\n    Persistence Mode : Disabled\n')
        self.assertTrue(r['recognized'])
        self.assertEqual(r['gpus'][0]['model'], 'Example')
        self.assertEqual(r['gpus'][0]['uuid'], 'GPU-example')

    def test_whole_machine_nodes_and_cpu_socket_evidence(self):
        r = parse(SAMPLE); d = r['diagnostics']
        self.assertEqual(len(r['nodes']), 4)
        self.assertEqual(r['nodes']['0000:81:00.0']['kind'], 'nic')
        self.assertEqual(r['nodes']['0000:82:00.0']['kind'], 'nvme')
        self.assertEqual(d['topology'][1]['parent'], '0000:00:01.0')
        self.assertEqual(d['cpuRows'][0]['SOCKET'], '1')

    def test_matrix_mode_mapping_affinity(self):
        m = parse(SAMPLE)['diagnostics']['matrices'][0]
        self.assertEqual(m['mode'], 'm'); self.assertTrue(m['complete'])
        self.assertEqual(m['mapping'], {'GPU0': '0000:41:00.0'})
        self.assertEqual(m['rows'][0]['cells'], ['X', 'SYS'])
        self.assertEqual(m['rows'][0]['affinity'], ['0-31', '0', 'N/A'])
        self.assertEqual(m['rows'][0]['affinityValues'], {'CPU Affinity': '0-31', 'NUMA Affinity': '0', 'GPU NUMA ID': 'N/A'})

    def test_logged_ansi_matrix_preserves_raw_evidence(self):
        header = '2026-01-01 01:02:03,000 - INFO    - \x1b[4mGPU0\tGPU1\tNIC0\tCPU Affinity\tNUMA Affinity\tGPU NUMA ID\x1b[0m'
        lines = [header, 'GPU1 SYS X NODE 2-3 1 N/A', 'GPU0 X SYS PHB 0-1 0 N/A', 'NIC0 PHB NODE X', 'NIC Legend:', 'NIC0: mlx5_0']
        m = parse('\n'.join(lines))['diagnostics']['matrices'][0]
        self.assertTrue(m['complete'])
        self.assertEqual(m['labels'], ['GPU0', 'GPU1', 'NIC0'])
        self.assertEqual(m['rows'][0]['label'], 'GPU1')
        self.assertEqual(m['rows'][0]['affinityValues']['NUMA Affinity'], '1')
        self.assertEqual(m['evidence']['text'], header)
        self.assertEqual(m['nicNames']['NIC0'][0]['name'], 'mlx5_0')

    def test_bracket_class_and_confirmed_root(self):
        r = parse('00:01.0 Class [0604]: Device [8086:1234]\n    Bus: primary=00, secondary=41, subordinate=41\n41:00.0 Class [0200]: Device [8086:1234]\n/sys/devices/pci0000:00/0000:00:01.0/0000:41:00.0\n82:00.0 Class [0207]: Device [15b3:1234]\n')
        self.assertEqual(r['nodes']['0000:41:00.0']['kind'], 'nic')
        self.assertEqual(r['nodes']['0000:82:00.0']['kind'], 'nic')
        edges = {e['address']: e for e in r['diagnostics']['topology']}
        self.assertTrue(edges['0000:00:01.0']['rootConfirmed'])
        self.assertFalse(edges['0000:82:00.0']['rootConfirmed'])
        self.assertEqual(edges['0000:41:00.0']['parent'], '0000:00:01.0')

    def test_unknown_gpu_index_is_not_guessed(self):
        m = parse(SAMPLE.replace('0, 00000000:41:00.0, GPU-example', '2, 00000000:41:00.0, GPU-example'))['diagnostics']['matrices'][0]
        self.assertEqual(m['mapping'], {})

    def test_malformed_matrix_retained_as_incomplete(self):
        d = parse(SAMPLE.replace('NIC0    SYS     X', 'NIC0    SYS'))['diagnostics']
        self.assertFalse(d['matrices'][0]['complete'])
        self.assertTrue(any(c['rule'] == 'topology-data' and c['status'] == 'missing' for c in d['checks']))

    def test_one_device_matrix_and_pcie_mode(self):
        d = parse('*** nvidia-smi topo -mp\n GPU0 CPU Affinity NUMA Affinity\nGPU0 X 0-15 0\n')['diagnostics']
        self.assertTrue(d['matrices'][0]['complete']); self.assertEqual(d['matrices'][0]['mode'], 'mp')

    def test_matrix_scales_without_fixed_gpu_count_or_row_order(self):
        for count, nic_count in [(1, 0), (16, 0), (32, 17), (64, 32)]:
            with self.subTest(gpus=count, nics=nic_count):
                names = [f'GPU{i*2}' for i in range(count)] + [f'NIC{i}' for i in range(nic_count)]
                expected = {a: ['X' if a == b else 'SYS' if (i+j)%2 else 'PXB' for j,b in enumerate(names)] for i,a in enumerate(names)}
                lines = ['*** nvidia-smi topo -m', ' '.join(names) + ' CPU Affinity NUMA Affinity GPU NUMA ID']
                for a in reversed(names):
                    lines.append(a + ' ' + ' '.join(expected[a]) + (' 0-31 0 N/A' if a.startswith('GPU') else ''))
                m = parse('\n'.join(lines))['diagnostics']['matrices'][0]
                self.assertTrue(m['complete']); self.assertEqual(m['labels'], names)
                self.assertEqual({r['label']:r['cells'] for r in m['rows']}, expected)

    def test_unknown_relation_and_damaged_row_are_isolated(self):
        text = 'GPU0 GPU1 NIC0 CPU Affinity NUMA Affinity\nGPU0 X FUTURE SYS 0-31 0\nGPU1 FUTURE X SYS 32-63 1\nNIC0 SYS\n'
        m = parse(text)['diagnostics']['matrices'][0]
        self.assertFalse(m['complete']); self.assertEqual(len(m['rows']), 2)
        self.assertEqual(m['rows'][0]['cells'][1], 'FUTURE')
        self.assertTrue(any('保留原值' in w for w in m['warnings']))
        self.assertEqual(m['rows'][1]['affinityValues']['NUMA Affinity'], '1')

    def test_bad_header_cannot_contaminate_previous_block(self):
        r = parse('GPU0 CPU Affinity\nGPU0 X 0-31\nGPU0 GPU0 CPU Affinity\nGPU0 X SYS 0-31\n')
        self.assertFalse(r['complete'])
        self.assertEqual(len(r['diagnostics']['matrices']), 1)
        self.assertEqual(len(r['diagnostics']['matrices'][0]['rows']), 1)

    def test_matrix_limit_is_reported_and_next_block_still_parses(self):
        header = ' '.join(f'GPU{i}' for i in range(257))
        r = parse(header+'\n*** nvidia-smi topo -mp\nGPU0 CPU Affinity\nGPU0 X 0-31\n')
        self.assertFalse(r['complete']); self.assertTrue(any('256' in w for w in r['warnings']))
        self.assertEqual(len(r['diagnostics']['matrices']), 1)
        self.assertTrue(r['diagnostics']['matrices'][0]['complete'])

    def test_p2p_capability_is_not_interpreted_as_connection_matrix(self):
        r = parse('*** nvidia-smi topo -p2p r\nGPU0 GPU1\nGPU0 X OK\nGPU1 OK X\n*** nvidia-smi topo -m\nGPU0 GPU1\nGPU0 X SYS\nGPU1 SYS X\n')
        self.assertEqual(len(r['diagnostics']['matrices']), 1)
        self.assertEqual(r['diagnostics']['matrices'][0]['rows'][0]['cells'], ['X','SYS'])

    def test_ambiguous_parents_and_cycles(self):
        d = parse('00:01.0 PCI bridge: A\n    Bus: primary=00, secondary=41, subordinate=41\n00:02.0 PCI bridge: B\n    Bus: primary=00, secondary=41, subordinate=41\n41:00.0 Ethernet controller: C\n')['diagnostics']
        self.assertTrue(d['topology'][-1]['ambiguous']); self.assertEqual(d['topology'][-1]['parent'], '')
        d = parse('00:01.0 PCI bridge: A\n    Bus: primary=00, secondary=41, subordinate=41\n41:00.0 PCI bridge: B\n    Bus: primary=41, secondary=00, subordinate=ff\n')['diagnostics']
        self.assertTrue(all(n['ambiguous'] and not n['parent'] for n in d['topology']))

    def test_sysfs_paths_and_serializable_raw_result(self):
        p = parser.Parser('example.txt')
        raw = p.parse(io.BytesIO(b'/sys/devices/pci0000:00/0000:00:01.0/0000:40:00.0/0000:41:00.0\n'))
        json.dumps(raw)
        r = parser.convert(raw)
        self.assertTrue(r['recognized'])
        edges = {e['address']: e['parent'] for e in r['diagnostics']['topology']}
        self.assertEqual(edges['0000:41:00.0'], '0000:40:00.0')
        self.assertEqual(edges['0000:40:00.0'], '0000:00:01.0')

    def test_missing_data_is_never_healthy_report(self):
        d = parse('*** dmesg\n[ 1.0] NVRM: Xid (PCI:0000:41:00): 79, lost\n')['diagnostics']
        self.assertTrue(d['checks']); self.assertTrue(all(c['status'] == 'missing' for c in d['checks']))

    def test_numeric_lspci_classes(self):
        r = parse('00:01.0 0604: 8086:1234\n    Bus: primary=00, secondary=41, subordinate=41\n41:00.0 0302: 10de:1234\n81:00.0 0207: 15b3:1234\n82:00.0 0108: 144d:1234\n')
        self.assertEqual(r['gpus'][0]['pci'], '0000:41:00.0')
        self.assertEqual(r['gpus'][0]['parent'], '0000:00:01.0')
        self.assertEqual(r['nodes']['0000:81:00.0']['kind'], 'nic')
        self.assertEqual(r['nodes']['0000:82:00.0']['kind'], 'nvme')

    def test_section_boundaries_stop_scope_leak(self):
        r = parse('GPU 0000:41:00.0\n    Temperature\n        GPU Current Temp : 40 C\n*** dmidecode\n    Product Name : SERVER\n    GPU Current Temp : 99 C\n')
        self.assertEqual(len(r['diagnostics']['snapshots'][0]['fields']), 1)
        self.assertEqual(r['gpus'][0]['model'], '')


if __name__ == '__main__': unittest.main()
