import os
import subprocess
import sys
import time
import unittest

from app.local_llm_config import _pid_alive


class PidAliveTests(unittest.TestCase):
    def test_probe_does_not_terminate_the_process(self):
        # #198: on Windows os.kill(pid, 0) calls TerminateProcess; the probe must be harmless.
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
        try:
            self.assertTrue(_pid_alive(child.pid))
            self.assertTrue(_pid_alive(child.pid))
            time.sleep(0.2)
            self.assertIsNone(child.poll(), "存活探测不得结束被探测的进程")
        finally:
            child.kill()
            child.wait()
        self.assertFalse(_pid_alive(child.pid))

    def test_current_process_and_invalid_ids(self):
        self.assertTrue(_pid_alive(os.getpid()))
        for value in (0, -1, None, "123", 1.5):
            self.assertFalse(_pid_alive(value))


if __name__ == "__main__":
    unittest.main()
