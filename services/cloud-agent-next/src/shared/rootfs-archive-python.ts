/** Shared filesystem archive implementation. No credential or provider API is available here. */
export const ROOTFS_ARCHIVE_PYTHON = String.raw`import base64, decimal, errno, hashlib, io, json, os, re, stat, sys, tarfile

class ArchiveError(Exception):
    def __init__(self, code):
        self.code = code

def fail(code):
    raise ArchiveError(code)

def allowed_xattr(name):
    return (name.startswith('user.') and len(name) > 5) or name in (
        'security.capability', 'security.selinux', 'system.posix_acl_access', 'system.posix_acl_default')

def canonical(value):
    if not isinstance(value, str) or not value or len(value.encode('utf-8')) > 4096:
        fail('invalid_archive')
    if '\x00' in value or value.startswith('/') or '\\' in value:
        fail('invalid_archive')
    if any(part in ('', '.', '..') for part in value.split('/')):
        fail('invalid_archive')
    return value

def blocked(value):
    if any(value == item or value.startswith(item + '/') for item in C['protectedPaths']):
        return True
    parts = value.split('/')
    if parts[0] not in ('root', 'home'):
        return False
    return any(value.endswith('/' + item) or ('/' + item + '/') in value for item in C['credentialPaths'])

def writable(value, destructive=False):
    canonical(value)
    if blocked(value) or (destructive and any(item.startswith(value + '/') for item in C['protectedPaths'])):
        fail('invalid_archive')

def metadata(path):
    s = os.lstat(path)
    kind = 'file' if stat.S_ISREG(s.st_mode) else 'directory' if stat.S_ISDIR(s.st_mode) else 'symlink' if stat.S_ISLNK(s.st_mode) else None
    if kind is None:
        return None
    return [kind, s.st_size, stat.S_IMODE(s.st_mode), s.st_uid, s.st_gid,
            s.st_mtime_ns, s.st_ctime_ns, s.st_dev, s.st_ino, s.st_nlink,
            os.readlink(path) if kind == 'symlink' else None]

def inventory():
    found, encoded_size = {}, 0
    device = os.lstat(ROOT).st_dev
    pending = ['']
    while pending:
        parent = pending.pop()
        with os.scandir(os.path.join(ROOT, parent)) as entries:
            for entry in entries:
                name = (parent + '/' if parent else '') + entry.name
                canonical(name)
                if blocked(name):
                    continue
                try:
                    value = metadata(os.path.join(ROOT, name))
                except FileNotFoundError:
                    continue
                if value is None or value[7] != device:
                    continue
                encoded_size += len(json.dumps({name: value}, ensure_ascii=True, separators=(',', ':')).encode('utf-8'))
                if encoded_size > C['maxMetadataBytes'] - 65_536:
                    fail('limit_exceeded')
                found[name] = value
                if len(found) > C['maxEntries']:
                    fail('limit_exceeded')
                if value[0] == 'directory':
                    pending.append(name)
    return found

def read_json(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as stream:
        if os.fstat(stream.fileno()).st_size > C['maxMetadataBytes']:
            fail('limit_exceeded')
        return json.load(stream)

def write_json(path, value):
    data = json.dumps(value, ensure_ascii=True, separators=(',', ':')).encode('utf-8')
    if len(data) > C['maxMetadataBytes']:
        fail('limit_exceeded')
    temporary = path + '.new'
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(data)
    os.replace(temporary, path)

def xattrs(path):
    try:
        names = os.listxattr(path, follow_symlinks=False)
    except OSError as error:
        if error.errno in (errno.ENOTSUP, errno.EOPNOTSUPP):
            return {}
        raise
    result = {}
    total = 0
    for name in sorted(names):
        if not allowed_xattr(name):
            fail('unsupported_metadata')
        value = os.getxattr(path, name, follow_symlinks=False)
        total += len(name.encode('utf-8')) + len(value)
        if len(name.encode('utf-8')) > 255 or len(value) > 65_536 or total > C['maxPaxBytes']:
            fail('limit_exceeded')
        key = base64.urlsafe_b64encode(name.encode('utf-8')).decode('ascii').rstrip('=')
        result['KILO.xattr.' + key] = base64.b64encode(value).decode('ascii')
    return result

def fingerprint(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as stream:
        while True:
            block = stream.read(1024 * 1024)
            if not block:
                break
            digest.update(block)
    return digest.hexdigest()

def baseline():
    entries = inventory()
    write_json(C['baselinePath'], {'format': 1, 'baseImage': C['baseImage'], 'entries': entries})
    return {'entryCount': len(entries)}

def capture():
    before = read_json(C['baselinePath'])
    if before.get('format') != 1 or before.get('baseImage') != C['baseImage'] or not isinstance(before.get('entries'), dict):
        fail('base_mismatch')
    if len(before['entries']) > C['maxEntries']:
        fail('limit_exceeded')
    for name in before['entries']:
        writable(name)
    after = inventory()
    changed = sorted(name for name, value in after.items() if before['entries'].get(name) != value)
    missing = set(before['entries']) - set(after)
    deleted = [name for name in sorted(missing) if not any('/'.join(name.split('/')[:i]) in missing for i in range(1, len(name.split('/'))))]
    for name in deleted:
        writable(name, True)
    manifest = json.dumps({'format': 1, 'baseImage': C['baseImage'], 'deleted': deleted}, separators=(',', ':')).encode()
    if len(manifest) > C['maxMetadataBytes']:
        fail('limit_exceeded')
    links = {}
    expanded = 0
    with tarfile.open(C['archivePath'], 'x', format=tarfile.PAX_FORMAT) as archive:
        header = tarfile.TarInfo('.kilo-rootfs/manifest.json')
        header.size = len(manifest)
        header.mode = 0o600
        archive.addfile(header, io.BytesIO(manifest))
        for name in changed:
            full = os.path.join(ROOT, name)
            expected = after[name]
            if metadata(full) != expected:
                fail('filesystem_changed')
            kind, size, mode, uid, gid, mtime, ctime, dev, ino, nlink, target = expected
            header = tarfile.TarInfo(name)
            header.mode, header.uid, header.gid = mode, uid, gid
            header.pax_headers = xattrs(full)
            header.pax_headers['mtime'] = format(decimal.Decimal(mtime) / decimal.Decimal(1_000_000_000), 'f')
            if kind == 'directory':
                header.type = tarfile.DIRTYPE
                archive.addfile(header)
            elif kind == 'symlink':
                header.type, header.linkname = tarfile.SYMTYPE, target
                archive.addfile(header)
            elif (dev, ino) in links:
                header.type, header.linkname = tarfile.LNKTYPE, links[(dev, ino)]
                archive.addfile(header)
            else:
                expanded += size
                if expanded > C['maxArchiveBytes']:
                    fail('limit_exceeded')
                header.size = size
                fd = os.open(full, os.O_RDONLY | os.O_NOFOLLOW)
                with os.fdopen(fd, 'rb') as stream:
                    if os.fstat(stream.fileno()).st_ino != ino:
                        fail('filesystem_changed')
                    archive.addfile(header, stream)
                links[(dev, ino)] = name
            if metadata(full) != expected:
                fail('filesystem_changed')
            if archive.offset > C['maxArchiveBytes']:
                fail('limit_exceeded')
    size = os.stat(C['archivePath']).st_size
    if size > C['maxArchiveBytes']:
        fail('limit_exceeded')
    preflight(C['archivePath'], size)
    return {'format': 1, 'baseImage': C['baseImage'], 'sha256': fingerprint(C['archivePath']),
            'size': size, 'expandedBytes': expanded, 'fileCount': len(changed), 'deletedCount': len(deleted)}

def check_pax(data):
    offset, keys = 0, set()
    while offset < len(data):
        end = data.find(b' ', offset)
        if end < 0 or end - offset > 10 or not data[offset:end].isdigit():
            fail('invalid_archive')
        length = int(data[offset:end])
        following = offset + length
        if following > len(data) or following <= end + 1 or data[following - 1:following] != b'\n':
            fail('invalid_archive')
        field = data[end + 1:following - 1]
        if b'=' not in field:
            fail('invalid_archive')
        key = field.split(b'=', 1)[0].decode('utf-8')
        if key in keys or not (key in ('path', 'linkpath', 'mtime', 'uid', 'gid') or key.startswith('KILO.xattr.')):
            fail('invalid_archive')
        keys.add(key)
        offset = following

# Check raw extension sizes before tarfile can allocate PAX payloads.
def preflight(path, size):
    pax_total, headers, previous_pax = 0, 0, False
    if size > C['maxArchiveBytes'] or size % 512:
        fail('invalid_archive')
    with open(path, 'rb') as stream:
        while stream.tell() < size:
            block = stream.read(512)
            if not any(block):
                while True:
                    tail = stream.read(1024 * 1024)
                    if not tail:
                        return
                    if any(tail):
                        fail('invalid_archive')
            checksum = block[148:156].strip(b'\x00 ')
            try:
                expected = int(checksum, 8)
            except ValueError:
                fail('invalid_archive')
            if sum(block[:148]) + 8 * 32 + sum(block[156:]) != expected:
                fail('invalid_archive')
            raw = block[124:136]
            if raw[0] == 0x80:
                amount = int.from_bytes(raw[1:], 'big')
            else:
                try:
                    amount = int(raw.strip(b'\x00 ') or b'0', 8)
                except ValueError:
                    fail('invalid_archive')
            kind = block[156:157]
            if kind not in (b'\x00', b'0', b'1', b'2', b'5', b'x') or amount < 0:
                fail('invalid_archive')
            if kind not in (b'\x00', b'0', b'x') and amount != 0:
                fail('invalid_archive')
            if kind == b'x':
                if previous_pax:
                    fail('invalid_archive')
                pax_total += amount
                if amount > C['maxPaxBytes'] or pax_total > C['maxMetadataBytes']:
                    fail('limit_exceeded')
            previous_pax = kind == b'x'
            headers += 1
            if headers > (C['maxEntries'] + 1) * 2:
                fail('limit_exceeded')
            following = stream.tell() + ((amount + 511) // 512) * 512
            if following > size:
                fail('invalid_archive')
            if kind == b'x':
                check_pax(stream.read(amount))
            stream.seek(following)
    fail('invalid_archive')

# Every filesystem traversal uses stable directory descriptors without following links.
def parent_fd(root_fd, name, create=False):
    pieces = canonical(name).split('/')
    fd = os.dup(root_fd)
    try:
        for piece in pieces[:-1]:
            try:
                child = os.open(piece, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            except FileNotFoundError:
                if not create:
                    os.close(fd)
                    return None, pieces[-1]
                os.mkdir(piece, 0o700, dir_fd=fd)
                child = os.open(piece, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            if os.fstat(child).st_dev != ROOT_DEVICE:
                os.close(child)
                fail('invalid_archive')
            os.close(fd)
            fd = child
        return fd, pieces[-1]
    except BaseException:
        os.close(fd)
        raise

def exists(fd, name):
    try:
        return os.stat(name, dir_fd=fd, follow_symlinks=False)
    except FileNotFoundError:
        return None

def remove_at(fd, name):
    current = exists(fd, name)
    if current is None:
        return
    if stat.S_ISDIR(current.st_mode):
        child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
        try:
            for part in os.listdir(child):
                remove_at(child, part)
        finally:
            os.close(child)
        os.rmdir(name, dir_fd=fd)
    else:
        os.unlink(name, dir_fd=fd)

def mtime_ns(member):
    value = member.pax_headers.get('mtime', str(member.mtime))
    if len(value) > 24 or re.fullmatch(r'-?[0-9]{1,11}(?:\.[0-9]{1,9})?', value) is None:
        fail('invalid_archive')
    result = int(decimal.Decimal(value) * decimal.Decimal(1_000_000_000))
    if result < -(2**63) or result >= 2**63:
        fail('invalid_archive')
    return result

def parsed_xattrs(member):
    attributes, total = {}, 0
    for key, value in member.pax_headers.items():
        if key.startswith('GNU.sparse'):
            fail('invalid_archive')
        if not key.startswith('KILO.xattr.'):
            continue
        try:
            encoded = key[len('KILO.xattr.'):]
            name = base64.b64decode(encoded + '=' * (-len(encoded) % 4), altchars=b'-_', validate=True).decode('utf-8')
            data = base64.b64decode(value, validate=True)
        except (ValueError, UnicodeError):
            fail('invalid_archive')
        if not allowed_xattr(name):
            fail('unsupported_metadata')
        total += len(name.encode()) + len(data)
        if '\x00' in name or len(name.encode()) > 255 or len(data) > 65_536 or total > C['maxPaxBytes'] or name in attributes:
            fail('limit_exceeded')
        attributes[name] = data
    return attributes

def validate_ancestry(seen):
    for name in seen:
        parts = name.split('/')
        for i in range(1, len(parts)):
            ancestor = seen.get('/'.join(parts[:i]))
            if ancestor is not None and not ancestor.isdir():
                fail('invalid_archive')

def sync_xattrs(read, remove, write, expected):
    try:
        current = read()
    except OSError as error:
        if error.errno in (errno.ENOTSUP, errno.EOPNOTSUPP) and not expected:
            return
        fail('unsupported_metadata')
    for key in current:
        if allowed_xattr(key) and key not in expected:
            remove(key)
    for key, value in expected.items():
        write(key, value)

def validate_tree(root_fd, path, seen):
    parts = path.split('/')
    fd = os.dup(root_fd)
    try:
        for i, part in enumerate(parts[:-1]):
            ancestor = '/'.join(parts[:i + 1])
            expected = seen.get(ancestor)
            present = exists(fd, part)
            if present is None:
                return False
            if present.st_dev != ROOT_DEVICE:
                fail('invalid_archive')
            if not stat.S_ISDIR(present.st_mode):
                if expected is not None and expected.isdir():
                    return False  # This type replacement happens before descendants.
                fail('invalid_archive')
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        return True
    finally:
        os.close(fd)

def validate_removal(fd, leaf, path):
    global REMOVAL_BUDGET
    REMOVAL_BUDGET -= 1
    if REMOVAL_BUDGET < 0:
        fail('limit_exceeded')
    present = exists(fd, leaf)
    if present is None:
        return
    writable(path, True)
    if present.st_dev != ROOT_DEVICE:
        fail('invalid_archive')
    if stat.S_ISDIR(present.st_mode):
        child = os.open(leaf, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
        try:
            for name in os.listdir(child):
                validate_removal(child, name, path + '/' + name)
        finally:
            os.close(child)

def apply_metadata(root_fd, member):
    fd, leaf = parent_fd(root_fd, member.name)
    if fd is None:
        fail('restore_failed')
    try:
        attributes = parsed_xattrs(member)
        mtime = mtime_ns(member)
        if member.issym():
            os.chown(leaf, member.uid, member.gid, dir_fd=fd, follow_symlinks=False)
            os.utime(leaf, ns=(mtime, mtime), dir_fd=fd, follow_symlinks=False)
            saved = os.open('.', os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fchdir(fd)
                sync_xattrs(
                    lambda: os.listxattr(leaf, follow_symlinks=False),
                    lambda key: os.removexattr(leaf, key, follow_symlinks=False),
                    lambda key, value: os.setxattr(leaf, key, value, follow_symlinks=False), attributes)
            finally:
                os.fchdir(saved)
                os.close(saved)
        else:
            target = os.open(leaf, os.O_RDONLY | os.O_NOFOLLOW | (os.O_DIRECTORY if member.isdir() else 0), dir_fd=fd)
            try:
                os.fchown(target, member.uid, member.gid)
                os.fchmod(target, member.mode & 0o7777)
                sync_xattrs(lambda: os.listxattr(target), lambda key: os.removexattr(target, key),
                    lambda key, value: os.setxattr(target, key, value), attributes)
                os.utime(target, ns=(mtime, mtime))
            finally:
                os.close(target)
    finally:
        os.close(fd)

def restore():
    expected = C['expected']
    size = os.stat(C['archivePath']).st_size
    if size != expected['size'] or fingerprint(C['archivePath']) != expected['sha256']:
        fail('invalid_archive')
    preflight(C['archivePath'], size)
    root_fd = os.open(ROOT, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        with tarfile.open(C['archivePath'], 'r:') as archive:
            seen, manifest, expanded = {}, None, 0
            for member in archive:
                if member.sparse is not None:
                    fail('invalid_archive')
                if member.name == '.kilo-rootfs/manifest.json':
                    if manifest is not None or seen or not member.isfile() or member.size > C['maxMetadataBytes']:
                        fail('invalid_archive')
                    body = archive.extractfile(member)
                    if body is None:
                        fail('invalid_archive')
                    manifest = json.load(body)
                    continue
                if manifest is None or not (member.isfile() or member.isdir() or member.issym() or member.islnk()):
                    fail('invalid_archive')
                writable(member.name, not member.isdir())
                if member.name in seen or member.size < 0 or member.uid < 0 or member.gid < 0 or member.uid > 2**31 - 1 or member.gid > 2**31 - 1:
                    fail('invalid_archive')
                parsed_xattrs(member)
                mtime_ns(member)
                if member.mode < 0 or member.mode > 0o7777:
                    fail('invalid_archive')
                if member.isfile():
                    expanded += member.size
                if member.islnk():
                    target = seen.get(canonical(member.linkname))
                    if target is None or not (target.isfile() or target.islnk()):
                        fail('invalid_archive')
                if member.issym() and ('\x00' in member.linkname or len(member.linkname.encode('utf-8')) > 4096):
                    fail('invalid_archive')
                seen[member.name] = member
                if len(seen) > C['maxEntries'] or expanded > C['maxArchiveBytes'] or member.offset_data + member.size > size:
                    fail('limit_exceeded')
            if not isinstance(manifest, dict) or manifest.get('format') != 1 or manifest.get('baseImage') != C['baseImage'] or expected.get('baseImage') != C['baseImage']:
                fail('base_mismatch')
            deleted = manifest.get('deleted')
            if not isinstance(deleted, list) or any(not isinstance(path, str) for path in deleted) or len(deleted) > C['maxEntries']:
                fail('invalid_archive')
            deletion_set = set(deleted)
            if len(deletion_set) != len(deleted) or any(any('/'.join(name.split('/')[:i]) in deletion_set for i in range(1, len(name.split('/')))) for name in deleted):
                fail('invalid_archive')
            if expanded != expected['expandedBytes'] or len(seen) != expected['fileCount'] or len(deleted) != expected['deletedCount']:
                fail('invalid_archive')
            validate_ancestry(seen)
            # All paths and current parent directories are checked before the first write.
            for path in deleted:
                writable(path, True)
                if not validate_tree(root_fd, path, {}):
                    continue
                fd, leaf = parent_fd(root_fd, path)
                if fd is not None:
                    try:
                        validate_removal(fd, leaf, path)
                    finally:
                        os.close(fd)
            for path, member in seen.items():
                if not validate_tree(root_fd, path, seen):
                    continue
                fd, leaf = parent_fd(root_fd, path)
                if fd is not None:
                    try:
                        present = exists(fd, leaf)
                        if present is not None and present.st_dev != ROOT_DEVICE:
                            fail('invalid_archive')
                        if present is not None and not (member.isdir() and stat.S_ISDIR(present.st_mode)):
                            validate_removal(fd, leaf, path)
                    finally:
                        os.close(fd)
            for path in sorted(deleted, key=lambda name: -name.count('/')):
                fd, leaf = parent_fd(root_fd, path)
                if fd is not None:
                    try:
                        remove_at(fd, leaf)
                    finally:
                        os.close(fd)
            ordered = sorted(seen.values(), key=lambda member: (0, member.name.count('/'), member.offset) if member.isdir() else (1, 0, member.offset))
            for member in ordered:
                fd, leaf = parent_fd(root_fd, member.name, True)
                try:
                    present = exists(fd, leaf)
                    if member.isdir():
                        if present is not None and not stat.S_ISDIR(present.st_mode):
                            remove_at(fd, leaf)
                            present = None
                        if present is None:
                            os.mkdir(leaf, 0o700, dir_fd=fd)
                    else:
                        remove_at(fd, leaf)
                        if member.isfile():
                            output_fd = os.open(leaf, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
                            body = archive.extractfile(member)
                            if body is None:
                                fail('invalid_archive')
                            with os.fdopen(output_fd, 'wb') as output:
                                remaining = member.size
                                while remaining:
                                    data = body.read(min(1024 * 1024, remaining))
                                    if not data:
                                        fail('invalid_archive')
                                    output.write(data)
                                    remaining -= len(data)
                        elif member.issym():
                            os.symlink(member.linkname, leaf, dir_fd=fd)
                        else:
                            source_fd, source_name = parent_fd(root_fd, member.linkname)
                            if source_fd is None:
                                fail('invalid_archive')
                            try:
                                os.link(source_name, leaf, src_dir_fd=source_fd, dst_dir_fd=fd, follow_symlinks=False)
                            finally:
                                os.close(source_fd)
                finally:
                    os.close(fd)
            for member in sorted(seen.values(), key=lambda member: (member.isdir(), -member.name.count('/'))):
                apply_metadata(root_fd, member)
            return {'restored': True}
    finally:
        os.close(root_fd)

try:
    data = sys.stdin.buffer.read(65_537)
    if len(data) > 65_536:
        fail('limit_exceeded')
    C = json.loads(data)
    ROOT = os.path.realpath(C['root'])
    ROOT_DEVICE = os.lstat(ROOT).st_dev
    REMOVAL_BUDGET = C['maxEntries'] * 4
    result = {'baseline': baseline, 'capture': capture, 'restore': restore}[C['action']]()
    print(json.dumps({'ok': True, 'result': result}, separators=(',', ':')))
except ArchiveError as error:
    print(json.dumps({'ok': False, 'code': error.code}))
    sys.exit(1)
except BaseException:
    print(json.dumps({'ok': False, 'code': 'operation_failed'}))
    sys.exit(1)
`;
