#!/usr/bin/env python3
# WP2 smoke test for the desktop shell. Offscreen, stdlib unittest, no real backend.
# Run: QT_QPA_PLATFORM=offscreen python3 tools/app/test_scc.py
import importlib.util
import os
import subprocess
import sys
import tempfile
import time
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
DEFAULT_SERVER_NAME = scc.SERVER_NAME  # tests re-scope the socket name; keep the default here


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
        # Never touch the socket of a real running window: scope the name to this test run.
        scc.SERVER_NAME = "scc-test-single-%d" % os.getpid()

    def test_paths_live_under_reports_app(self):
        self.assertTrue(scc.LOG_FILE.endswith(os.path.join("reports", "app", "scc.log")))
        self.assertEqual(DEFAULT_SERVER_NAME, "stavros-cc-single")

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

    def _qt(self):
        try:
            from PyQt6.QtWidgets import QApplication
            from PyQt6.QtNetwork import QLocalServer, QLocalSocket
        except ImportError:
            self.skipTest("PyQt6 unavailable")
        app = QApplication.instance() or QApplication(sys.argv)
        return app, QLocalServer, QLocalSocket

    def test_single_instance_with_qt(self):
        _, QLocalServer, _ = self._qt()
        server = scc.acquire_single_instance()
        self.assertIsNotNone(server)
        if server != "existing":
            server.close()
            QLocalServer.removeServer(scc.SERVER_NAME)

    def test_raise_round_trip_raises_the_window(self):
        app, QLocalServer, QLocalSocket = self._qt()
        from PyQt6.QtWidgets import QMainWindow

        class CountingWindow(QMainWindow):
            def __init__(self):
                super().__init__()
                self.shown = self.raised = self.activated = 0

            def showNormal(self):
                self.shown += 1

            def raise_(self):
                self.raised += 1

            def activateWindow(self):
                self.activated += 1

        server = scc.acquire_single_instance()
        self.assertNotEqual(server, "existing")
        win = CountingWindow()
        scc.serve_raise_requests(server, win)
        try:
            client = QLocalSocket()
            client.connectToServer(scc.SERVER_NAME)
            self.assertTrue(client.waitForConnected(500), "client must connect to the owner")
            client.write(b"raise\n")
            client.flush()
            reply = b""
            deadline = time.time() + 3
            while time.time() < deadline and b"ok" not in reply:
                app.processEvents()
                if client.bytesAvailable():
                    reply += bytes(client.readAll())
                time.sleep(0.01)
            self.assertIn(b"ok", reply, "the owner must acknowledge the raise")
            self.assertEqual((win.shown, win.raised, win.activated), (1, 1, 1),
                             "the raise must bring the window back")
        finally:
            server.close()
            QLocalServer.removeServer(scc.SERVER_NAME)

    def test_second_launch_raises_the_window_across_processes(self):
        """End-to-end: the launch that arrives while a window is up must raise it, not exit.

        In-process tests cannot see this: the client's blocking wait and the owner's event
        loop would starve each other, so the handshake is only real between two processes.
        """
        app, QLocalServer, _ = self._qt()
        name = "scc-test-e2e-%d" % os.getpid()
        scc.SERVER_NAME = name  # the client side must look at the socket the child owns
        script = "\n".join([
            "import importlib.util, sys",
            "spec = importlib.util.spec_from_file_location('scc', %r)" % os.path.join(HERE, "scc.py"),
            "m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)",
            "m.SERVER_NAME = %r" % name,
            "from PyQt6.QtWidgets import QApplication, QMainWindow",
            "from PyQt6.QtCore import QTimer",
            "app = QApplication(sys.argv)",
            "srv = m.acquire_single_instance()",
            "assert not isinstance(srv, str), 'cannot own the test socket'" ,
            "class W(QMainWindow):",
            "    def showNormal(self):",
            "        print('raised', flush=True)",
            "window = W()",
            "m.serve_raise_requests(srv, window)",
            "print('ready', flush=True)",
            "QTimer.singleShot(15000, app.quit)",
            "app.exec()",
        ])
        env = dict(os.environ, QT_QPA_PLATFORM=os.environ.get("QT_QPA_PLATFORM", "offscreen"))
        child = subprocess.Popen([sys.executable, "-c", script], stdout=subprocess.PIPE,
                                 stderr=subprocess.DEVNULL, text=True, env=env)
        try:
            self.assertEqual(child.stdout.readline().strip(), "ready",
                             "the first launch must own the socket")
            result = scc.acquire_single_instance(ack_timeout_ms=3000)
            self.assertEqual(result, "existing",
                             "the second launch must be told the window is up")
            shown = []
            deadline = time.time() + 5
            while time.time() < deadline and not shown:
                line = child.stdout.readline().strip()
                if line:
                    shown.append(line)
            self.assertEqual(shown[:1], ["raised"],
                             "the running window must be raised by the second launch")
        finally:
            child.terminate()
            child.wait(timeout=10)
            child.stdout.close()
            QLocalServer.removeServer(name)

    def test_takes_over_a_peer_that_never_answers(self):
        """A listener that ignores the raise (old build / hung window) must not swallow the launch."""
        app, QLocalServer, _ = self._qt()
        silent = QLocalServer()
        self.assertTrue(silent.listen(scc.SERVER_NAME))
        try:
            server = scc.acquire_single_instance(ack_timeout_ms=100)
            self.assertNotEqual(server, "existing", "silence must not be read as 'already running'")
            self.assertIsNotNone(server, "the launch must still end up owning the socket")
            server.close()
        finally:
            silent.close()
            QLocalServer.removeServer(scc.SERVER_NAME)


if __name__ == "__main__":
    unittest.main()
