import base64
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('transfer', Path(__file__).parents[1] / 'broker/files.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class Files(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name)
        self.root = os.open(self.path, module.FLAGS)
    def tearDown(self):
        os.close(self.root)
        self.temp.cleanup()
    def call(self, operation, **kw):
        return module.transfer(dict(operation=operation, **kw), self.root)
    def test_round_trip_and_no_overwrite(self):
        data = base64.b64encode(bytes(range(256))).decode()
        self.call('write', name='original.bin', data=data)
        self.assertEqual(self.call('read', name='original.bin')['data'], data)
        self.assertEqual(self.call('list')['files'][0]['bytes'], 256)
        with self.assertRaises(FileExistsError):
            self.call('write', name='original.bin', data='')
        self.assertEqual(list(self.path.iterdir()), [self.path / 'original.bin'])
    def test_paths_symlinks_hardlinks_and_devices(self):
        for name in ('../escape', '/tmp/escape', '.hidden', 'dir/file', 'dir\\file', 'bad\0name'):
            with self.assertRaises(ValueError): self.call('read', name=name)
        (self.path / 'link').symlink_to('/etc/hostname')
        with self.assertRaises(OSError): self.call('read', name='link')
        self.call('write', name='original', data='YQ==')
        os.link(self.path / 'original', self.path / 'alias')
        with self.assertRaises(ValueError): self.call('read', name='alias')
        os.mkfifo(self.path / 'fifo')
        with self.assertRaises(ValueError): self.call('read', name='fifo')
        (self.path / 'folder').symlink_to(self.path, target_is_directory=True)
        with self.assertRaises(OSError): module.directory(self.root, 'folder', create=True)
    def test_limit(self):
        self.call('write', name='limit', data=base64.b64encode(b'x' * module.LIMIT).decode())
        self.assertEqual(self.call('read', name='limit')['bytes'], module.LIMIT)
        with self.assertRaises(ValueError):
            self.call('write', name='big', data=base64.b64encode(b'x' * (module.LIMIT + 1)).decode())

if __name__ == '__main__': unittest.main()
