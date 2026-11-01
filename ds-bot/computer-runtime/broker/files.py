"""Small, flat, no-follow transfer area. Never extracts archives or overwrites files."""
import base64
import hashlib
import json
import os
import re
import stat
import sys
import time
import uuid

LIMIT = 262144
FILE_LIMIT = 200 * 1024 * 1024
RESERVE_BYTES = 16 * 1024 * 1024
FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


class FileChanged(ValueError):
    pass


def version(info):
    values = (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
    return hashlib.sha256(':'.join(map(str, values)).encode()).hexdigest()


def directory(parent, name, create=False):
    if create:
        try:
            os.mkdir(name, 0o700, dir_fd=parent)
        except FileExistsError:
            pass
    return os.open(name, FLAGS, dir_fd=parent)


def regular(fd, limit=FILE_LIMIT):
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > limit:
        raise ValueError('A bounded regular file without hard links is required.')
    return info


def staged(args, root):
    operation = args['operation']
    temporary = args.get('temporary')
    if not isinstance(temporary, str) or not re.fullmatch(r'\.transfer-[a-f0-9-]{36}', temporary):
        raise ValueError('Invalid staging identity.')
    if operation == 'abort':
        try:
            os.unlink(temporary, dir_fd=root)
        except FileNotFoundError:
            pass
        return {}
    if operation in ('begin-write', 'begin-read'):
        name = args.get('name')
        if not isinstance(name, str) or not re.fullmatch(r'[^/\\\x00-\x1f]{1,120}', name) or name.startswith('.'):
            raise ValueError('Invalid file name.')
        # A dead Broker may leave unpublished staging files. Never follow them.
        with os.scandir(root) as entries:
            for count, entry in enumerate(entries):
                if count >= 1000:
                    raise ValueError('The transfer directory contains too many entries.')
                if re.fullmatch(r'\.transfer-[a-f0-9-]{36}', entry.name):
                    info = entry.stat(follow_symlinks=False)
                    if stat.S_ISREG(info.st_mode) and info.st_mtime < time.time() - 600:
                        os.unlink(entry.name, dir_fd=root)
        size = args.get('bytes', 0) if operation == 'begin-write' else os.stat(name, dir_fd=root, follow_symlinks=False).st_size
        if type(size) is not int or not 0 <= size <= FILE_LIMIT:
            raise ValueError('Files must be at most 200 MiB.')
        space = os.fstatvfs(root)
        if space.f_bavail * space.f_frsize < size + RESERVE_BYTES:
            raise ValueError('Not enough free space for a file transfer.')
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=root)
        with os.fdopen(fd, 'wb') as output:
            if operation == 'begin-read':
                source = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=root)
                with os.fdopen(source, 'rb') as file:
                    before = regular(file.fileno())
                    digest = hashlib.sha256()
                    copied = 0
                    while True:
                        data = file.read(LIMIT)
                        if not data:
                            break
                        copied += len(data)
                        if copied > FILE_LIMIT:
                            raise ValueError('File grew beyond 200 MiB.')
                        digest.update(data)
                        output.write(data)
                    after = regular(file.fileno())
                    if copied != before.st_size or (before.st_mtime_ns, before.st_ctime_ns) != (after.st_mtime_ns, after.st_ctime_ns):
                        raise ValueError('File changed while creating the export snapshot.')
                output.flush()
                os.fsync(output.fileno())
                return {'bytes': copied, 'sha256': digest.hexdigest()}
        return {}
    fd = os.open(temporary, (os.O_RDWR if operation == 'write-chunk' else os.O_RDONLY) | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=root)
    with os.fdopen(fd, 'r+b' if operation == 'write-chunk' else 'rb') as file:
        info = regular(file.fileno())
        if operation == 'commit':
            if type(args.get('bytes')) is not int or info.st_size != args['bytes']:
                raise ValueError('Incomplete file.')
            digest = hashlib.sha256()
            remaining = info.st_size
            while True:
                data = file.read(min(LIMIT, remaining + 1))
                if not data:
                    break
                remaining -= len(data)
                if remaining < 0:
                    raise ValueError('Staged file changed during commit.')
                digest.update(data)
            if remaining != 0 or digest.hexdigest() != args.get('sha256'):
                raise ValueError('File checksum did not match.')
            name = args.get('name')
            if not isinstance(name, str) or not re.fullmatch(r'[^/\\\x00-\x1f]{1,120}', name) or name.startswith('.'):
                raise ValueError('Invalid file name.')
            os.fsync(file.fileno())
            # Link the checked descriptor, not a pathname the guest could swap
            # after validation. Linux linkat follows this /proc fd reference.
            os.link('/proc/self/fd/' + str(file.fileno()), name, dst_dir_fd=root, follow_symlinks=True)
            os.fsync(root)
            return {}
        offset = args.get('offset')
        if type(offset) is not int or not 0 <= offset <= FILE_LIMIT:
            raise ValueError('Invalid chunk offset.')
        file.seek(offset)
        if operation == 'write-chunk':
            encoded = args.get('data')
            if not isinstance(encoded, str) or len(encoded) > 349528:
                raise ValueError('Invalid chunk.')
            data = base64.b64decode(encoded, validate=True)
            if not 0 < len(data) <= LIMIT or info.st_size != offset or offset + len(data) > FILE_LIMIT:
                raise ValueError('Invalid chunk length or order.')
            file.write(data)
            file.flush()
            os.fsync(file.fileno())
            return {'bytes': len(data)}
        length = args.get('length')
        if operation != 'read-chunk' or type(length) is not int or not 0 < length <= LIMIT:
            raise ValueError('Invalid read chunk.')
        data = file.read(length)
        if len(data) != length:
            raise ValueError('Export snapshot changed.')
        return {'data': base64.b64encode(data).decode(), 'bytes': len(data)}


def transfer(args, root):
    operation = args.get('operation')
    if operation in ('begin-write', 'begin-read', 'write-chunk', 'read-chunk', 'commit', 'abort'):
        return staged(args, root)
    if operation not in ('list', 'read', 'write', 'delete'):
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
                    files.append({'name': entry.name, 'bytes': info.st_size, 'version': version(info)})
        space = os.fstatvfs(root)
        return {'files': sorted(files, key=lambda item: item['name']), 'limit': FILE_LIMIT,
                'storage': {'bytes': sum(item['bytes'] for item in files),
                            'freeBytes': space.f_bavail * space.f_frsize}}
    name = args.get('name')
    if not isinstance(name, str) or not re.fullmatch(r'[^/\\\x00-\x1f]{1,120}', name) or name.startswith('.'):
        raise ValueError('Use a plain file name without folders or hidden names.')
    if operation == 'delete':
        if not isinstance(args.get('version'), str) or not re.fullmatch(r'[a-f0-9]{64}', args['version']):
            raise ValueError('List files before deleting.')
        try:
            info = os.stat(name, dir_fd=root, follow_symlinks=False)
        except FileNotFoundError:
            raise FileChanged('The file changed or was removed. Refresh the file list before deleting.')
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or version(info) != args['version']:
            raise FileChanged('The file changed or was removed. Refresh the file list before deleting.')
        # Authorization is for this flat name. unlink never follows a leaf
        # symlink, including one substituted by a guest after the freshness check.
        os.unlink(name, dir_fd=root)
        os.fsync(root)
        return {'name': name, 'deleted': True}
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
            # Publish the checked inode; refuse any existing destination.
            os.link('/proc/self/fd/' + str(file.fileno()), name, dst_dir_fd=root, follow_symlinks=True)
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
    except FileChanged as error:
        print(json.dumps({'ok': False, 'error': str(error)}))
    except (ValueError, OSError):
        print(json.dumps({'ok': False, 'error': 'File transfer refused. Check the name, size, checksum, free space and existing files in /home/cua/DSBot.'}))
