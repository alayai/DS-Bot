"""Stopped-home checkpoints; runs only in an offline, unprivileged helper container."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import sys

LIMIT = 128 * 1024 * 1024
ENTRIES = 10000


def digest(path):
    result = hashlib.sha256()
    with open(path, 'rb') as source:
        while chunk := source.read(1024 * 1024):
            result.update(chunk)
    return result.hexdigest()


def inventory(root):
    entries = []
    total = 0
    skipped = 0
    for directory, folders, files in os.walk(root, followlinks=False):
        for name in sorted(folders + files):
            path = Path(directory) / name
            info = path.lstat()
            relative = str(path.relative_to(root))
            item = {'path': relative, 'mode': stat.S_IMODE(info.st_mode) & 0o777}
            if stat.S_ISLNK(info.st_mode):
                item.update(kind='link', target=os.readlink(path))
            elif stat.S_ISDIR(info.st_mode):
                item.update(kind='directory')
            elif stat.S_ISREG(info.st_mode):
                total += info.st_size
                if total > LIMIT:
                    raise ValueError('Checkpoint exceeds 128 MiB.')
                item.update(kind='file', bytes=info.st_size, sha256=digest(path))
            else:
                skipped += 1
                continue
            entries.append(item)
            if len(entries) > ENTRIES:
                raise ValueError('Checkpoint has too many entries.')
    return sorted(entries, key=lambda item: item['path']), total, skipped


def headroom(destination, size):
    capacity = os.statvfs(destination)
    available = capacity.f_bavail * capacity.f_frsize
    if available < size * 2 + 256 * 1024 * 1024:
        raise ValueError('Insufficient desktop storage: keep 256 MiB free plus twice the copy size.')


def transfer(source, destination, entries):
    for item in sorted(entries, key=lambda item: (item['path'].count('/'), item['path'])):
        path = Path(item['path'])
        if path.is_absolute() or '..' in path.parts or not path.parts:
            raise ValueError('Invalid checkpoint path.')
        src, dst = source / path, destination / path
        if item['kind'] == 'directory':
            dst.mkdir(mode=0o700)
        elif item['kind'] == 'link':
            dst.symlink_to(item['target'])
        else:
            with open(src, 'rb') as reader, open(dst, 'xb') as writer:
                shutil.copyfileobj(reader, writer, 1024 * 1024)
                writer.flush()
                os.fsync(writer.fileno())
            os.chmod(dst, item['mode'])
    # Read-only source directories must not prevent copying their children.
    for item in reversed(entries):
        if item['kind'] == 'directory':
            os.chmod(destination / item['path'], item['mode'])
            fd = os.open(destination / item['path'], os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
    fd = os.open(destination, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def checkpoint(operation, source, destination, identity):
    if operation == 'create':
        entries, size, skipped = inventory(source)
        headroom(destination.parent, size)
        destination.mkdir(mode=0o700)
        data = destination / 'data'
        data.mkdir(mode=0o700)
        transfer(source, data, entries)
        actual, _, _ = inventory(data)
        if actual != entries:
            raise ValueError('Checkpoint verification failed.')
        manifest = {'version': 1, **identity, 'bytes': size, 'skipped': skipped, 'entries': entries}
        raw = json.dumps(manifest, sort_keys=True, separators=(',', ':')).encode()
        with open(destination / 'manifest.tmp', 'xb') as output:
            output.write(raw)
            output.flush()
            os.fsync(output.fileno())
        os.replace(destination / 'manifest.tmp', destination / 'manifest.json')
        fd = os.open(destination, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
        fd = os.open(destination.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
        return {'hash': hashlib.sha256(raw).hexdigest(), 'bytes': size, 'entries': len(entries), 'skipped': skipped}
    raw = (source / 'manifest.json').read_bytes()
    if hashlib.sha256(raw).hexdigest() != identity['hash']:
        raise ValueError('Checkpoint manifest hash mismatch.')
    manifest = json.loads(raw)
    if manifest['version'] != 1 or any(manifest.get(key) != value for key, value in identity.items() if key != 'hash'):
        raise ValueError('Checkpoint identity mismatch.')
    actual, _, _ = inventory(source / 'data')
    if actual != manifest['entries']:
        raise ValueError('Checkpoint content hash mismatch.')
    headroom(destination, manifest['bytes'])
    # The destination is a newly created staging volume; never the current home.
    for path in destination.iterdir():
        if path.is_dir() and not path.is_symlink():
            shutil.rmtree(path)
        else:
            path.unlink()
    transfer(source / 'data', destination, actual)
    verified, size, _ = inventory(destination)
    if verified != actual:
        raise ValueError('Restored home verification failed.')
    return {'bytes': size, 'entries': len(actual)}


def usage(root):
    total = 0
    entries = 0
    for directory, folders, files in os.walk(root, followlinks=False):
        for name in folders + files:
            entries += 1
            if entries > ENTRIES:
                raise ValueError('Too many entries for a bounded storage scan.')
            try:
                info = (Path(directory) / name).lstat()
            except FileNotFoundError:
                continue
            if stat.S_ISREG(info.st_mode):
                total += info.st_size
    capacity = os.statvfs(root)
    return {'bytes': total, 'entries': entries, 'freeBytes': capacity.f_bavail * capacity.f_frsize,
            'totalBytes': capacity.f_blocks * capacity.f_frsize, 'hardQuota': False,
            'reserveBytes': 256 * 1024 * 1024}


if __name__ == '__main__':
    request = json.load(sys.stdin)
    if request['operation'] == 'usage':
        result = usage(Path('/source'))
    elif request['operation'] == 'create':
        result = checkpoint('create', Path('/source'), Path('/home/cua/.dsbot-checkpoint'), request['identity'])
    else:
        result = checkpoint('restore', Path('/source/.dsbot-checkpoint'), Path('/home/cua'), request['identity'])
    print(json.dumps(result))
