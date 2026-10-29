import io
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'app'))
import parser


GPU_A = 'GPU-11111111-2222-3333-4444-555555555555'
GPU_B = 'GPU-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'


def parse(text, member=None):
    result = parser.Parser('synthetic.log').parse(io.BytesIO(text.encode()))
    if member:
        result['source_member'] = member
    return parser.convert(result)


def identity(address='0000:41:00.0', gpu=GPU_A):
    return f'*** /proc/driver/nvidia/gpus/{address}/information\nGPU UUID: {gpu}\n'


def reset(success='true', gpu=GPU_A):
    return f'GPU reset executed: {gpu}, success: {success}'


def action(previous='0x1 (GPU Reset Required)', current='0x0 (None)'):
    return f'NVRM: Xid (PCI:0000:41:00): 154, GPU recovery action changed from {previous} to {current}'


class LifecycleTests(unittest.TestCase):
    def test_reset_completion_retains_uuid_and_original_evidence(self):
        line = '2026-10-28T12:00:00.123456789+08:00 node-demo janitor: ' + reset()
        result = parse(identity() + '-- Boot demo-a --\n' + line + '\n', 'logs/synthetic.log')
        event = result['lifecycleEvents'][0]
        self.assertEqual(event['kind'], 'reset')
        self.assertEqual(event['outcome'], 'completed')
        self.assertEqual(event['targetUUID'], GPU_A)
        self.assertEqual(event['gpu'], 0)
        self.assertEqual(event['address'], '', 'a UUID result does not establish a historical BDF')
        self.assertEqual(event['association']['refs'][0]['evidence']['line'], 2)
        self.assertEqual(event['line'], 4)
        self.assertEqual(event['raw'], line)
        self.assertEqual(event['source'], 'synthetic.log')
        self.assertEqual(event['sourceMember'], 'logs/synthetic.log')
        self.assertEqual(event['timeInfo']['raw'], '2026-10-28T12:00:00.123456789+08:00')
        self.assertEqual(event['timeInfo']['timezone'], '+08:00')
        self.assertEqual(event['boot'], '-- Boot demo-a --')
        self.assertEqual(result['gpus'][0]['errors'], 0)
        self.assertEqual(result['events'], [])

    def test_failed_reset_is_a_result_not_an_additional_xid(self):
        result = parse(identity() + '[12.000] NVRM: Xid (PCI:0000:41:00): 79, GPU has fallen off the bus.\n'
                       + '[13.000] ' + reset('false') + '\n')
        self.assertEqual(result['lifecycleEvents'][0]['outcome'], 'failed')
        self.assertEqual(result['lifecycleEvents'][0]['title'], 'GPU 重置失败')
        self.assertEqual(len(result['events']), 1)
        self.assertEqual(result['gpus'][0]['errors'], 1)

    def test_xid_descriptions_do_not_duplicate_generic_ecc_or_channel_events(self):
        result = parse(identity() + '[1.000] NVRM: Xid (PCI:0000:41:00): 48, uncorrectable ECC error\n'
                       + '[2.000] NVRM: Xid (PCI:0000:41:00): 109, channel timeout\n')
        self.assertEqual([e['kind'] for e in result['events']], ['xid', 'xid'])
        self.assertEqual([e['line'] for e in result['events']], [3, 4])
        self.assertEqual(result['gpus'][0]['errors'], 2)

    def test_generic_ecc_and_channel_events_keep_separate_original_lines(self):
        result = parse(identity() + '[1.000] NVRM: 0000:41:00.0 uncorrectable ECC error\n'
                       + '[2.000] NVRM: 0000:41:00.0 channel timeout\n')
        self.assertEqual([e['kind'] for e in result['events']], ['ecc', 'channel'])
        self.assertEqual([e['line'] for e in result['events']], [3, 4])

    def test_standalone_reset_does_not_create_an_invented_gpu(self):
        result = parse(reset() + '\n')
        self.assertTrue(result['recognized'])
        self.assertEqual(result['gpus'], [])
        self.assertIsNone(result['lifecycleEvents'][0]['gpu'])

    def test_uuid_conflict_and_duplicate_locations_do_not_associate(self):
        scenarios = [identity() + f'GPU UUID: {GPU_B}\n',
                     identity() + identity('0000:42:00.0'),
                     identity() + identity('0000:42:00.0') + f'GPU UUID: {GPU_B}\n',
                     identity(gpu=GPU_B)]
        for sample in scenarios:
            with self.subTest(sample=sample):
                result = parse(sample + reset() + '\n')
                self.assertIsNone(result['lifecycleEvents'][0]['gpu'])
                self.assertNotIn('association', result['lifecycleEvents'][0])

    def test_uuid_matching_is_case_insensitive(self):
        result = parse(identity(gpu=GPU_B.upper()) + reset(gpu=GPU_B) + '\n')
        self.assertEqual(result['lifecycleEvents'][0]['gpu'], 0)

    def test_recovery_action_none_preserves_transition_without_claiming_health(self):
        raw = '[42.000] ' + action()
        result = parse(raw + '\n')
        event = result['events'][0]
        self.assertEqual(event['kind'], 'xid')
        self.assertEqual(event['code'], '154')
        self.assertEqual(event['recoveryAction']['current'], {'code': '0x0', 'label': 'None'})
        self.assertEqual(event['recoveryAction']['previous']['label'], 'GPU Reset Required')
        self.assertEqual(event['raw'], raw)
        self.assertEqual(event['timeInfo']['kind'], 'uptime_seconds')
        self.assertNotIn('recovered', event)
        self.assertEqual(result['lifecycleEvents'], [])

    def test_required_reset_is_not_completed_reset(self):
        result = parse(action('0x0 (None)', '0x1 (GPU Reset Required)') + '\n')
        self.assertEqual(result['events'][0]['recoveryAction']['current']['label'], 'GPU Reset Required')
        self.assertEqual(result['lifecycleEvents'], [])

    def test_unknown_action_is_preserved_without_guessing(self):
        result = parse(action(current='0xff (Future Action)') + '\n')
        self.assertEqual(result['events'][0]['recoveryAction']['current']['label'], 'Future Action')
        self.assertEqual(result['lifecycleEvents'], [])

    def test_driver_banners_record_loading_not_successful_reload(self):
        for name in ('NVIDIA UNIX Open Kernel Module for x86_64', 'NVIDIA UNIX x86_64 Kernel Module'):
            with self.subTest(name=name):
                result = parse(f'[1.000] NVRM: loading {name}  580.0  Release Build\n')
                event = result['lifecycleEvents'][0]
                self.assertEqual(event['kind'], 'driver_load')
                self.assertEqual(event['driverVersion'], '580.0')
                self.assertEqual(event['outcome'], 'observed')
                self.assertTrue(result['recognized'])
                self.assertEqual(result['events'], [])

    def test_requests_partial_modules_and_unverified_text_do_not_complete_actions(self):
        lines = [f'nvidia-smi --gpu-reset -i {GPU_A}', 'GPU Reset Required',
                 '[1.000] nvidia-drm: Unloading driver',
                 'NVRM version: NVIDIA UNIX Open Kernel Module for x86_64 580.0',
                 'GPU recovered successfully', 'No errors observed for 60 minutes',
                 reset('truefalse'), reset('unknown'), reset(gpu='GPU-0')]
        self.assertEqual(parse('\n'.join(lines))['lifecycleEvents'], [])

    def test_clock_domains_and_boot_markers_are_preserved(self):
        cases = [('2026-10-28T12:00:00+0800', 'calendar'),
                 ('2026-10-28T12:00:00Z', 'calendar'),
                 ('2026-10-28 12:00:00', 'calendar'),
                 ('Oct 28 12:00:00', 'calendar_without_year_or_zone'),
                 ('[0]', 'uptime_seconds'), ('[12.345]', 'uptime_seconds'), ('', 'unknown')]
        for prefix, kind in cases:
            with self.subTest(prefix=prefix):
                result = parse('-- Boot demo-b --\n' + (prefix + ' ' if prefix else '') + reset())
                event = result['lifecycleEvents'][0]
                self.assertEqual(event['timeInfo']['kind'], kind)
                self.assertEqual(event['timeInfo']['boot'], '-- Boot demo-b --')
                if prefix == '2026-10-28 12:00:00':
                    self.assertIsNone(event['timeInfo']['timezone'])

    def test_boot_and_driver_loading_do_not_invent_a_counter_epoch(self):
        result = parse(identity() + '-- Boot demo-a --\n[1.000] NVRM: loading NVIDIA UNIX x86_64 Kernel Module 580.0\n')
        self.assertNotIn('counterEpochs', result)
        self.assertNotIn('counterEpochs', result['gpus'][0])

    def test_lifecycle_limit_is_explicit_and_does_not_change_error_groups(self):
        reader = parser.Parser('synthetic.log')
        for number in range(10001):
            reader.consume(reset(), number + 1)
        self.assertEqual(len(reader.r['lifecycle_records']), 10000)
        self.assertFalse(reader.r['complete'])
        self.assertEqual(reader.groups, {})
        self.assertEqual(len(reader.r['warnings']), 1)


if __name__ == '__main__':
    unittest.main()
