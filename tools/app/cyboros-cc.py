#!/usr/bin/env python3
# Cyboros Command Center — desktop shell (WP2).
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
#   tools/app/cyboros-cc.py [--read-only] [--headless] [--web] [--kiosk] [--keep-server]
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
from types import SimpleNamespace

WS = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TOOLS = os.path.join(WS, "tools")
LOG_DIR = os.path.join(WS, "reports", "app")
LOG_FILE = os.path.join(LOG_DIR, "cyboros-cc.log")
APP_NAME = "cyboros-cc"
SERVER_NAME = "cyboros-cc-single"
_QT_APP = None  # keeps a QApplication created outside main() alive


def log(msg):
    try:
        os.makedirs(LOG_DIR, exist_ok=True)
        line = "%s %s\n" % (time.strftime("%Y-%m-%dT%H:%M:%S"), msg)
        with open(LOG_FILE, "a") as fh:
            fh.write(line)
    except OSError:
        pass
    sys.stderr.write("[cyboros-cc] %s\n" % msg)


def _tooling_path():
    """PATH for the backend AND every job it spawns.

    The shell can be started from a tray/autostart environment whose PATH is the system
    default, which hides tooling installed in the user's own dirs: `~/go/bin` (the
    ProjectDiscovery go tools), `~/.local/bin` (pipx), `/usr/sbin` (wireless/network tools).
    doctor.js resolves binaries through PATH, so a shrunken PATH reports installed tools as
    missing AND makes a dispatched job fail with "not found" — the same PATH is handed to
    tools/run.js. Prepend the usual dirs that actually exist, keep what we inherited.
    """
    parts = [p for p in os.environ.get("PATH", "").split(os.pathsep) if p]
    for d in (os.path.expanduser("~/.local/bin"), os.path.expanduser("~/go/bin"),
              os.path.expanduser("~/bin"), "/usr/local/sbin", "/usr/sbin", "/sbin"):
        if os.path.isdir(d) and d not in parts:
            parts.append(d)
    if "/usr/bin" not in parts:
        parts.append("/usr/bin")
    return os.pathsep.join(parts)


def _env(*extra):
    env = dict(os.environ)
    env["PATH"] = _tooling_path()
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
            # Drain the handshake on a thread: a blocking read would hang forever when the
            # backend prints nothing, and would stop draining the pipe once it is up.
            proc = self.proc
            state = {}
            ready = threading.Event()

            def _read_handshake():
                for line in proc.stdout:
                    log("backend: " + line.rstrip())
                    if line.startswith("SCC_URL="):
                        state["url"] = line.strip().split("=", 1)[1]
                    if line.startswith("SCC_PORT="):
                        try:
                            state["port"] = int(line.strip().split("=", 1)[1])
                        except ValueError:
                            pass
                    if state.get("url") and state.get("port"):
                        ready.set()
                ready.set()

            threading.Thread(target=_read_handshake, daemon=True).start()
            if not ready.wait(15) or not state.get("url"):
                raise RuntimeError("backend did not print SCC_URL within 15s (exit code %s)"
                                   % proc.poll())
            self.url = state["url"]
            self.port = state.get("port")
            return self.url

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
def serve_raise_requests(server, window):
    """Accept single-instance connections and raise `window` when asked.

    A second launch sends "raise" and waits for the "ok" reply; without this handler the
    launcher exits while the first window stays hidden/minimized/on another desktop, so the
    user only sees the launcher spinner disappear.
    """
    from PyQt6.QtWidgets import QApplication

    def on_new_connection():
        while server.hasPendingConnections():
            conn = server.nextPendingConnection()
            conn.disconnected.connect(conn.deleteLater)

            def on_ready(c=conn):
                if b"raise" not in bytes(c.readAll()):
                    return
                log("raise requested by a second launch")
                window.showNormal()
                window.raise_()
                window.activateWindow()
                QApplication.alert(window, 0)  # Wayland may refuse focus: flash the taskbar entry
                c.write(b"ok\n")
                c.flush()
                c.waitForBytesWritten(200)
                c.disconnectFromServer()

            conn.readyRead.connect(on_ready)

    server.newConnection.connect(on_new_connection)


def acquire_single_instance(ack_timeout_ms=1200):
    """Return a QLocalServer we own, 'existing' when another window raised itself, or None
    when PyQt6 is unavailable (caller falls back).

    A socket that accepts the connection but never answers the raise (a hung window, or a
    build that predates the handshake) is not trusted: we take the name over so a window
    always appears instead of the launch dying silently.
    """
    try:
        from PyQt6.QtNetwork import QLocalServer, QLocalSocket
    except ImportError:
        return None
    sock = QLocalSocket()
    sock.connectToServer(SERVER_NAME)  # void in Qt6: never test its return value
    if sock.waitForConnected(200):
        sock.write(b"raise\n")
        sock.flush()
        sock.waitForBytesWritten(200)
        if sock.waitForReadyRead(ack_timeout_ms) and b"ok" in bytes(sock.readAll()):
            sock.abort()
            return "existing"
        log("single-instance peer did not answer the raise — taking over")
    sock.abort()
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
            return subprocess.Popen([chromium, "--app=" + url, "--class=CyborosCC"])
        except OSError:
            pass
    import webbrowser
    webbrowser.open(url)
    return None


def _resolve_url_for_web(sup):
    if sup.url:
        return sup.url
    return sup.start()


def load_qt():
    """Import the Qt shell bindings once. None when PyQt6/WebEngine is missing."""
    try:
        from PyQt6.QtWidgets import (QApplication, QMainWindow, QToolBar, QLabel, QStatusBar,
                                     QSystemTrayIcon, QMenu, QMessageBox)
        from PyQt6.QtGui import QIcon, QPixmap, QColor, QPainter
        from PyQt6.QtCore import QTimer, QSize, QUrl, QSettings
        from PyQt6.QtWebEngineWidgets import QWebEngineView
    except ImportError as e:  # noqa: BLE001
        log("PyQt6 unavailable (%s) — falling back to Chromium/browser" % e)
        return None
    return SimpleNamespace(
        QApplication=QApplication, QMainWindow=QMainWindow, QToolBar=QToolBar, QLabel=QLabel,
        QStatusBar=QStatusBar, QSystemTrayIcon=QSystemTrayIcon, QMenu=QMenu,
        QMessageBox=QMessageBox, QIcon=QIcon, QPixmap=QPixmap, QColor=QColor,
        QPainter=QPainter, QTimer=QTimer, QSize=QSize, QUrl=QUrl, QSettings=QSettings,
        QWebEngineView=QWebEngineView)


def report_startup_failure(message):
    """Launched from the desktop there is no terminal: make the failure visible.

    Without this the launcher icon just disappears again and the operator has no clue.
    """
    log("FATAL: %s" % message)
    sys.stderr.write("[cyboros-cc] %s\n" % message)
    if not (os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")):
        return
    try:
        from PyQt6.QtWidgets import QApplication, QMessageBox
    except ImportError:
        return
    global _QT_APP
    _QT_APP = QApplication.instance() or QApplication(sys.argv)
    QMessageBox.critical(None, "Cyboros Command Center",
                         "%s\n\nBackend: tools/gui-server.js\nLog: %s" % (message, LOG_FILE))


def main(argv):
    read_only = "--read-only" in argv
    headless = "--headless" in argv
    web = "--web" in argv
    kiosk = "--kiosk" in argv
    keep_server = "--keep-server" in argv

    # Qt shell path. The single instance is claimed BEFORE anything is spawned: a second
    # launch must raise the existing window and touch nothing else — no redundant backend,
    # no second window, and above all no silent exit while the launcher spinner disappears.
    qt = None if (web or headless) else load_qt()
    single = None
    app = None
    if qt is not None:
        app = qt.QApplication(sys.argv)
        app.setApplicationName("Cyboros Command Center")
        app.setOrganizationName("Cyboros Harness")
        single = acquire_single_instance()
        if single == "existing":
            log("another window is already running — raising it and exiting")
            return 0

    sup = BackendSupervisor(read_only=read_only, keep_server=keep_server)
    try:
        url = sup.start()
    except Exception as e:  # noqa: BLE001
        if headless or web:
            log("FATAL: cannot start backend: %s" % e)
            return 1
        report_startup_failure("cannot start the backend: %s" % e)
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

    if qt is None:
        fallback_browser(url)  # browser is now the UI: keep the backend alive
        return 0

    QMainWindow, QToolBar, QLabel, QStatusBar = qt.QMainWindow, qt.QToolBar, qt.QLabel, qt.QStatusBar
    QSystemTrayIcon, QMenu, QMessageBox = qt.QSystemTrayIcon, qt.QMenu, qt.QMessageBox
    QIcon, QPixmap, QColor, QPainter = qt.QIcon, qt.QPixmap, qt.QColor, qt.QPainter
    QTimer, QSize, QUrl, QSettings = qt.QTimer, qt.QSize, qt.QUrl, qt.QSettings
    QWebEngineView = qt.QWebEngineView

    icon_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "icons", "cyboros-cc.svg")

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
            self.setWindowTitle("Cyboros Command Center")
            if os.path.exists(icon_path):
                self.setWindowIcon(QIcon(icon_path))
            self.view = QWebEngineView(self)
            self.view.load(QUrl(url))
            self.setCentralWidget(self.view)
            self._build_menu()
            self._build_toolbar()
            self.setStatusBar(QStatusBar(self))
            self._build_tray(status_pixmap("#2fd18a"))
            settings = QSettings("Cyboros Harness", APP_NAME)
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
            self.tray.setToolTip("Cyboros Command Center")
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
            QMessageBox.about(self, "Cyboros Command Center",
                              "Desktop shell for Cyboros Harness.\nBackend: %s" % url)

        def _panic(self):
            if QMessageBox.question(self, "Panic switch",
                                    "Stop every process owned by the harness (jobs, PTY)?") != QMessageBox.StandardButton.Yes:
                return
            try:
                subprocess.run(["node", os.path.join(TOOLS, "cc-panic.js")], cwd=WS, timeout=20)
            except Exception as e:  # noqa: BLE001
                log("panic failed: %s" % e)

        def closeEvent(self, event):
            settings = QSettings("Cyboros Harness", APP_NAME)
            settings.setValue("geometry", self.saveGeometry())
            sup.stop()
            event.accept()

    win = MainWindow()
    if single is not None and single != "existing":
        serve_raise_requests(single, win)
    win.show()
    win.raise_()
    win.activateWindow()
    rc = app.exec()
    sup.stop()
    return rc


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
