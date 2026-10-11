import gzip
import io
import os
from pathlib import Path
import sys
import tempfile
import unittest
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'app'))
import parser

SAMPLE = """NVIDIA bug report log file
Handle 0x0001, DMI type 1, 27 bytes
System Information
    Product Name: Demo Server
    Serial Number: DEMO-SERVER-001
Handle 0x0002, DMI type 2, 15 bytes
Base Board Information
    Serial Number: DEMO-BOARD-002
00:01.0 PCI bridge: Demo
    Physical Slot: 88
    Bus: primary=00, secondary=41, subordinate=41
41:00.0 3D controller: NVIDIA Demo GPU
    NUMA node: 0
Handle 0x0090, DMI type 9, 17 bytes
System Slot Information
    Designation: DEMO_SLOT_A
    Bus Address: 0000:41:00.0
Handle 0x0091, DMI type 9, 17 bytes
System Slot Information
    Designation: DEMO_NIC_SLOT
    Bus Address: 0000:42:00.0
__________
*** /proc/driver/nvidia/gpus/0000:41:00.0/information
Model: Demo GPU
Serial Number: DEMO-GPU-001
GPU UUID: GPU-DEMO-001
__________
[ 12.345] NVRM: Xid (PCI:0000:41:00): 79, GPU has fallen off the bus.
[ 12.346] NVRM: Xid (PCI:0000:41:00): 999, unknown
"""

def parse(text):
    return parser.convert(parser.Parser('synthetic.txt').parse(io.BytesIO(text.encode())))

class ParserTests(unittest.TestCase):
    def test_identity_and_slot_sources(self):
        c = parse(SAMPLE)
        self.assertEqual(c['server']['sn'], 'DEMO-SERVER-001')
        g = c['gpus'][0]
        self.assertEqual(g['sn'], 'DEMO-GPU-001')
        self.assertEqual(g['slot'], 'DEMO_SLOT_A')
        self.assertNotIn('DEMO_NIC_SLOT', g['slotRaw'])
        self.assertEqual(g['parent'], '0000:00:01.0')
        self.assertEqual(g['numa'], '0')
        self.assertEqual(g['index'], '')

    def test_conflicting_serials_are_preserved(self):
        c = parse(SAMPLE + '\n*** /proc/driver/nvidia/gpus/0000:41:00.0/information\nSerial Number: DEMO-GPU-OTHER\n')
        self.assertEqual(c['gpus'][0]['sn'], '冲突')
        self.assertEqual(len(c['gpus'][0]['fields']['serial']), 2)

    def test_unknown_xid_retains_original_line(self):
        c = parse(SAMPLE)
        e = c['events'][1]
        self.assertEqual(e['code'], '999')
        self.assertIsNone(e['manual'])
        self.assertIn('unknown', e['raw'])
        self.assertGreater(e['line'], 0)

    def test_nul_does_not_hide_later_event(self):
        c = parse(SAMPLE.replace('fallen off the bus.', 'fallen off the bus.\x00'))
        self.assertEqual(len(c['events']), 2)

    def test_missing_fields_are_not_inferred(self):
        c = parse('NVIDIA bug report log file\n[ 1.0] NVRM: Xid (PCI:0000:41:00): 79, lost\n')
        self.assertEqual(c['server']['sn'], '')
        self.assertEqual(c['gpus'][0]['sn'], '')
        self.assertEqual(c['gpus'][0]['slot'], '')

    def test_compressed_input_keeps_reports_separate(self):
        with tempfile.TemporaryDirectory() as temp:
            p = Path(temp)/'synthetic.gz'
            p.write_bytes(gzip.compress(SAMPLE.encode()))
            self.assertEqual(len(parser.analyze(p)[0]['gpus']), 1)
            p = Path(temp)/'synthetic.zip'
            with zipfile.ZipFile(p, 'w') as z:
                z.writestr('first.txt', SAMPLE)
                z.writestr('second.txt', SAMPLE.replace('DEMO-SERVER-001', 'DEMO-SERVER-002'))
            cases = parser.analyze(p)
            self.assertEqual(len(cases), 2)
            self.assertEqual({c['server']['sn'] for c in cases}, {'DEMO-SERVER-001', 'DEMO-SERVER-002'})

if __name__ == '__main__':
    unittest.main()
