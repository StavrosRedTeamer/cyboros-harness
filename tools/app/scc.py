#!/usr/bin/env python3
# Stavros Command Center — desktop shell (WP2).
#
# A thin PyQt6 frame around the SPA served by tools/gui-server.js. The shell
# SUPERVISES the backend (spawn → health → restart with a circuit breaker), owns a
# single instance (QLocalServer), shows a status tray + desktop notifications, and
# remembers geometry/dock state in QSettings. It never talks to the guards directly:
# the SPA does that over loopback with the session token.
#
# PyQt6 is OPTIONAL at runtime. If it is missing this file degrades to the documented
# fallback: Chromium --app, then the default browser. Node stays the only hard dep.
#
# Usage:
#   tools/app/scc.py [--read-only] [--headless] [--web] [--kiosk] [--keep-server]
#
# --read-only    backend refuses every write (403 read-only)
# --web          do not open a native window; hand the URL to the browser
# --headless     run the backend supervisor only (no window, no tray)
# --kiosk        fullscreen the web view
# --keep-server  leave the backend running when the window closes
import os
import sys
import json
import shutil
import socket
import subprocess
import threading
import time
import urllib.request

WS = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TOOLS = os.path.join(WS, "tools")
LOG_DIR = os.path.join(WS, "reports", "app")
LOG_FILE = os.path.join(LOG_DIR, "scc.log")
APP_NAME = "stavros-cc"
SERVER_NAME = "stavros-cc-single"


def log(msg):
    try:
        os.makedirs(LOG_DIR, exist_ok=True)
        line = "%s %s\n" % (time.strftime("%Y-%m-%dT%H:%M:%S"), msg)
        with open(LOG_FILE, "a") as fh:
            fh.write(line)
    except OSError:
        pass
    sys.stderr.write("[scc] %s\n" % msg)


def _env(*extra):
    env = dict(os.environ)
    env["PATH"] = env.get("PATH", "") + os.pathsep + "/usr/bin"
    for k, v in extra:
        env[k] = v
    return env


# ── backend supervisor ────────────────────────────────────────────────────────
class BackendSupervisor:
    """Spawn gui-server.js --instance, parse the handshake, health-poll, restart.

    If an instance is already alive (another window / a plain ./start-command-center.sh)
    the supervisor ATTACHES to it instead of spawning a second backend over the same PTYs.
    """

    def __init__(self, read_only=False, keep_server=False):
        self.read_only = read_only
        self.keep_server = keep_server
        self.proc = None
        self.url = None
        self.port = None
        self.owned = False
        self.restarts = []
        self._lock = threading.Lock()

    def _cc_instance_url(self):
        try:
            r = subprocess.run(["node", os.path.join(TOOLS, "cc-instance.js"), "url"],
                               cwd=WS, capture_output=True, text=True, timeout=10)
            if r.returncode == 0 and r.stdout.strip():
                return r.stdout.strip()
        except (OSError, subprocess.SubprocessError):
            pass
        return None

    def start(self):
        with self._lock:
            existing = self._cc_instance_url()
            if existing:
                self.url = existing
                self.owned = False
                log("attach to live instance: %s" % existing)
                return self.url
            env = _env(("SCC_READ_ONLY", "1" if self.read_only else "0"))
            args = ["node", os.path.join(TOOLS, "gui-server.js"), "--instance", "--print-port", "--token", "auto"]
            self.proc = subprocess.Popen(args, cwd=WS, env=env, stdout=subprocess.PIPE,
                                         stderr=subprocess.STDOUT, text=True, bufsize=1)
            self.owned = True
            deadline = time.time() + 15
            for line in self.proc.stdout:
                log("backend: " + line.rstrip())
                if line.startswith("SCC_URL="):
                    self.url = line.strip().split("=", 1)[1]
                if line.startswith("SCC_PORT="):
                    try:
                        self.port = int(line.strip().split("=", 1)[1])
                    except ValueError:
                        pass
                if self.url and self.port:
                    return self.url
                if time.time() > deadline:
                    break
            raise RuntimeError("backend did not print SCC_URL within 15s")

    def healthy(self):
        if not self.url:
            return False
        base = self.url.split("?")[0].rstrip("/")
        try:
            with urllib.request.urlopen(base + "/api/health", timeout=3) as r:
                return r.status == 200
        except Exception:
            return False

    def ensure_alive(self):
        """Restart with a circuit breaker when the owned backend died unexpectedly."""
        if not self.owned or self.proc is None:
            return
        if self.proc.poll() is None:
            return
        now = time.time()
        self.restarts = [t for t in self.restarts if now - t < 60]
        if len(self.restarts) >= 5:
            log("backend crash loop — auto-restart suspended (5 restarts in 60s)")
            return
        self.restarts.append(now)
        log("backend exited (code %s) — restarting" % self.proc.returncode)
        try:
            self.start()
        except Exception as e:  # noqa: BLE001
            log("restart failed: %s" % e)

    def stop(self, force=False):
        if not self.owned or self.proc is None:
            return
        if self.keep_server and not force:
            log("leaving backend running (--keep-server)")
            return
        try:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        except OSError:
            pass


# ── single instance ───────────────────────────────────────────────────────────
def acquire_single_instance():
    """Return a QLocalServer we own, 'existing' when another window is already up, or None
    when PyQt6 is unavailable (caller falls back)."""
    try:
        from PyQt6.QtNetwork import QLocalServer, QLocalSocket
    except ImportError:
        return None
    sock = QLocalSocket()
    sock.connectToServer(SERVER_NAME)
    if sock.waitForConnected(200):
        sock.write(b"raise\n")
        sock.flush()
        sock.waitForBytesWritten(200)
        return "existing"
    try:
        QLocalServer.removeServer(SERVER_NAME)
    except Exception:  # noqa: BLE001
        pass
    server = QLocalServer()
    if not server.listen(SERVER_NAME):
        return None
    return server


def fallback_browser(url):
    """No PyQt6 → Chromium app-mode, then the default browser. Returns a process or None."""
    chromium = shutil.which("chromium") or shutil.which("chromium-browser") or shutil.which("google-chrome")
    if chromium:
        try:
            return subprocess.Popen([chromium, "--app=" + url, "--class=StavrosCC"])
        except OSError:
            pass
    import webbrowser
    webbrowser.open(url)
    return None


def _resolve_url_for_web(sup):
    if sup.url:
        return sup.url
    return sup.start()


def main(argv):
    read_only = "--read-only" in argv
    headless = "--headless" in argv
    web = "--web" in argv
    kiosk = "--kiosk" in argv
    keep_server = "--keep-server" in argv

    sup = BackendSupervisor(read_only=read_only, keep_server=keep_server)
    try:
        url = sup.start()
    except Exception as e:  # noqa: BLE001
        log("FATAL: cannot start backend: %s" % e)
        return 1

    if web:
        # The browser is the only UI: leave the backend running (or the page would 404).
        fallback_browser(url)
        return 0
    if headless:
        log("headless: backend at %s — Ctrl-C to stop" % url)
        try:
            while True:
                time.sleep(2)
                sup.ensure_alive()
        except KeyboardInterrupt:
            pass
        sup.stop()
        return 0

    try:
        from PyQt6.QtWidgets import (QApplication, QMainWindow, QToolBar, QLabel, QStatusBar,
                                     QSystemTrayIcon, QMenu, QMessageBox, QWidget)
        from PyQt6.QtGui import QIcon, QAction, QPixmap, QColor, QPainter
        from PyQt6.QtCore import QTimer, QSize, QUrl, QSettings
        from PyQt6.QtWebEngineWidgets import QWebEngineView
    except ImportError as e:  # noqa: BLE001
        log("PyQt6 unavailable (%s) — falling back to Chromium/browser" % e)
        fallback_browser(url)  # browser is now the UI: keep the backend alive
        return 0

    app = QApplication(sys.argv)
    app.setApplicationName("Stavros Command Center")
    app.setOrganizationName("StavrosRedTeamer")

    single = acquire_single_instance()
    if single == "existing":
        log("another window is already running — raising it and exiting")
        return 0

    icon_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "icons", "stavros-cc.svg")

    def status_pixmap(color):
        pm = QPixmap(16, 16)
        pm.fill(QColor(0, 0, 0, 0))
        p = QPainter(pm)
        p.setBrush(QColor(color))
        p.setPen(QColor(color))
        p.drawEllipse(2, 2, 11, 11)
        p.end()
        return QIcon(pm)

    class MainWindow(QMainWindow):
        def __init__(self):
            super().__init__()
            self.setWindowTitle("Stavros Command Center")
            if os.path.exists(icon_path):
                self.setWindowIcon(QIcon(icon_path))
            self.view = QWebEngineView(self)
            self.view.load(QUrl(url))
            self.setCentralWidget(self.view)
            self._build_menu()
            self._build_toolbar()
            self.setStatusBar(QStatusBar(self))
            self._build_tray(status_pixmap("#2fd18a"))
            settings = QSettings("StavrosRedTeamer", APP_NAME)
            geo = settings.value("geometry")
            if geo is not None:
                self.restoreGeometry(geo)
            else:
                self.resize(1440, 900)
            if kiosk:
                self.showFullScreen()
            self._timer = QTimer(self)
            self._timer.timeout.connect(self._tick)
            self._timer.start(5000)

        def _build_menu(self):
            m = self.menuBar()
            f = m.addMenu("&File")
            f.addAction("Refresh", self.view.reload)
            f.addAction("Quit", self.close)
            e = m.addMenu("&Engagement")
            e.addAction("Backend URL", self._show_url)
            v = m.addMenu("&View")
            v.addAction("Fullscreen", lambda: self.showFullScreen())
            v.addAction("Exit fullscreen", lambda: self.showNormal())
            a = m.addMenu("&Actions")
            a.addAction("Panic (stop owned processes)", self._panic)
            h = m.addMenu("&Help")
            h.addAction("About", self._about)

        def _build_toolbar(self):
            tb = QToolBar("main", self)
            tb.setIconSize(QSize(16, 16))
            self.addToolBar(tb)
            self.chip = QLabel("● starting")
            tb.addWidget(self.chip)
            tb.addAction("Refresh", self.view.reload)
            if not read_only:
                tb.addAction("Mission", lambda: self.view.setUrl(QUrl(url.split("?")[0])))
            tb.addAction("Panic", self._panic)

        def _build_tray(self, icon):
            self.tray = QSystemTrayIcon(icon, self)
            self.tray.setToolTip("Stavros Command Center")
            menu = QMenu()
            menu.addAction("Show", self.showNormal)
            menu.addAction("Hide", self.hide)
            menu.addAction("Quit", self.close)
            self.tray.setContextMenu(menu)
            self.tray.activated.connect(lambda reason: self.showNormal())
            self.tray.show()

        def _tick(self):
            ok = sup.healthy()
            sup.ensure_alive()
            self.chip.setText("● live" if ok else "● backend down")
            if ok:
                self.tray.setIcon(status_pixmap("#2fd18a"))
            else:
                self.tray.setIcon(status_pixmap("#ff5c7a"))

        def _show_url(self):
            QMessageBox.information(self, "Backend", url)

        def _about(self):
            QMessageBox.about(self, "Stavros Command Center",
                              "Desktop shell for StavrosRedTeamer.\nBackend: %s" % url)

        def _panic(self):
            if QMessageBox.question(self, "Panic switch",
                                    "Stop every process owned by the harness (jobs, PTY)?") != QMessageBox.StandardButton.Yes:
                return
            try:
                subprocess.run(["node", os.path.join(TOOLS, "cc-panic.js")], cwd=WS, timeout=20)
            except Exception as e:  # noqa: BLE001
                log("panic failed: %s" % e)

        def closeEvent(self, event):
            settings = QSettings("StavrosRedTeamer", APP_NAME)
            settings.setValue("geometry", self.saveGeometry())
            sup.stop()
            event.accept()

    win = MainWindow()
    win.show()
    rc = app.exec()
    sup.stop()
    return rc


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
