import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location('checkpoint', Path(__file__).parents[1] / 'broker' / 'checkpoint.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class Checkpoints(unittest.TestCase):
    def test_roundtrip_and_corruption_preserve_destination(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source, backup, restored = root / 'source', root / 'backup', root / 'restored'
            source.mkdir()
            restored.mkdir()
            (source / 'folder').mkdir()
            (source / 'folder' / 'data').write_bytes(b'original\x00bytes')
            (source / 'alias').symlink_to('folder/data')
            (source / 'outside').symlink_to('/never-follow-this')
            identity = {'computerId': 'fixture', 'image': 'fixture-image'}
            summary = module.checkpoint('create', source, backup, identity)
            (restored / 'seed').write_text('seed')
            module.checkpoint('restore', backup, restored, {**identity, 'hash': summary['hash']})
            self.assertEqual((restored / 'folder' / 'data').read_bytes(), b'original\x00bytes')
            self.assertTrue((restored / 'outside').is_symlink())
            self.assertFalse((restored / 'seed').exists())
            (backup / 'data' / 'folder' / 'data').write_text('corruption')
            with self.assertRaisesRegex(ValueError, 'content hash'):
                module.checkpoint('restore', backup, restored, {**identity, 'hash': summary['hash']})
            self.assertEqual((restored / 'folder' / 'data').read_bytes(), b'original\x00bytes')

    def test_low_space_refuses_copy_before_touching_destination(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source, destination = root / 'source', root / 'backup'
            source.mkdir()
            (source / 'data').write_bytes(b'keep')
            with patch.object(module.os, 'statvfs', return_value=SimpleNamespace(f_bavail=1, f_frsize=4096)):
                with self.assertRaisesRegex(ValueError, 'Insufficient desktop storage'):
                    module.checkpoint('create', source, destination, {})
            self.assertFalse(destination.exists())
            self.assertEqual((source / 'data').read_bytes(), b'keep')

    def test_usage_does_not_follow_symlinks_and_reports_no_hard_quota(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'data').write_bytes(b'keep')
            (root / 'outside').symlink_to('/')
            result = module.usage(root)
            self.assertEqual(result['bytes'], 4)
            self.assertEqual(result['entries'], 2)
            self.assertFalse(result['hardQuota'])
            self.assertGreater(result['freeBytes'], 0)

    def test_limit_identity_and_manifest_hash(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'source'
            source.mkdir()
            (source / 'file').write_text('bounded')
            old = module.LIMIT
            module.LIMIT = 2
            try:
                with self.assertRaisesRegex(ValueError, 'exceeds'):
                    module.checkpoint('create', source, root / 'too-big', {})
            finally:
                module.LIMIT = old
            summary = module.checkpoint('create', source, root / 'backup', {'computerId': 'a'})
            with self.assertRaisesRegex(ValueError, 'identity'):
                module.checkpoint('restore', root / 'backup', root / 'unused', {'computerId': 'b', 'hash': summary['hash']})
            with self.assertRaisesRegex(ValueError, 'manifest hash'):
                module.checkpoint('restore', root / 'backup', root / 'unused', {'computerId': 'a', 'hash': 'wrong'})


if __name__ == '__main__':
    unittest.main()
