"""Exercise a real CUA desktop against an offline, disposable browser fixture."""
import argparse
import json
from pathlib import Path
from queue import Queue
import subprocess
from threading import Thread
import time
import uuid

FIXTURE = Path(__file__).with_name('fixture.py').read_text()


class Driver:
    def __init__(self, name):
        self.process = subprocess.Popen(
            ["docker", "exec", "-i", name, "cua-driver", "mcp",
             "--socket", "/tmp/dsbot-runtime/cua.sock"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, text=True,
        )
        self.messages = Queue()
        self.sequence = 0
        Thread(target=self.read, daemon=True).start()
        self.request("initialize", {
            "protocolVersion": "2024-11-05", "capabilities": {},
            "clientInfo": {"name": "ds-bot-guest-smoke", "version": "1"},
        })
        self.send({"jsonrpc": "2.0", "method": "notifications/initialized"})

    def read(self):
        for line in self.process.stdout:
            self.messages.put(json.loads(line))
        self.messages.put(None)

    def send(self, message):
        self.process.stdin.write(json.dumps(message) + "\n")
        self.process.stdin.flush()

    def request(self, method, params):
        self.sequence += 1
        request_id = self.sequence
        self.send({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
        while True:
            message = self.messages.get(timeout=30)
            if message is None:
                raise RuntimeError("CUA MCP transport closed")
            if message.get("id") != request_id:
                continue
            if "error" in message:
                raise RuntimeError("CUA MCP request failed: " + str(message["error"])[:500])
            return message["result"]

    def call(self, tool, parameters):
        result = self.request("tools/call", {"name": tool, "arguments": parameters})
        if result.get("isError"):
            raise RuntimeError("CUA tool refused: " + str(result.get("content"))[:700])
        if isinstance(result.get("structuredContent"), dict):
            return result["structuredContent"]
        for item in result.get("content", []):
            if item.get("type") == "text":
                try:
                    return json.loads(item["text"])
                except json.JSONDecodeError:
                    continue
        raise RuntimeError("CUA returned no structured result")

    def close(self):
        self.process.stdin.close()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", default="ds-bot-cua-probe:0.37.0")
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    name = "dsbot-cua-smoke-" + uuid.uuid4().hex[:12]
    report = {"image": args.image, "driver": "0.37.0", "checks": []}

    def docker(*command, input=None, check=True, timeout=30):
        result = subprocess.run(
            ["docker", *command], input=input, capture_output=True,
            text=True, timeout=timeout,
        )
        if check and result.returncode:
            raise RuntimeError(f"Docker operation failed: {result.stderr[:500]}")
        return result

    def guest(*command, **kwargs):
        return docker("exec", name, *command, **kwargs)

    def wait_until(check, seconds=45):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            if check():
                return
            time.sleep(0.5)
        raise RuntimeError("Guest smoke condition timed out")

    docker(
        "run", "-d", "--rm", "--name", name, "--label", "org.ds-bot.test=cua-smoke",
        "--network", "none", "--init", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges", "--memory", "4g", "--cpus", "2",
        "--pids-limit", "512", "--shm-size", "256m", args.image,
    )
    driver = None
    try:
        wait_until(lambda: guest(
            "cua-driver", "status", "--socket", "/tmp/dsbot-runtime/cua.sock", check=False,
        ).returncode == 0)
        assert guest("id", "-u").stdout.strip() == "1000"
        assert guest("cua-driver", "--version").stdout.strip() == "cua-driver 0.37.0"
        report["checks"].append("non-root driver ready")
        driver = Driver(name)
        call = driver.call
        docker("exec", "-i", name, "python3", "-c",
               "import sys;from pathlib import Path;Path('/tmp/fixture.py').write_text(sys.stdin.read())",
               input=FIXTURE)
        docker("exec", "-d", name, "python3", "/tmp/fixture.py")
        guest("mkdir", "-p", "/tmp/dsbot-firefox")
        guest("python3", "-c", "from pathlib import Path;Path('/tmp/dsbot-firefox/user.js').write_text("
              """'user_pref("browser.shell.checkDefaultBrowser", false);\\n'
              'user_pref("browser.startup.homepage_override.mstone", "ignore");\\n'
              'user_pref("browser.aboutwelcome.enabled", false);\\n')""")
        docker("exec", "-d", name, "firefox", "--kiosk", "--no-remote", "--profile",
               "/tmp/dsbot-firefox", "http://127.0.0.1:8765/")
        wait_until(lambda: "DS Bot CUA fixture" in json.dumps(call("list_windows", {})))
        desktop = call("get_desktop_state", {"screenshot_out_file": "/tmp/dsbot-desktop.png"})
        dimensions = json.loads(guest("python3", "-c",
            "import struct,json;from pathlib import Path;b=Path('/tmp/dsbot-desktop.png').read_bytes();"
            "assert b[:8]==bytes.fromhex('89504e470d0a1a0a');"
            "print(json.dumps(struct.unpack('>II',b[16:24])))").stdout)
        assert dimensions == [1280, 800]
        report["checks"].append("real 1280x800 PNG captured")
        # Kiosk mode places the fixture at the display origin. This checks actual
        # input transport and its independent HTTP effect, not model perception.
        report["desktopFields"] = sorted(desktop.keys())
        report["checks"].append("desktop capture metadata returned")
        clicked = call("click", {
            "scope": "desktop", "x": 100, "y": 72, "capture_id": desktop["capture_id"],
        })
        report["clickFields"] = sorted(clicked.keys())
        report["clickEffect"] = clicked.get("effect")
        wait_until(lambda: guest("test", "-f", "/tmp/dsbot-fixture-marker", check=False).returncode == 0, seconds=10)
        assert guest("cat", "/tmp/dsbot-fixture-marker").stdout == "1"
        report["checks"].append("CUA click produced exactly one independent HTTP marker")
        print(json.dumps(report, indent=2))
        if args.report:
            args.report.write_text(json.dumps(report, indent=2) + "\n")
    finally:
        if driver:
            driver.close()
        docker("rm", "-f", name, check=False)


if __name__ == "__main__":
    main()
