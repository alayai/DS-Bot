"""Portable home format; no tar extraction, no compression, no host filesystem paths."""
import hashlib
import json
import os
import re
from pathlib import Path
import stat
import shutil
import sys

MAGIC = b'DSBOTBACKUP1\n'
CHUNK = 1024 * 1024
MAX_HEADER = 64 * 1024 * 1024

def digest(path):
    value = hashlib.sha256()
    with open(path, 'rb') as source:
        while chunk := source.read(CHUNK):
            value.update(chunk)
    return value.hexdigest()

def entries(root, limit):
    result, total = [], 0
    def unreadable(error):
        raise error
    for directory, folders, files in os.walk(root, followlinks=False, onerror=unreadable):
        for name in sorted(folders + files):
            path = Path(directory) / name
            info = path.lstat()
            item = {'path': path.relative_to(root).as_posix(), 'mode': stat.S_IMODE(info.st_mode) & 0o777}
            if stat.S_ISDIR(info.st_mode): item['kind'] = 'directory'
            elif stat.S_ISLNK(info.st_mode): item.update(kind='link', target=os.readlink(path))
            elif stat.S_ISREG(info.st_mode):
                total += info.st_size
                if total > limit: raise ValueError('Backup exceeds the configured limit.')
                item.update(kind='file', bytes=info.st_size, sha256=digest(path))
            else: continue
            result.append(item)
            if len(result) > 100000: raise ValueError('Too many backup entries.')
    return sorted(result, key=lambda item: (item['path'].count('/'), item['path'])), total

def export_home(root, output, image, limit):
    items, total = entries(root, limit)
    header = json.dumps({'version': 1, 'image': image, 'bytes': total, 'entries': items}, ensure_ascii=True).encode()
    if len(header) > MAX_HEADER: raise ValueError('Backup manifest is too large.')
    output.write(MAGIC + ('%08d\n' % len(header)).encode() + header)
    for item in items:
        if item['kind'] != 'file': continue
        checked = hashlib.sha256()
        with open(root / item['path'], 'rb') as source:
            remaining = item['bytes']
            while remaining:
                chunk = source.read(min(CHUNK, remaining))
                if not chunk: raise ValueError('Source changed during backup.')
                output.write(chunk); checked.update(chunk); remaining -= len(chunk)
            if source.read(1): raise ValueError('Source changed during backup.')
        if checked.hexdigest() != item['sha256']: raise ValueError('Source changed during backup.')

def exact(source, size):
    chunks, remaining = [], size
    while remaining:
        data = source.read(remaining)
        if not data: raise ValueError('Truncated backup.')
        chunks.append(data); remaining -= len(data)
    return b''.join(chunks)

def import_home(root, source, image, limit):
    if exact(source, len(MAGIC)) != MAGIC: raise ValueError('Unsupported backup format.')
    size = exact(source, 9)
    if not size[:8].isdigit() or size[-1:] != b'\n': raise ValueError('Invalid backup header.')
    length = int(size[:8])
    if not 0 < length <= MAX_HEADER: raise ValueError('Backup manifest is too large.')
    header = json.loads(exact(source, length))
    if not isinstance(header, dict): raise ValueError('Invalid manifest.')
    items = header.get('entries')
    if header.get('version') != 1 or header.get('image') != image: raise ValueError('Prepare the original image before importing this backup.')
    if not isinstance(items, list) or len(items) > 100000: raise ValueError('Invalid backup entries.')
    known, total = {}, 0
    for item in items:
        if not isinstance(item, dict): raise ValueError('Invalid entry.')
        name = item.get('path')
        if not isinstance(name, str) or not name or len(name) > 4096 or '\x00' in name or '\\' in name: raise ValueError('Invalid backup path.')
        path = Path(name)
        if path.is_absolute() or any(part in ('', '.', '..') for part in name.split('/')) or name in known: raise ValueError('Invalid backup path.')
        if item.get('kind') not in ('file', 'directory', 'link') or type(item.get('mode')) is not int or not 0 <= item['mode'] <= 0o777: raise ValueError('Invalid backup entry.')
        for parent in path.parents:
            if parent == Path('.'): break
            if known.get(parent.as_posix()) != 'directory': raise ValueError('Unsafe backup parent.')
        if item['kind'] == 'file':
            if type(item.get('bytes')) is not int or item['bytes'] < 0 or not isinstance(item.get('sha256'), str) or not re.fullmatch('[a-f0-9]{64}', item['sha256']): raise ValueError('Invalid file checksum or size.')
            total += item['bytes']
            if total > limit: raise ValueError('Backup exceeds the configured limit.')
        if item['kind'] == 'link' and (not isinstance(item.get('target'), str) or '\x00' in item['target'] or len(item['target']) > 4096): raise ValueError('Invalid link.')
        known[name] = item['kind']
    if header.get('bytes') != total: raise ValueError('Backup size mismatch.')
    space = os.statvfs(root)
    if space.f_bavail * space.f_frsize < total + 256 * 1024 ** 2: raise ValueError('Insufficient storage for imported home.')
    # This root is a newly-created, unpublished volume. Remove image seed files only.
    for path in root.iterdir():
        if path.is_dir() and not path.is_symlink(): shutil.rmtree(path)
        else: path.unlink()
    for item in items:
        path = root / item['path']
        if item['kind'] == 'directory': path.mkdir(mode=0o700)
        elif item['kind'] == 'link': path.symlink_to(item['target'])
        else:
            checked, remaining = hashlib.sha256(), item['bytes']
            with open(path, 'xb') as target:
                while remaining:
                    chunk = source.read(min(CHUNK, remaining))
                    if not chunk: raise ValueError('Truncated backup file.')
                    target.write(chunk); checked.update(chunk); remaining -= len(chunk)
                target.flush(); os.fsync(target.fileno())
            if checked.hexdigest() != item['sha256']: raise ValueError('Backup file checksum mismatch.')
            if digest(path) != item['sha256']: raise ValueError('Imported file readback mismatch.')
            path.chmod(item['mode'])
    if source.read(1): raise ValueError('Unexpected trailing backup data.')
    for item in reversed(items):
        if item['kind'] == 'directory': (root / item['path']).chmod(item['mode'])
    return {'bytes': total, 'entries': len(items)}

if __name__ == '__main__':
    request = json.loads(sys.stdin.buffer.readline(65536))
    if request['operation'] == 'export':
        export_home(Path('/source'), sys.stdout.buffer, request['image'], request['maxBytes'])
    else:
        print(json.dumps(import_home(Path('/home/cua'), sys.stdin.buffer, request['image'], request['maxBytes'])))
