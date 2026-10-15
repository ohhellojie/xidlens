import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'app'))
from instance import Instance


@unittest.skipUnless(sys.platform=='win32','Windows process ownership')
class InstanceTests(unittest.TestCase):
    def run_child(self,root,hold=False):
        script="""
import sys,time
from pathlib import Path
from instance import Instance
with Instance(Path(sys.argv[1])) as guard:
    owned=guard.acquire()
    print('owned' if owned else 'duplicate',flush=True)
    if owned and sys.argv[2]=='hold':time.sleep(30)
"""
        env=os.environ.copy();env['PYTHONPATH']=str(Path(__file__).resolve().parents[1]/'app')
        return subprocess.Popen([sys.executable,'-u','-c',script,str(root),'hold' if hold else 'exit'],
                                env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)

    def test_duplicate_notifies_owner_and_other_directory_is_independent(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);activated=threading.Event()
            with Instance(root) as owner:
                self.assertTrue(owner.acquire());owner.listen(activated.set)
                duplicate=self.run_child(root)
                output,error=duplicate.communicate(timeout=10)
                self.assertEqual(duplicate.returncode,0,error);self.assertEqual(output.strip(),'duplicate')
                self.assertTrue(activated.wait(2))
                other=self.run_child(root/'other');output,error=other.communicate(timeout=10)
                self.assertEqual(other.returncode,0,error);self.assertEqual(output.strip(),'owned')

    def test_force_exit_does_not_leave_a_stale_lock(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);child=self.run_child(root,True)
            try:
                self.assertEqual(child.stdout.readline().strip(),'owned')
                child.kill();child.communicate(timeout=10)
                with Instance(root) as next_owner:self.assertTrue(next_owner.acquire())
            finally:
                if child.poll() is None:child.kill();child.communicate(timeout=10)
