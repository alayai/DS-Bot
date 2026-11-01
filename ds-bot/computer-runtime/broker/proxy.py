"""A bounded explicit HTTP proxy. No host mounts, credentials, or privileged networking."""
import ipaddress
import json
import select
import socket
import socketserver
import sys
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlsplit


def public_addresses(host, port, allowed, resolver=socket.getaddrinfo):
    host = host.lower()
    if host not in allowed: raise ValueError('Domain is not allowed.')
    values = resolver(host, port, type=socket.SOCK_STREAM)
    if not values or any(not ipaddress.ip_address(value[4][0]).is_global for value in values):
        raise ValueError('Non-public destination.')
    # Connect to the checked address, never resolve the hostname a second time.
    return values


class Proxy(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.0'
    timeout = 30
    def log_message(self, *_args): pass
    def upstream(self, host, port):
        values = public_addresses(host, port, self.server.allowed)
        for family, kind, proto, _, address in values:
            peer = socket.socket(family, kind, proto); peer.settimeout(15)
            try: peer.connect(address); return peer
            except OSError: peer.close()
        raise ValueError('Destination unavailable.')
    def do_CONNECT(self):
        try:
            host, port = self.path.rsplit(':', 1)
            if port != '443' or ':' in host: raise ValueError('Only HTTPS port 443 is allowed.')
            with self.upstream(host, 443) as peer:
                self.send_response(200); self.end_headers(); self.wfile.flush()
                # Unbuffered rfile preserves TLS bytes pipelined after CONNECT.
                while True:
                    ready, _, _ = select.select([self.connection, peer], [], [], 30)
                    if not ready: return
                    for source in ready:
                        data = source.recv(65536)
                        if not data: return
                        (peer if source is self.connection else self.connection).sendall(data)
        except (ValueError, OSError):
            self.close_connection = True
    def forward(self):
        try:
            url = urlsplit(self.path)
            if url.scheme != 'http' or url.username or url.password or not url.hostname or url.port not in (None, 80): raise ValueError('Invalid HTTP destination.')
            if self.headers.get('Transfer-Encoding') or len(self.headers.get_all('Content-Length', [])) > 1: raise ValueError('Unsupported request framing.')
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 <= length <= 8 * 1024 * 1024: raise ValueError('Request too large.')
            with self.upstream(url.hostname, 80) as peer:
                path = url.path or '/'
                if url.query: path += '?' + url.query
                if '\r' in path or '\n' in path: raise ValueError('Invalid request.')
                headers = [f'{self.command} {path} HTTP/1.0', f'Host: {url.hostname}', 'Connection: close']
                for key, value in self.headers.items():
                    if key.lower() not in ('host', 'connection', 'proxy-authorization', 'proxy-connection', 'upgrade'):
                        if '\r' in value or '\n' in value: raise ValueError('Invalid header.')
                        headers.append(f'{key}: {value}')
                peer.sendall(('\r\n'.join(headers) + '\r\n\r\n').encode('latin1'))
                while length:
                    data = self.rfile.read(min(length, 65536))
                    if not data: raise ValueError('Incomplete request.')
                    peer.sendall(data); length -= len(data)
                while data := peer.recv(65536): self.wfile.write(data)
        except (ValueError, OSError):
            self.close_connection = True
    do_GET = do_HEAD = do_POST = do_PUT = do_DELETE = do_OPTIONS = do_PATCH = forward
    rbufsize = 0


class Server(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True
    request_queue_size = 32
    def process_request(self, request, address):
        if not self.slots.acquire(blocking=False): request.close(); return
        try: super().process_request(request, address)
        except BaseException: self.slots.release(); raise
    def process_request_thread(self, request, address):
        try: super().process_request_thread(request, address)
        finally: self.slots.release()


if __name__ == '__main__':
    import threading
    options = json.loads(sys.argv[1])
    with Server((options['bind'], 3128), Proxy) as server:
        server.allowed = frozenset(options['domains'])
        server.slots = threading.BoundedSemaphore(32)
        server.serve_forever()
