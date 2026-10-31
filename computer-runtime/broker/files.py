"""Small, flat, no-follow transfer area. Never extracts archives or overwrites files."""
import base64
import json
import os
import re
import stat
import sys
import uuid

LIMIT = 262144
FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


def directory(parent, name, create=False):
    if create:
        try:
            os.mkdir(name, 0o700, dir_fd=parent)
        except FileExistsError:
            pass
    return os.open(name, FLAGS, dir_fd=parent)


def transfer(args, root):
    operation = args.get('operation')
    if operation not in ('list', 'read', 'write'):
        raise ValueError('Unknown file operation.')
    if operation == 'list':
        files = []
        # scandir avoids materializing an unbounded directory before the cap.
        with os.scandir(root) as entries:
            for count, entry in enumerate(entries):
                if count >= 1000:
                    raise ValueError('The transfer directory contains too many entries.')
                info = entry.stat(follow_symlinks=False)
                if stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and not entry.name.startswith('.'):
                    files.append({'name': entry.name, 'bytes': info.st_size})
        return {'files': sorted(files, key=lambda item: item['name']), 'limit': LIMIT}
    name = args.get('name')
    if not isinstance(name, str) or not re.fullmatch(r'[^/\\\x00-\x1f]{1,120}', name) or name.startswith('.'):
        raise ValueError('Use a plain file name without folders or hidden names.')
    if operation == 'read':
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=root)
        with os.fdopen(fd, 'rb') as file:
            info = os.fstat(file.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > LIMIT:
                raise ValueError('Export requires a regular file of at most 256 KiB without hard links.')
            data = file.read(LIMIT + 1)
        if len(data) > LIMIT:
            raise ValueError('The file exceeded 256 KiB during export.')
        return {'name': name, 'data': base64.b64encode(data).decode(), 'bytes': len(data)}
    encoded = args.get('data')
    if not isinstance(encoded, str) or len(encoded) > 349528:
        raise ValueError('Files must be at most 256 KiB.')
    data = base64.b64decode(encoded, validate=True)
    if len(data) > LIMIT:
        raise ValueError('Files must be at most 256 KiB.')
    temporary = '.import-' + uuid.uuid4().hex
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=root)
    try:
        with os.fdopen(fd, 'wb') as file:
            file.write(data)
            file.flush()
            os.fsync(file.fileno())
        # link publishes atomically and refuses an existing name, including a symlink.
        os.link(temporary, name, src_dir_fd=root, dst_dir_fd=root, follow_symlinks=False)
    finally:
        os.unlink(temporary, dir_fd=root)
    os.fsync(root)
    return {'name': name, 'bytes': len(data)}


def main():
    args = json.loads(sys.stdin.read(400000))
    handles = []
    try:
        handles.append(os.open('/', FLAGS))
        handles.append(directory(handles[-1], 'home'))
        handles.append(directory(handles[-1], 'cua'))
        handles.append(directory(handles[-1], 'DSBot', create=True))
        return transfer(args, handles[-1])
    finally:
        for fd in reversed(handles):
            os.close(fd)


if __name__ == '__main__':
    try:
        print(json.dumps({'ok': True, 'value': main()}))
    except FileExistsError:
        print(json.dumps({'ok': False, 'error': 'A file with this name already exists. Choose a new name.'}))
    except (ValueError, OSError):
        print(json.dumps({'ok': False, 'error': 'File transfer refused. Use a new plain name and a regular file of at most 256 KiB in /home/cua/DSBot.'}))
