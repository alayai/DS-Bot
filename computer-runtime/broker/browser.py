"""Bounded JSON-lines facade for the visible guest Firefox; no caller scripts."""
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
import uuid
from urllib.parse import urlsplit

ELEMENT = "element-6066-11e4-a52e-4f735466cecf"
SNAPSHOT = r"""
const visible = e => {
 const r=e.getBoundingClientRect(), s=getComputedStyle(e);
 return r.width>0 && r.height>0 && s.visibility!=='hidden' && s.display!=='none';
};
const all=Array.from(document.querySelectorAll('a[href],button,input,textarea,select,[role="button"],[role="link"]')).filter(visible);
const nodes=all.slice(0,160);
return {url:location.href,title:document.title.slice(0,200),visible:document.visibilityState==='visible',
 text:(document.body?.innerText||'').slice(0,18000),truncated:all.length>160,
 elements:nodes.map((e,i)=>({ref:String(i+1),tag:e.tagName.toLowerCase(),type:e.type||'',
 name:(e.getAttribute('aria-label')||Array.from(e.labels||[]).map(l=>l.innerText).join(' ')||e.innerText||e.getAttribute('placeholder')||'').slice(0,200),
 disabled:!!e.disabled,readonly:!!e.readOnly})),nodes,
 state:nodes.map(e=>({href:e.href||'',action:e.form?.action||'',target:e.target||'',
 value:['password','file'].includes(e.type)?null:String(e.value||'').slice(0,4001),
 checked:!!e.checked,selectedIndex:e.selectedIndex??null}))};
"""


class Refused(Exception):
    pass


class Browser:
    def __init__(self, restricted=False):
        self.restricted = restricted
        self.sock = None
        self.seq = 0
        self.snapshot = None

    def receive(self):
        prefix = b""
        while not prefix.endswith(b":"):
            byte = self.sock.recv(1)
            if not byte or len(prefix) > 10:
                raise RuntimeError("Browser protocol disconnected.")
            prefix += byte
        length = int(prefix[:-1])
        if not 0 < length <= 1024 * 1024:
            raise RuntimeError("Browser response exceeded its limit.")
        body = b""
        while len(body) < length:
            block = self.sock.recv(length - len(body))
            if not block:
                raise RuntimeError("Browser protocol disconnected.")
            body += block
        return json.loads(body)

    def command(self, name, args=None):
        self.seq += 1
        message = json.dumps([0, self.seq, name, args or {}]).encode()
        self.sock.sendall(str(len(message)).encode() + b":" + message)
        reply = self.receive()
        if not isinstance(reply, list) or len(reply) != 4 or reply[:2] != [1, self.seq]:
            raise RuntimeError("Invalid browser response.")
        if reply[2]:
            # Protocol messages can contain page contents or typed values.
            raise RuntimeError("Browser command failed. Observe before continuing.")
        result = reply[3]
        return result.get("value") if isinstance(result, dict) and set(result) == {"value"} else result

    def connect(self, launch=False):
        if self.sock:
            return
        try:
            self.sock = socket.create_connection(("127.0.0.1", 2828), timeout=8)
        except OSError:
            if not launch:
                raise Refused("Use computer_browser_act with open after a desktop observation to open Firefox with semantic access.")
            for path in Path("/proc").glob("[0-9]*/comm"):
                try:
                    if path.read_text().strip() in ("firefox", "firefox-esr"):
                        raise Refused("Firefox is already running without semantic access. Ask the user to close Firefox, then open it again with computer_browser_act. Its profile is retained.")
                except (OSError, UnicodeError):
                    pass
            args = ["firefox", "--marionette", "--no-remote"]
            if self.restricted:
                args += ["--profile", "/home/cua/.dsbot-restricted-browser"]
            child = subprocess.Popen(args + ["about:blank"], stdin=subprocess.DEVNULL,
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                     start_new_session=True)
            for _ in range(80):
                if child.poll() is not None:
                    raise RuntimeError("The visible Firefox could not start.")
                try:
                    self.sock = socket.create_connection(("127.0.0.1", 2828), timeout=1)
                    break
                except OSError:
                    time.sleep(0.1)
            if not self.sock:
                raise RuntimeError("Firefox startup is unconfirmed. Check the desktop.")
        self.sock.settimeout(10)
        greeting = self.receive()
        if greeting.get("marionetteProtocol") != 3:
            raise RuntimeError("Unsupported Firefox protocol.")
        self.command("WebDriver:NewSession", {"capabilities": {"alwaysMatch": {
            "acceptInsecureCerts": False, "pageLoadStrategy": "eager",
            "timeouts": {"implicit": 0, "pageLoad": 10000, "script": 5000},
        }}})

    def script(self, script):
        return self.command("WebDriver:ExecuteScript", {"script": script, "args": [], "newSandbox": True, "sandbox": "dsbot"})

    def capture(self, follow_visible=False):
        tabs = self.command("WebDriver:GetWindowHandles")
        if len(tabs) > 100:
            raise Refused("Close unused browser tabs before continuing.")
        if follow_visible:
            # Switch protocol context without selecting/focusing a tab. Firefox
            # can select a new tab while Marionette still targets the old one.
            visible = []
            for tab in tabs:
                self.command("WebDriver:SwitchToWindow", {"handle": tab, "focus": False})
                state = self.script("return {visible:document.visibilityState==='visible',focused:document.hasFocus()};")
                if state["visible"]:
                    visible.append((tab, state["focused"]))
            focused = [tab for tab, active in visible if active]
            selected = focused if len(focused) == 1 else [tab for tab, _ in visible]
            if len(selected) != 1:
                raise Refused("Select one visible Firefox window and observe again.")
            self.command("WebDriver:SwitchToWindow", {"handle": selected[0], "focus": False})
        value = self.script(SNAPSHOT)
        if not value.get("visible"):
            raise Refused("The observed Firefox tab is not visible. Return to it on the desktop and observe again.")
        value["tab"] = self.command("WebDriver:GetWindowHandle")
        value["tabs"] = tabs
        return value

    def observe(self):
        self.connect()
        value = self.capture(follow_visible=True)
        token = str(uuid.uuid4())
        self.snapshot = {"token": token, "value": value}
        return {**{k: v for k, v in value.items() if k not in ("nodes", "state")}, "token": token}

    def perform(self, request):
        action = request.get("action", {})
        kind = action.get("type")
        if kind not in ("open", "click", "fill", "back", "switch"):
            raise Refused("Unsupported browser action.")
        allowed = {"open": {"type", "url"}, "click": {"type", "ref"}, "fill": {"type", "ref", "text"},
                   "back": {"type"}, "switch": {"type", "tab"}}[kind]
        if set(action) != allowed:
            raise Refused("Invalid browser action fields.")
        if kind == "open":
            url = action["url"]
            if not isinstance(url, str) or len(url) > 2000:
                raise Refused("Use a bounded HTTP or HTTPS URL.")
            parsed = urlsplit(url)
            if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password:
                raise Refused("Use an HTTP or HTTPS URL without embedded credentials.")
            self.connect(launch=True)
            self.snapshot = None
            self.capture(follow_visible=True)
            self.command("WebDriver:Navigate", {"url": url})
        else:
            previous, self.snapshot = self.snapshot, None
            if not previous or previous["token"] != request.get("token"):
                raise Refused("Browser references expired. Observe again.")
            current = self.capture()
            if current != previous["value"]:
                raise Refused("The page or tab changed. Observe again before acting.")
            if kind == "back":
                self.command("WebDriver:Back")
            elif kind == "switch":
                if action["tab"] not in current["tabs"]:
                    raise Refused("Unknown observed tab.")
                self.command("WebDriver:SwitchToWindow", {"handle": action["tab"], "focus": True})
            else:
                ref = action.get("ref")
                if not isinstance(ref, str) or not ref.isdigit() or not 1 <= int(ref) <= len(current["nodes"]):
                    raise Refused("Unknown observed element.")
                element = current["nodes"][int(ref) - 1]
                info = current["elements"][int(ref) - 1]
                if info["disabled"] or info["type"] in ("password", "file"):
                    raise Refused("This element requires human control.")
                if kind == "click":
                    self.command("WebDriver:ElementClick", {"id": element[ELEMENT]})
                else:
                    text = action["text"]
                    if not isinstance(text, str) or len(text) > 4000 or "\0" in text:
                        raise Refused("Use at most 4000 text characters.")
                    if info["readonly"] or info["tag"] not in ("input", "textarea") or info["type"] in ("hidden", "checkbox", "radio", "submit", "button"):
                        raise Refused("Choose an editable text field.")
                    self.command("WebDriver:ElementClear", {"id": element[ELEMENT]})
                    if text:
                        self.command("WebDriver:ElementSendKeys", {"id": element[ELEMENT], "text": text})
        return {"outcome": "completed", "completedActions": 1}

    def close(self):
        if self.sock:
            try:
                self.command("WebDriver:DeleteSession")
            except Exception:
                pass
            self.sock.close()
        self.sock = None
        self.snapshot = None


def main():
    browser = Browser(restricted=len(sys.argv) > 1 and sys.argv[1] == "restricted")
    try:
        while True:
            line = sys.stdin.buffer.readline(32769)
            if not line:
                break
            if len(line) > 32768:
                break
            try:
                request = json.loads(line)
                if request["method"] == "observe":
                    result = browser.observe()
                elif request["method"] == "perform":
                    result = browser.perform(request)
                else:
                    raise Refused("Unsupported browser request.")
                response = {"ok": True, "value": result}
            except Refused as error:
                response = {"ok": False, "error": str(error), "rejected": True}
            except Exception:
                browser.close()
                response = {"ok": False, "error": "Browser result is unconfirmed. Observe the desktop before continuing.", "rejected": False}
            print(json.dumps(response), flush=True)
    finally:
        browser.close()


if __name__ == "__main__":
    main()
