import importlib.util
import io
import json
import tempfile
import unittest
from pathlib import Path


def module(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).parents[1] / 'broker' / (name + '.py'))
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value); return value
p = module('portable'); proxy = module('proxy')
IMAGE = 'sha256:' + 'a' * 64

class PortableTests(unittest.TestCase):
    def test_roundtrip(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'in'; root.mkdir(); target = Path(tmp) / 'out'; target.mkdir()
            (root / '文档').mkdir(); (root / '文档' / 'data').write_bytes(bytes(range(256)) * 10000)
            (root / 'link').symlink_to('文档/data'); (target / 'seed').write_text('seed')
            stream = io.BytesIO(); p.export_home(root, stream, IMAGE, 10**8); stream.seek(0)
            result = p.import_home(target, stream, IMAGE, 10**8)
            self.assertEqual(result['bytes'], 2560000)
            self.assertEqual((target / 'link').read_bytes(), (root / '文档/data').read_bytes())
            self.assertFalse((target / 'seed').exists())
    def test_invalid_manifests(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); marker = root / 'marker'; marker.write_text('kept')
            for entries in [[{'path': '../escape', 'kind': 'file', 'mode': 420}], [None],
                            [{'path': 'link', 'kind': 'link', 'mode': 511, 'target': '/tmp'}, {'path': 'link/file', 'kind': 'directory', 'mode': 448}],
                            [{'path': 'x', 'kind': 'file', 'mode': 420, 'bytes': 0, 'sha256': 'z'*64}],
                            [{'path': 'dir/../file', 'kind': 'directory', 'mode': 448}]]:
                header = json.dumps({'version': 1, 'image': IMAGE, 'bytes': 0, 'entries': entries}).encode()
                archive = p.MAGIC + ('%08d\n' % len(header)).encode() + header
                with self.assertRaises(ValueError): p.import_home(root, io.BytesIO(archive), IMAGE, 10000)
                self.assertEqual(marker.read_text(), 'kept')
    def test_corruption_truncation_and_image(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'in'; root.mkdir(); target = Path(tmp) / 'out'; target.mkdir()
            (root / 'x').write_bytes(b'abcdefgh'); stream = io.BytesIO(); p.export_home(root, stream, IMAGE, 1000)
            raw = stream.getvalue()
            for data in [raw[:-1], raw[:-1]+b'Z', raw+b'extra']:
                with self.assertRaises(ValueError): p.import_home(target, io.BytesIO(data), IMAGE, 1000)
            with self.assertRaises(ValueError): p.import_home(target, io.BytesIO(raw), 'other-image', 1000)
    def test_proxy_rejects_private_and_unlisted_dns(self):
        resolver = lambda address: lambda *_args, **_kwargs: [(2, 1, 6, '', (address, 443))]
        for address in ['127.0.0.1', '10.0.0.1', '169.254.169.254', '192.168.1.1', '::1', 'fc00::1', '100.64.0.1']:
            with self.assertRaises(ValueError): proxy.public_addresses('example.com', 443, {'example.com'}, resolver(address))
        with self.assertRaises(ValueError): proxy.public_addresses('other.example.com', 443, {'example.com'}, resolver('1.1.1.1'))
        self.assertEqual(proxy.public_addresses('example.com', 443, {'example.com'}, resolver('1.1.1.1'))[0][4][0], '1.1.1.1')

if __name__ == '__main__': unittest.main()
