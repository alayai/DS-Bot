from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
class Fixture(BaseHTTPRequestHandler):
    def log_message(self, *_args): pass
    def do_GET(self):
        Path("/tmp/dsbot-fixture-ready").write_text("ready")
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.end_headers()
        self.wfile.write(b"""<!doctype html><title>DS Bot CUA fixture</title>
        <style>body{margin:0;background:#fff;height:3000px}button{position:fixed;left:32px;top:32px;width:160px;height:80px}
        input{position:absolute;left:32px;top:150px;width:300px;height:50px;caret-color:transparent}</style>
        <button onclick="fetch('/done',{method:'POST'}).then(()=>this.textContent='Complete')">Run fixture</button>
        <input aria-label="Fixture input" oninput="fetch('/text',{method:'POST',body:this.value})"
          onkeydown="if(event.key==='Enter'){fetch('/key',{method:'POST',body:this.value});event.preventDefault()}">
        <script>onscroll=()=>fetch('/scroll',{method:'POST',body:String(scrollY)})</script>""")
    def do_POST(self):
        if self.path not in ["/done", "/text", "/key", "/scroll"]:
            self.send_error(404)
            return
        if self.path == "/done":
            marker = Path("/tmp/dsbot-fixture-marker")
            marker.write_text(str(int(marker.read_text()) + 1 if marker.exists() else 1))
        else:
            size = min(int(self.headers.get("Content-Length", "0")), 4096)
            Path("/tmp/dsbot-fixture-" + self.path[1:]).write_bytes(self.rfile.read(size))
        self.send_response(204)
        self.end_headers()
HTTPServer(("127.0.0.1", 8765), Fixture).serve_forever()
