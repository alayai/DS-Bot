"""Run the test desktop and driver without root or a host-facing VNC listener."""
import os
from pathlib import Path
import signal
import subprocess
import time

runtime = Path(os.environ["XDG_RUNTIME_DIR"])
runtime.mkdir(mode=0o700, exist_ok=True)
os.chmod(runtime, 0o700)
children = []
stopping = False


def stop(_signum, _frame):
    global stopping
    stopping = True


signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
try:
    children.append(subprocess.Popen([
        "Xtigervnc", ":1", "-geometry", "1280x800", "-depth", "24",
        "-SecurityTypes", "None", "-localhost", "yes", "-rfbport", "5901",
        "-nolisten", "tcp",
    ]))
    for _ in range(100):
        if stopping or children[0].poll() is not None:
            raise RuntimeError("The desktop display did not start")
        if Path("/tmp/.X11-unix/X1").exists():
            break
        time.sleep(0.1)
    else:
        raise RuntimeError("The desktop display timed out")
    children.append(subprocess.Popen(["dbus-run-session", "--", "xfce4-session"]))
    children.append(subprocess.Popen([
        "cua-driver", "serve", "--socket", str(runtime / "cua.sock"),
        "--permission-mode", "standard", "--no-overlay",
    ]))
    while not stopping:
        if any(child.poll() is not None for child in children):
            raise RuntimeError("A desktop service exited")
        time.sleep(0.2)
finally:
    for child in reversed(children):
        if child.poll() is None:
            child.terminate()
    for child in children:
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()
