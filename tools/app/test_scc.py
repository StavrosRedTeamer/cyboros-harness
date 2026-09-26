#!/usr/bin/env python3
# WP2 smoke test for the desktop shell. Offscreen, stdlib unittest, no real backend.
# Run: QT_QPA_PLATFORM=offscreen python3 tools/app/test_scc.py
import importlib.util
import os
import sys
import tempfile
import unittest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

HERE = os.path.dirname(os.path.abspath(__file__))
WS = os.path.dirname(os.path.dirname(HERE))


def load_scc():
    spec = importlib.util.spec_from_file_location("scc", os.path.join(HERE, "scc.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


scc = load_scc()


class FakePopen:
    def __init__(self, args, **kwargs):
        self.args = args
        self.returncode = None
        self.stdout = iter([
            "Stavros Console  →  http://127.0.0.1:0/\n",
            "SCC_PORT=54321\n",
            "SCC_URL=http://127.0.0.1:54321/?token=deadbeef\n",
        ])

    def poll(self):
        return None

    def terminate(self):
        self.returncode = 0

    def kill(self):
        self.returncode = -9

    def wait(self, timeout=None):
        return 0


class FakeRun:
    def __init__(self, returncode=1, stdout=""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = ""


class ShellTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="scc-test-")
        os.environ["CC_STATE_DIR"] = self.tmp

    def test_paths_live_under_reports_app(self):
        self.assertTrue(scc.LOG_FILE.endswith(os.path.join("reports", "app", "scc.log")))
        self.assertEqual(scc.SERVER_NAME, "stavros-cc-single")

    def test_supervisor_spawns_with_instance_and_parses_handshake(self):
        captured = {}

        def fake_popen(args, **kwargs):
            captured["args"] = args
            return FakePopen(args, **kwargs)

        old_run, old_popen = scc.subprocess.run, scc.subprocess.Popen
        try:
            scc.subprocess.run = lambda *a, **k: FakeRun(returncode=1, stdout="")
            scc.subprocess.Popen = fake_popen
            sup = scc.BackendSupervisor(read_only=True)
            url = sup.start()
        finally:
            scc.subprocess.run, scc.subprocess.Popen = old_run, old_popen

        self.assertIn("--instance", captured["args"], "supervisor must spawn with --instance")
        self.assertIn("--print-port", captured["args"])
        self.assertEqual(url, "http://127.0.0.1:54321/?token=deadbeef")
        self.assertEqual(sup.port, 54321)
        self.assertTrue(sup.owned)

    def test_supervisor_attaches_to_a_live_instance(self):
        old_run, old_popen = scc.subprocess.run, scc.subprocess.Popen
        try:
            scc.subprocess.run = lambda *a, **k: FakeRun(returncode=0, stdout="http://127.0.0.1:8787/?token=x\n")
            scc.subprocess.Popen = lambda *a, **k: (_ for _ in ()).throw(AssertionError("must not spawn"))
            sup = scc.BackendSupervisor()
            url = sup.start()
        finally:
            scc.subprocess.run, scc.subprocess.Popen = old_run, old_popen
        self.assertEqual(url, "http://127.0.0.1:8787/?token=x")
        self.assertFalse(sup.owned, "an attached supervisor does not own the backend")

    def test_circuit_breaker_suspends_restarts(self):
        sup = scc.BackendSupervisor()
        sup.owned = True

        class Dead:
            returncode = 1

            def poll(self):
                return 1

        sup.proc = Dead()
        sup.start = lambda: (_ for _ in ()).throw(RuntimeError("boom"))
        for _ in range(6):
            sup.ensure_alive()
        self.assertGreaterEqual(len(sup.restarts), 5)
        # once the breaker is full, a further call must NOT attempt another restart
        n = len(sup.restarts)
        sup.ensure_alive()
        self.assertEqual(len(sup.restarts), n)

    def test_single_instance_with_qt(self):
        try:
            from PyQt6.QtWidgets import QApplication  # noqa: F401
            from PyQt6.QtNetwork import QLocalServer
        except ImportError:
            self.skipTest("PyQt6 unavailable")
        app = QApplication.instance() or QApplication(sys.argv)
        server = scc.acquire_single_instance()
        self.assertIsNotNone(server)
        if server != "existing":
            server.close()
            QLocalServer.removeServer(scc.SERVER_NAME)


if __name__ == "__main__":
    unittest.main()
