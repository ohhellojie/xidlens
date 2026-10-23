import io
import random
import tempfile
import unittest
import zipfile
from pathlib import Path
from test_parser import parser, parse


XID = 'NVRM: Xid (PCI:0000:41:00): 79, lost\n'


class RobustnessTests(unittest.TestCase):
    def test_sriov_functions_are_not_counted_as_physical_gpus(self):
        text = ('0000:41:00.0 Class [0302]: Device [10de:26ba]\n'
                '    IOVCtl: Enable+ Migration-\n'
                '    Initial VFs: 32, Total VFs: 32, Number of VFs: 32, Function Dependency Link: 00\n'
                '    VF offset: 4, stride: 1, Device ID: 26ba\n'
                '0000:41:00.4 Class [0302]: Device [10de:26ba]\n'
                '    LnkCap: Speed 16GT/s, Width x16\n'
                '    LnkSta: Speed 8GT/s, Width x0\n'
                '0000:41:04.3 Class [0302]: Device [10de:26ba]\n'
                '0001:41:00.4 Class [0302]: Device [10de:26ba]\n')
        report = parse(text)
        self.assertEqual([g['pci'] for g in report['gpus']], ['0000:41:00.0','0001:41:00.4'])
        self.assertEqual(report['nodes']['0000:41:04.3']['physicalFunction'], '0000:41:00.0')
        self.assertFalse(any(c['rule']=='pcie-link' and c['address']=='0000:41:00.4' for c in report['diagnostics']['checks']))
        edge = next(e for e in report['diagnostics']['topology'] if e['address']=='0000:41:00.4')
        self.assertEqual(edge['parent'], '0000:41:00.0');self.assertEqual(len(edge['evidence']), 3)
        self.assertEqual(len(parse(text.replace('Enable+', 'Enable-'))['gpus']), 4)
        self.assertEqual(len(parse(text.replace('VF offset: 4', 'VF offset: unknown'))['gpus']), 4)

    def test_smi_read_error_is_not_an_identity_value(self):
        report = parse('GPU 00000000:41:00.0\n    GPU UUID : GPU requires reset\n    VBIOS Version : Unknown Error\n')
        self.assertEqual(report['gpus'][0]['uuid'], '')
        checks = [c for c in report['diagnostics']['checks'] if c['rule']=='smi-read']
        self.assertEqual(len(checks), 2);self.assertTrue(all(c['status']=='error' for c in checks))
        self.assertEqual(report['diagnostics']['snapshots'][0]['fields'][0]['value'], 'GPU requires reset')

    def test_bad_scalar_and_csv_rows_do_not_hide_later_errors(self):
        for bad in ['x'*140000+',tail', 'Attached GPUs : '+'9'*5000]:
            with self.subTest(prefix=bad[:20]):
                report = parse(bad+'\n*** dmesg\n'+XID)
                self.assertEqual(len(report['events']), 1)
                self.assertEqual(report['events'][0]['code'], '79')
                self.assertFalse(report['complete'])
                self.assertTrue(any('继续读取' in w for w in report['warnings']))

    def test_malformed_link_speed_is_missing_data(self):
        report = parse('41:00.0 3D controller: NVIDIA GPU\n    LnkCap: Speed 16..0GT/s, Width x16\n    LnkSta: Speed 8GT/s, Width x16\n')
        self.assertEqual(next(c for c in report['diagnostics']['checks'] if c['rule']=='pcie-link')['status'], 'missing')

    def test_unmarked_command_and_boot_boundaries_reset_fields(self):
        for boundary in ['lspci', 'root@host:~# lspci -vv', '-- Reboot --']:
            report = parse('41:00.0 3D controller: NVIDIA GPU\n    LnkSta: Speed 16GT/s, Width x16\n'+boundary+'\n    LnkSta: Speed 8GT/s, Width x8\n')
            self.assertEqual(report['gpus'][0]['link'], '16GT/s · x16')

    def test_summary_table_and_cpu_only_output_are_recognized(self):
        report = parse('|  0  NVIDIA Example Off | 00000000:41:00.0 Off | N/A |\n')
        self.assertTrue(report['recognized'])
        self.assertEqual(report['gpus'][0]['index'], '0')
        self.assertEqual(report['gpus'][0]['pci'], '0000:41:00.0')
        self.assertTrue(parse('CPU NODE SOCKET\n0 0 0\n1 1 1\n')['recognized'])

    def test_damaged_compressed_member_does_not_hide_next_member(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'mixed.zip'
            with zipfile.ZipFile(path, 'w') as archive:
                archive.writestr('broken.log.gz', b'\x1f\x8b\x08\x00'+b'\x00'*6+b'\xff'*30)
                archive.writestr('good.log', XID)
            reports = parser.analyze(path)
            good = next(r for r in reports if r['source'].endswith('good.log'))
            self.assertEqual(len(good['events']), 1)
            self.assertFalse(good['complete'])

    def test_mixed_unrecognized_lines_leave_valid_tail_readable(self):
        rng = random.Random(20261022)
        alphabet = 'abcXYZ0123456789\t :=[]|,中文'
        for _ in range(50):
            lines = [''.join(rng.choices(alphabet, k=rng.randrange(1, 500))) for _ in range(15)]
            report = parse('\n'.join(lines)+'\n*** dmesg\n'+XID)
            self.assertEqual(report['events'][-1]['code'], '79')

    def test_cancel_is_checked_during_diagnostic_organization(self):
        class Cancel:
            def __init__(self): self.count=0
            def is_set(self): self.count+=1;return self.count>10
        raw = parser.Parser('many.log').parse(io.BytesIO((''.join(f'{i:02x}:00.0 Ethernet controller: NIC\n' for i in range(100))).encode()))
        with self.assertRaises(parser.core.AnalysisCancelled): parser.convert(raw, cancel_event=Cancel())


if __name__ == '__main__': unittest.main()
