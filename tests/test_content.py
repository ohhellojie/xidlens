import unittest
from test_parser import parse

HEADER='Attached GPUs : 1\nGPU 00000000:41:00.0\n    Product Name : NVIDIA Demo\n'

class ContentTests(unittest.TestCase):
    def test_zero_health_values_and_no_keep_full_source(self):
        r=parse(HEADER+'''    ECC Errors
        Volatile
            DRAM Uncorrectable : 0
        Aggregate
            DRAM Uncorrectable : 9
    Remapped Rows
        Correctable Error : 0
        Pending : No
''')
        g=r['gpus'][0];fields=g['healthFields']
        self.assertEqual(fields['ECC Errors/Volatile/DRAM Uncorrectable'][0]['value'],'0')
        self.assertEqual(fields['Remapped Rows/Pending'][0]['value'],'No')
        self.assertIn('Pending : No',fields['Remapped Rows/Pending'][0]['evidence']['text'])
        self.assertEqual(len(g['healthCounters']),1)
        self.assertEqual(r['events'],[])

    def test_driver_and_gpu_address_have_source_lines(self):
        text='Driver Version : 580.65.06\n'+HEADER
        r=parse(text);self.assertEqual(r['server']['driver'],'580.65.06')
        ref=r['server']['fields']['driver'][0]
        self.assertEqual(ref['evidence']['line'],1)
        self.assertEqual(ref['evidence']['text'],'Driver Version : 580.65.06')
        self.assertEqual(r['gpus'][0]['fields']['pci'][0]['evidence']['text'],'GPU 00000000:41:00.0')

    def test_kernel_driver_version_is_captured_with_evidence(self):
        r=parse('NVRM version: NVIDIA UNIX Open Kernel Module for x86_64  580.65.06\n'+HEADER)
        self.assertEqual(r['server']['driver'],'580.65.06')
        self.assertEqual(r['server']['fields']['driver'][0]['evidence']['line'],1)

    def test_mig_health_is_not_compared_as_physical_gpu_health(self):
        r=parse(HEADER+'''    MIG Device
        Index : 0
        ECC Errors
            Volatile
                DRAM Uncorrectable : 9
    ECC Errors
        Volatile
            DRAM Uncorrectable : 0
''')
        self.assertEqual(list(r['gpus'][0]['healthFields']),['ECC Errors/Volatile/DRAM Uncorrectable'])
        self.assertEqual(r['gpus'][0]['healthFields']['ECC Errors/Volatile/DRAM Uncorrectable'][0]['value'],'0')

    def test_mig_memory_is_separate_from_whole_gpu(self):
        r=parse(HEADER+'''    MIG Device
        GPU Instance ID : 1
        FB Memory Usage
            Total : 40000 MiB
            Used : 20000 MiB
    FB Memory Usage
        Total : 80000 MiB
        Used : 30000 MiB
''')
        g=r['gpus'][0]
        self.assertEqual(g['memory'],'30000 MiB / 80000 MiB')
        self.assertEqual(g['scopedMetrics']['MIG Device/FB Memory Usage/memory_used'][0]['value'],'20000 MiB')

    def test_power_scope_and_multiple_samples(self):
        r=parse(HEADER+'''    GPU Power Readings
        Power Draw : 100 W
    GPU Memory Power Readings
        Power Draw : 25 W
    Temperature
        GPU Current Temp : 50 C
'''+HEADER+'''    Temperature
        GPU Current Temp : 60 C
''')
        g=r['gpus'][0]
        self.assertEqual(g['power'],'100 W')
        self.assertEqual(g['temp'],'多个采集值')
        self.assertEqual([v['value'] for v in g['metrics']['temp']],['50 C','60 C'])
        self.assertEqual(g['status'],'已读取')
        self.assertEqual(g['errors'],0)

    def test_mig_instances_keep_their_identifiers_and_values(self):
        r=parse(HEADER+'''    MIG Device
        Index : 0
        GPU Instance ID : 1
        Compute Instance ID : 0
        FB Memory Usage
            Used : 10 MiB
    MIG Device
        Index : 1
        GPU Instance ID : 2
        Compute Instance ID : 0
        FB Memory Usage
            Used : 20 MiB
''')
        fields=r['gpus'][0]['scopedMetrics']
        self.assertEqual(fields['MIG Device 0/Compute Instance ID'][0]['value'],'0')
        self.assertEqual(fields['MIG Device 0/Index'][0]['value'],'0')
        self.assertEqual(fields['MIG Device 0/FB Memory Usage/memory_used'][0]['value'],'10 MiB')
        self.assertEqual(fields['MIG Device 1/FB Memory Usage/memory_used'][0]['value'],'20 MiB')
        self.assertEqual(r['gpus'][0]['memory'],'')

    def test_health_hierarchy_keeps_legacy_and_modern_counts(self):
        r=parse(HEADER+'''    ECC Errors
        Volatile
            Double Bit
                Device Memory : 7
        Aggregate
            Double Bit
                Device Memory : 12
    Remapped Rows
        Correctable Error : 2
        Pending : Yes
''')
        g=r['gpus'][0]
        self.assertEqual(g['ecc'],'7')
        self.assertEqual([(c['path'],c['value']) for c in g['healthCounters']],[
            ('ECC Errors/Volatile/Double Bit/Device Memory','7'),
            ('ECC Errors/Aggregate/Double Bit/Device Memory','12'),
            ('Remapped Rows/Correctable Error','2'),('Remapped Rows/Pending','Yes')])
        self.assertEqual(r['events'],[])
        modern=parse(HEADER+'    ECC Errors\n        Volatile\n            DRAM Uncorrectable : 4576\n')
        self.assertEqual(modern['gpus'][0]['ecc'],'4576')

    def test_long_supported_error_line_retains_tail(self):
        line='[ 1.0] NVRM: Xid (PCI:0000:41:00): 79, '+'A'*40000+'TAIL_MARKER'
        r=parse('NVIDIA bug report log file\n'+line+'\n')
        self.assertEqual(r['events'][0]['raw'],line)
        self.assertFalse(r['events'][0]['truncated'])
        self.assertTrue(r['complete'])

    def test_over_limit_line_is_explicitly_incomplete(self):
        r=parse('NVIDIA bug report log file\n'+'A'*(1024*1024)+'\n')
        self.assertFalse(r['complete'])
        self.assertTrue(any('超长行' in w for w in r['warnings']))

    def test_upstream_error_is_not_a_gpu_error(self):
        r=parse('00:01.0 PCI bridge: Demo\n    Bus: primary=00, secondary=41, subordinate=41\n41:00.0 3D controller: NVIDIA Demo GPU\n[ 12.000] pcieport 0000:00:01.0: AER: Uncorrected (Fatal) error received\n')
        self.assertEqual(r['gpus'][0]['errors'],0)
        self.assertEqual(r['events'][0]['gpu'],None)
        self.assertEqual(r['events'][0]['address'],'0000:00:01.0')
