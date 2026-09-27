#!/usr/bin/env python3
# fbpty.py — minimal PTY bridge (stdlib only, zero deps).
#
# Runs <cmd...> inside a real pseudo-terminal of an EXACT size and relays bytes:
#   fd0 (stdin)  -> pty master   (keystrokes from the browser terminal)
#   pty master   -> fd1 (stdout) (program output, full ANSI, streamed to the UI)
#   fd3 (opt)    -> resize control: lines "R <cols> <rows>\n" re-size the pty
#
# Used by tools/gui-server.js to attach the embedded xterm.js terminal to the
# Freebuff tmux session, so colours, the alternate screen and arrow-key
# navigation all work exactly like a native terminal — without node-pty.
#
#   python3 fbpty.py <cols> <rows> -- tmux attach -t <session>
import os, sys, pty, select, fcntl, termios, struct, signal


def set_winsize(fd, rows, cols):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))


def main():
    if len(sys.argv) < 5 or sys.argv[3] != '--':
        sys.stderr.write('usage: fbpty.py <cols> <rows> -- <cmd> [args...]\n')
        return 2
    cols = max(1, int(sys.argv[1]))
    rows = max(1, int(sys.argv[2]))
    cmd = sys.argv[4:]

    pid, master = pty.fork()
    if pid == 0:
        # Child: stdio (0,1,2) is already wired to the pty slave by pty.fork().
        # Close any inherited extra fds (e.g. the resize-control pipe) before exec.
        for fd in range(3, 64):
            try:
                os.close(fd)
            except OSError:
                pass
        try:
            os.execvp(cmd[0], cmd)
        except OSError as e:
            sys.stderr.write('fbpty: exec failed: %s\n' % e)
        os._exit(127)

    # Parent: size the pty, then relay until the child's pty closes.
    set_winsize(master, rows, cols)
    try:
        os.fstat(3)
        has_ctrl = True
    except OSError:
        has_ctrl = False

    fds = [master, 0] + ([3] if has_ctrl else [])
    cbuf = b''
    try:
        while True:
            try:
                r, _, _ = select.select(fds, [], [])
            except (InterruptedError, OSError):
                continue
            if master in r:
                try:
                    data = os.read(master, 65536)
                except OSError:
                    data = b''
                if not data:
                    break
                try:
                    os.write(1, data)
                except OSError:
                    break
            if 0 in r:
                try:
                    data = os.read(0, 65536)
                except OSError:
                    data = b''
                if not data:
                    fds.remove(0)  # stdin gone; keep streaming output
                else:
                    os.write(master, data)
            if has_ctrl and 3 in r:
                data = os.read(3, 4096)
                if not data:
                    fds.remove(3)
                    has_ctrl = False
                else:
                    cbuf += data
                    while b'\n' in cbuf:
                        line, cbuf = cbuf.split(b'\n', 1)
                        parts = line.split()
                        if len(parts) == 3 and parts[0] == b'R':
                            try:
                                set_winsize(master, int(parts[2]), int(parts[1]))
                                os.kill(pid, signal.SIGWINCH)
                            except Exception:
                                pass
    finally:
        try:
            os.close(master)
        except OSError:
            pass
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass
        try:
            os.waitpid(pid, 0)
        except OSError:
            pass
    return 0


if __name__ == '__main__':
    sys.exit(main())
