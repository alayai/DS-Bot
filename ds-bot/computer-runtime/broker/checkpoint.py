"""Stopped-home checkpoints; runs only in an offline, unprivileged helper container."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import sys
import time

LIMIT = 20 * 1024 ** 3
ENTRIES = 100000
MANIFEST_LIMIT = 64 * 1024 ** 2


class Progress:
    def __init__(self, emit=lambda value: None):
        self.emit = emit
        self.last = 0

    def report(self, stage, done, total=0, force=False):
        now = time.monotonic()
        if force or now - self.last >= 0.5:
            self.emit({"progress": {"stage": stage, "doneBytes": done, "totalBytes": total}})
            self.last = now


def digest(path, progress=None):
    result = hashlib.sha256()
    with open(path, 'rb') as source:
        while chunk := source.read(1024 * 1024):
            result.update(chunk)
            if progress:
                progress(len(chunk))
    return result.hexdigest()


def inventory(root, limit=None, progress=None, stage="checking"):
    limit = LIMIT if limit is None else limit
    hashed = 0

    def counted(size):
        nonlocal hashed
        hashed += size
        if progress:
            progress.report(stage, hashed)

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
                if total > limit:
                    raise ValueError('Checkpoint exceeds the configured byte limit.')
                item.update(kind='file', bytes=info.st_size, sha256=digest(path, counted))
            else:
                skipped += 1
                continue
            entries.append(item)
            if len(entries) > ENTRIES:
                raise ValueError('Checkpoint has too many entries.')
    if progress:
        progress.report(stage, hashed, hashed, True)
    return sorted(entries, key=lambda item: item['path']), total, skipped


def headroom(destination, size):
    capacity = os.statvfs(destination)
    available = capacity.f_bavail * capacity.f_frsize
    if available < size * 2 + 256 * 1024 * 1024:
        raise ValueError('Insufficient desktop storage: keep 256 MiB free plus twice the copy size.')


def transfer(source, destination, entries, progress=None):
    total = sum(item.get("bytes", 0) for item in entries)
    done = 0
    if progress:
        progress.report("copying", 0, total, True)
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
                while chunk := reader.read(1024 * 1024):
                    writer.write(chunk)
                    done += len(chunk)
                    if progress:
                        progress.report("copying", done, total)
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


def checkpoint(operation, source, destination, identity, limit=None, progress=None):
    limit = LIMIT if limit is None else limit
    if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 1024 ** 4:
        raise ValueError("Invalid checkpoint byte limit.")
    progress = progress or Progress()
    progress.report("checking", 0, force=True)
    if operation == 'create':
        entries, size, skipped = inventory(source, limit, progress)
        headroom(destination.parent, size)
        destination.mkdir(mode=0o700)
        data = destination / 'data'
        data.mkdir(mode=0o700)
        transfer(source, data, entries, progress)
        actual, _, _ = inventory(data, limit, progress, "verifying")
        if actual != entries:
            raise ValueError('Checkpoint verification failed.')
        manifest = {'version': 1, **identity, 'bytes': size, 'skipped': skipped, 'entries': entries}
        raw = json.dumps(manifest, sort_keys=True, separators=(',', ':')).encode()
        if len(raw) > MANIFEST_LIMIT:
            raise ValueError('Checkpoint manifest is too large.')
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
    with open(source / 'manifest.json', 'rb') as manifest_file:
        raw = manifest_file.read(MANIFEST_LIMIT + 1)
    if len(raw) > MANIFEST_LIMIT:
        raise ValueError('Checkpoint manifest is too large.')
    if hashlib.sha256(raw).hexdigest() != identity['hash']:
        raise ValueError('Checkpoint manifest hash mismatch.')
    manifest = json.loads(raw)
    if manifest['version'] != 1 or any(manifest.get(key) != value for key, value in identity.items() if key != 'hash'):
        raise ValueError('Checkpoint identity mismatch.')
    actual, size, _ = inventory(source / 'data', limit, progress)
    if manifest.get('bytes') != size or actual != manifest['entries']:
        raise ValueError('Checkpoint content hash mismatch.')
    headroom(destination, manifest['bytes'])
    # The destination is a newly created staging volume; never the current home.
    for path in destination.iterdir():
        if path.is_dir() and not path.is_symlink():
            shutil.rmtree(path)
        else:
            path.unlink()
    transfer(source / 'data', destination, actual, progress)
    verified, size, _ = inventory(destination, limit, progress, "verifying")
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
    try:
        request = json.load(sys.stdin)
        options = {'limit': request.get('maxBytes', LIMIT),
                   'progress': Progress(lambda value: print(json.dumps(value), flush=True))}
        if request['operation'] == 'usage':
            result = usage(Path('/source'))
        elif request['operation'] == 'create':
            result = checkpoint('create', Path('/source'), Path('/home/cua/.dsbot-checkpoint'), request['identity'], **options)
        else:
            result = checkpoint('restore', Path('/source/.dsbot-checkpoint'), Path('/home/cua'), request['identity'], **options)
        print(json.dumps(result))
    except ValueError as error:
        print(json.dumps({"error": str(error)[:300]}), flush=True)
    except OSError:
        print(json.dumps({"error": "Desktop storage could not be copied. Check free space and file permissions."}), flush=True)
