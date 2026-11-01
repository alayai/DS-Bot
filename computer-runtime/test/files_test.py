import base64
import importlib.util
import hashlib
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import uuid

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
    def test_chunked_upload_publish_checksum_and_snapshot(self):
        temporary = '.transfer-' + str(uuid.uuid4())
        data = bytes(range(256)) * 2100
        sha256 = hashlib.sha256(data).hexdigest()
        self.call('begin-write', temporary=temporary, name='large.bin', bytes=len(data))
        for offset in range(0, len(data), module.LIMIT):
            self.call('write-chunk', temporary=temporary, offset=offset,
                      data=base64.b64encode(data[offset:offset + module.LIMIT]).decode())
        self.assertFalse((self.path / 'large.bin').exists())
        with self.assertRaises(ValueError):
            self.call('commit', temporary=temporary, name='large.bin', bytes=len(data), sha256='0' * 64)
        self.call('commit', temporary=temporary, name='large.bin', bytes=len(data), sha256=sha256)
        self.call('abort', temporary=temporary)
        snapshot = '.transfer-' + str(uuid.uuid4())
        result = self.call('begin-read', temporary=snapshot, name='large.bin')
        self.assertEqual(result, {'bytes': len(data), 'sha256': sha256})
        (self.path / 'large.bin').write_bytes(b'changed')
        chunks = [base64.b64decode(self.call('read-chunk', temporary=snapshot, offset=offset,
                  length=min(module.LIMIT, len(data) - offset))['data'])
                  for offset in range(0, len(data), module.LIMIT)]
        self.assertEqual(b''.join(chunks), data)
        self.call('abort', temporary=snapshot)
        self.assertEqual(sorted(p.name for p in self.path.iterdir()), ['large.bin'])
    def test_chunked_order_limits_no_overwrite_and_links(self):
        temporary = '.transfer-' + str(uuid.uuid4())
        self.call('begin-write', temporary=temporary, name='file', bytes=1)
        for offset, data in [(1, 'YQ=='), (0, base64.b64encode(b'a' * (module.LIMIT + 1)).decode())]:
            with self.assertRaises(ValueError):
                self.call('write-chunk', temporary=temporary, offset=offset, data=data)
        self.call('write-chunk', temporary=temporary, offset=0, data='YQ==')
        (self.path / 'file').write_bytes(b'existing')
        with self.assertRaises(FileExistsError):
            self.call('commit', temporary=temporary, name='file', bytes=1, sha256=hashlib.sha256(b'a').hexdigest())
        self.assertEqual((self.path / 'file').read_bytes(), b'existing')
        self.call('abort', temporary=temporary)
        (self.path / temporary).symlink_to(self.path / 'file')
        with self.assertRaises(OSError):
            self.call('read-chunk', temporary=temporary, offset=0, length=1)
        self.call('abort', temporary=temporary)
        os.link(self.path / 'file', self.path / temporary)
        with self.assertRaises(ValueError):
            self.call('read-chunk', temporary=temporary, offset=0, length=1)
        self.call('abort', temporary=temporary)
        with self.assertRaises(ValueError):
            self.call('begin-write', temporary=temporary, name='file', bytes=module.FILE_LIMIT + 1)
    def test_empty_and_full_limit(self):
        self.assertEqual(module.FILE_LIMIT, 209715200)
        for size in (0, module.FILE_LIMIT):
            temporary = '.transfer-' + str(uuid.uuid4())
            self.call('begin-write', temporary=temporary, name=f'file-{size}', bytes=size)
            digest = hashlib.sha256()
            for offset in range(0, size, module.LIMIT):
                data = b'x' * min(module.LIMIT, size - offset)
                digest.update(data)
                self.call('write-chunk', temporary=temporary, offset=offset, data=base64.b64encode(data).decode())
            self.call('commit', temporary=temporary, name=f'file-{size}', bytes=size, sha256=digest.hexdigest())
            self.call('abort', temporary=temporary)
            self.assertEqual((self.path / f'file-{size}').stat().st_size, size)
    def test_publication_never_links_a_swapped_staging_symlink(self):
        temporary = '.transfer-' + str(uuid.uuid4())
        self.call('begin-write', temporary=temporary, name='published', bytes=1)
        self.call('write-chunk', temporary=temporary, offset=0, data='YQ==')
        (self.path / 'other').write_bytes(b'wrong')
        original_link = os.link
        def swap_then_link(source, target, **kwargs):
            (self.path / temporary).unlink()
            (self.path / temporary).symlink_to(self.path / 'other')
            return original_link(source, target, **kwargs)
        with patch.object(module.os, 'link', swap_then_link):
            with self.assertRaises(FileNotFoundError):
                self.call('commit', temporary=temporary, name='published', bytes=1, sha256=hashlib.sha256(b'a').hexdigest())
        self.assertFalse((self.path / 'published').exists())
        self.call('abort', temporary=temporary)
    def test_delete_checks_freshness_and_allows_cleanup_above_transfer_limit(self):
        target = self.path / 'large.bin'
        with target.open('wb') as file:
            file.truncate(module.FILE_LIMIT + 1)
        listing = self.call('list')
        self.assertEqual(listing['storage']['bytes'], module.FILE_LIMIT + 1)
        self.assertGreater(listing['storage']['freeBytes'], 0)
        item = listing['files'][0]
        target.write_bytes(b'new content')
        with self.assertRaises(module.FileChanged):
            self.call('delete', name=item['name'], version=item['version'])
        self.assertEqual(target.read_bytes(), b'new content')
        with target.open('wb') as file:
            file.truncate(module.FILE_LIMIT + 1)
        item = self.call('list')['files'][0]
        self.assertEqual(self.call('delete', name=item['name'], version=item['version']), {'name': 'large.bin', 'deleted': True})
        self.assertEqual(self.call('list')['storage']['bytes'], 0)
        with self.assertRaises(module.FileChanged):
            self.call('delete', name=item['name'], version=item['version'])
    def test_delete_refuses_unsafe_names_links_and_replaced_files(self):
        target = self.path / 'file'
        target.write_bytes(b'keep')
        token = self.call('list')['files'][0]['version']
        for name in ('../file', '/file', '.transfer-hidden', 'dir/file', 'dir\\file', 'bad\0name'):
            with self.assertRaises(ValueError):
                self.call('delete', name=name, version=token)
        with self.assertRaises(ValueError):
            self.call('delete', name='file', version=None)
        os.link(target, self.path / 'alias')
        with self.assertRaises(module.FileChanged):
            self.call('delete', name='file', version=token)
        (self.path / 'alias').unlink()
        target.rename(self.path / 'kept')
        target.symlink_to(self.path / 'kept')
        with self.assertRaises(module.FileChanged):
            self.call('delete', name='file', version=token)
        target.unlink()
        target.mkdir()
        with self.assertRaises(module.FileChanged):
            self.call('delete', name='file', version=token)
        target.rmdir()
        os.mkfifo(target)
        with self.assertRaises(module.FileChanged):
            self.call('delete', name='file', version=token)
        target.unlink()
        target.write_bytes(b'keep')
        with self.assertRaises(module.FileChanged):
            self.call('delete', name='file', version=token)
        self.assertEqual((self.path / 'kept').read_bytes(), b'keep')
    def test_delete_never_follows_a_leaf_swapped_after_freshness_check(self):
        (self.path / 'file').write_bytes(b'delete')
        (self.path / 'keep').write_bytes(b'keep')
        token = next(item['version'] for item in self.call('list')['files'] if item['name'] == 'file')
        unlink = os.unlink
        def swap_then_unlink(name, **kwargs):
            unlink(name, **kwargs)
            (self.path / name).symlink_to(self.path / 'keep')
            return unlink(name, **kwargs)
        with patch.object(module.os, 'unlink', swap_then_unlink):
            self.call('delete', name='file', version=token)
        self.assertEqual((self.path / 'keep').read_bytes(), b'keep')

if __name__ == '__main__': unittest.main()
