#!/usr/bin/env python3
# WP6 helper — render a local report HTML to PDF with QtWebEngine's printToPdf.
# Usage: python3 tools/app/pdf-export.py <in.html> <out.pdf>
# Exits non-zero (with a message on stderr) when PyQt6/WebEngine is unavailable.
import sys
import os


def main(argv):
    if len(argv) < 2:
        sys.stderr.write("usage: pdf-export.py <in.html> <out.pdf>\n")
        return 2
    src, out = os.path.abspath(argv[0]), os.path.abspath(argv[1])
    try:
        from PyQt6.QtCore import QUrl, QEventLoop, QTimer
        from PyQt6.QtWidgets import QApplication
        from PyQt6.QtWebEngineWidgets import QWebEngineView
    except ImportError as e:  # noqa: BLE001
        sys.stderr.write("PyQt6 QtWebEngine not available: %s\n" % e)
        return 3

    app = QApplication(sys.argv)
    view = QWebEngineView()
    loop = QEventLoop()
    state = {"ok": False}

    def on_pdf(data):
        try:
            with open(out, "wb") as fh:
                fh.write(bytes(data))
            state["ok"] = True
        except OSError as e:  # noqa: BLE001
            sys.stderr.write("write failed: %s\n" % e)
        loop.quit()

    def on_load(ok):
        if not ok:
            sys.stderr.write("failed to load %s\n" % src)
            loop.quit()
            return
        view.page().printToPdf(on_pdf)
        QTimer.singleShot(15000, loop.quit)

    view.loadFinished.connect(on_load)
    view.load(QUrl.fromLocalFile(src))
    loop.exec()
    return 0 if state["ok"] else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
