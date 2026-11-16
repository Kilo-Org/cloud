import { rejects } from 'node:assert/strict';
import { afterEach, describe, expect, it } from 'bun:test';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cp,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  chmod,
  copyFile,
  realpath,
  truncate,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { baselineRootFilesystem, captureRootFilesystem, restoreRootFilesystem } from './archive.js';
import {
  rootfsArchiveConfiguration,
  type RootfsArchiveDescriptor,
} from '../../../src/shared/rootfs-archive.js';
import { ROOTFS_ARCHIVE_PYTHON } from '../../../src/shared/rootfs-archive-python.js';

const python = promisify(execFile);
const temporary: string[] = [];
afterEach(async () => {
  for (const root of temporary.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'kilo-rootfs-test-'));
  temporary.push(directory);
  const root = path.join(directory, 'source');
  const restored = path.join(directory, 'restored');
  await mkdir(root);
  const write = async (name: string, text: string, mode = 0o644) => {
    const full = path.join(root, name);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, text, { mode });
  };
  await write('usr/lib/package/tool', 'old package', 0o755);
  await write('obsolete', 'remove me');
  await write('type-file', 'old file');
  await write('type-dir/old', 'old directory child');
  await write('etc/hosts', 'provider hosts');
  await cp(root, restored, { recursive: true, preserveTimestamps: true });
  const baselinePath = path.join(directory, 'baseline.json');
  const archivePath = path.join(directory, 'archive.tar');
  const baseImage = 'test-runtime-image@1';
  const signal = AbortSignal.timeout(30_000);
  return { directory, root, restored, write, baselinePath, archivePath, baseImage, signal };
}
async function mutation(f: Awaited<ReturnType<typeof fixture>>) {
  await f.write('usr/lib/package/tool', '#!/bin/sh\nprintf installed-package-ready', 0o755);
  const old = new Date('2000-01-01T00:00:00Z');
  await utimes(path.join(f.root, 'usr/lib/package/tool'), old, old);
  await rm(path.join(f.root, 'obsolete'));
  await rm(path.join(f.root, 'type-file'));
  await f.write('type-file/new-child', 'now a directory');
  await rm(path.join(f.root, 'type-dir'), { recursive: true });
  await f.write('type-dir', 'now a file');
  await mkdir(path.join(f.root, 'usr/bin'), { recursive: true });
  await link(path.join(f.root, 'usr/lib/package/tool'), path.join(f.root, 'usr/bin/package-tool'));
  await symlink('../lib/package/tool', path.join(f.root, 'usr/bin/package-link'));
  await f.write('tmp/proxy-identity', 'synthetic-proxy-secret');
  await f.write('run/builder/credential', 'synthetic-runner-secret');
  await f.write(
    'home/worktree/.local/share/kilo/cloud-agent/git-credentials',
    'synthetic-scm-secret'
  );
  await f.write('etc/hosts', 'stale provider hosts');
  await f.write('home/worktree/.cache/tool/data', 'prepared cache');
}
describe.skipIf(process.platform !== 'linux')('shared root filesystem archives', () => {
  it('finds nested mounts when the archive root is the filesystem root', async () => {
    const definitions = ROOTFS_ARCHIVE_PYTHON.slice(
      0,
      ROOTFS_ARCHIVE_PYTHON.lastIndexOf('\ntry:\n    data =')
    );
    const { stdout } = await python('/usr/bin/python3', [
      '-c',
      definitions + "\nROOT = '/'\nprint(json.dumps(sorted(nested_mounts())))",
    ]);
    const mounts: string[] = JSON.parse(stdout);
    expect(mounts).toContain('proc');
    expect(mounts).not.toContain('.');
    expect(mounts.every(name => !name.startsWith('/'))).toBe(true);
  });

  it('captures and replaces regular files with a different overlay device', async () => {
    const f = await fixture();
    const overlay = String.raw`import os, stat
original_lstat, original_stat = os.lstat, os.stat
class OverlayStat:
    def __init__(self, value):
        self.value = value
    def __getattr__(self, name):
        return self.value.st_dev + 1 if name == 'st_dev' else getattr(self.value, name)
def overlay_lstat(*args, **kwargs):
    value = original_lstat(*args, **kwargs)
    return OverlayStat(value) if stat.S_ISREG(value.st_mode) else value
def overlay_stat(*args, **kwargs):
    value = original_stat(*args, **kwargs)
    return OverlayStat(value) if stat.S_ISREG(value.st_mode) else value
os.lstat, os.stat = overlay_lstat, overlay_stat
original_listxattr = os.listxattr
def provider_labels(*args, **kwargs):
    return list(set(original_listxattr(*args, **kwargs)) | {'security.selinux'})
os.listxattr = provider_labels
`;
    async function execute(
      action: 'baseline' | 'capture' | 'restore',
      expected?: RootfsArchiveDescriptor
    ) {
      const input = JSON.stringify({
        ...rootfsArchiveConfiguration(),
        ...f,
        root: action === 'restore' ? f.restored : f.root,
        action,
        expected,
      });
      const stdout = await new Promise<string>((resolve, reject) => {
        const child = spawn('/usr/bin/python3', ['-c', overlay + ROOTFS_ARCHIVE_PYTHON], {
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let output = '';
        child.stdout.on('data', chunk => {
          output += chunk.toString();
        });
        child.once('error', reject);
        child.once('close', code => (code === 0 ? resolve(output) : reject(new Error(output))));
        child.stdin.end(input);
      });
      return JSON.parse(stdout);
    }
    await execute('baseline');
    await f.write('usr/lib/package/tool', 'changed overlay file');
    await rm(path.join(f.root, 'type-file'));
    await f.write('type-file/child', 'new overlay descendant');
    const descriptor = (await execute('capture')).result as RootfsArchiveDescriptor;
    expect(
      (await readFile(f.archivePath)).includes(Buffer.from('KILO.xattr.c2VjdXJpdHkuc2VsaW51eA'))
    ).toBe(false);
    expect(descriptor.expandedBytes).toBeGreaterThan(0);
    expect((await execute('restore', descriptor)).ok).toBe(true);
    expect(await readFile(path.join(f.restored, 'usr/lib/package/tool'), 'utf8')).toBe(
      'changed overlay file'
    );
    expect(await readFile(path.join(f.restored, 'type-file/child'), 'utf8')).toBe(
      'new overlay descendant'
    );
  });

  it('restores installed files, old mtimes, hardlinks, symlinks, deletions and type replacements', async () => {
    const f = await fixture();
    await baselineRootFilesystem(f);
    await mutation(f);
    const descriptor = await captureRootFilesystem(f);
    await restoreRootFilesystem({ ...f, root: f.restored, expected: descriptor });
    const tool = path.join(f.restored, 'usr/lib/package/tool');
    const result = await promisify(execFile)(tool);
    expect(result.stdout).toBe('installed-package-ready');
    expect((await stat(tool)).mode & 0o777).toBe(0o755);
    expect((await stat(tool)).mtime.toISOString()).toBe('2000-01-01T00:00:00.000Z');
    expect((await stat(tool)).ino).toBe(
      (await stat(path.join(f.restored, 'usr/bin/package-tool'))).ino
    );
    expect(await readlink(path.join(f.restored, 'usr/bin/package-link'))).toBe(
      '../lib/package/tool'
    );
    expect(await readFile(path.join(f.restored, 'type-file/new-child'), 'utf8')).toBe(
      'now a directory'
    );
    expect(await readFile(path.join(f.restored, 'type-dir'), 'utf8')).toBe('now a file');
    expect(await stat(path.join(f.restored, 'obsolete')).catch(() => null)).toBeNull();
    expect(await readFile(path.join(f.restored, 'etc/hosts'), 'utf8')).toBe('provider hosts');
    expect(await readFile(path.join(f.restored, 'home/worktree/.cache/tool/data'), 'utf8')).toBe(
      'prepared cache'
    );
    for (const name of [
      'tmp/proxy-identity',
      'run/builder/credential',
      'home/worktree/.local/share/kilo/cloud-agent/git-credentials',
    ])
      expect(await lstat(path.join(f.restored, name)).catch(() => null)).toBeNull();
  });
  it('preserves binary user attributes with encoded names', async () => {
    const f = await fixture();
    await baselineRootFilesystem(f);
    const source = path.join(f.root, 'usr/lib/package/tool');
    await python('/usr/bin/python3', [
      '-c',
      "import os,sys;os.setxattr(sys.argv[1],'user.kilo-binary',bytes([0,255,13,10]))",
      source,
    ]);
    const expected = await captureRootFilesystem(f);
    await restoreRootFilesystem({ ...f, root: f.restored, expected });
    const result = await python('/usr/bin/python3', [
      '-c',
      "import os,sys;print(os.getxattr(sys.argv[1],'user.kilo-binary').hex())",
      path.join(f.restored, 'usr/lib/package/tool'),
    ]);
    expect(result.stdout.trim()).toBe('00ff0d0a');
  });
  it('removes a baseline directory attribute that setup removed', async () => {
    const f = await fixture();
    const source = path.join(f.root, 'usr/lib/package');
    const target = path.join(f.restored, 'usr/lib/package');
    await python('/usr/bin/python3', [
      '-c',
      "import os,sys;[os.setxattr(p,'user.kilo-test',b'old') for p in sys.argv[1:]]",
      source,
      target,
    ]);
    await baselineRootFilesystem(f);
    await python('/usr/bin/python3', [
      '-c',
      "import os,sys;os.removexattr(sys.argv[1],'user.kilo-test')",
      source,
    ]);
    const descriptor = await captureRootFilesystem(f);
    await restoreRootFilesystem({ ...f, root: f.restored, expected: descriptor });
    const result = await python('/usr/bin/python3', [
      '-c',
      "import os,sys;print('user.kilo-test' in os.listxattr(sys.argv[1]))",
      target,
    ]);
    expect(result.stdout.trim()).toBe('False');
  });
  it('replaces an existing hardlinked inode without changing its other path', async () => {
    const f = await fixture();
    const outside = path.join(f.directory, 'outside');
    await writeFile(outside, 'must remain');
    await rm(path.join(f.restored, 'usr/lib/package/tool'));
    await link(outside, path.join(f.restored, 'usr/lib/package/tool'));
    await baselineRootFilesystem(f);
    await f.write('usr/lib/package/tool', 'new contents');
    const descriptor = await captureRootFilesystem(f);
    await restoreRootFilesystem({ ...f, root: f.restored, expected: descriptor });
    expect(await readFile(outside, 'utf8')).toBe('must remain');
    expect(await readFile(path.join(f.restored, 'usr/lib/package/tool'), 'utf8')).toBe(
      'new contents'
    );
  });
  // Setting a file capability and dropping to an unprivileged user both require root.
  it.skipIf(process.getuid?.() !== 0)(
    'restores an executable capability and its behavior for an unprivileged process',
    async () => {
      const f = await fixture();
      await baselineRootFilesystem(f);
      await mkdir(path.join(f.root, 'usr/bin'), { recursive: true });
      const executable = path.join(f.root, 'usr/bin/capability-probe');
      await copyFile(await realpath('/usr/bin/python3'), executable);
      await chmod(executable, 0o755);
      const setCapability =
        "import os,struct,sys;os.setxattr(sys.argv[1],'security.capability',struct.pack('<IIIII',0x02000001,1<<10,0,0,0))";
      await python('/usr/bin/python3', ['-c', setCapability, executable]);
      const descriptor = await captureRootFilesystem(f);
      await restoreRootFilesystem({ ...f, root: f.restored, expected: descriptor });
      await chmod(f.directory, 0o755);
      const target = path.join(f.restored, 'usr/bin/capability-probe');
      const result = await python('/usr/bin/python3', [
        '-c',
        `import os,subprocess,sys
p=subprocess.run([sys.argv[1],'-c',"print(next(x.split()[1] for x in open('/proc/self/status') if x.startswith('CapEff:')))"],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,preexec_fn=lambda:(os.setgid(65534),os.setuid(65534)))
assert p.returncode==0
print(p.stdout.strip())`,
        target,
      ]);
      expect(result.stdout.trim()).toBe('0000000000000400');
    }
  );
  it('removes a default ACL instead of inheriting it into restored files', async () => {
    const f = await fixture();
    const source = path.join(f.root, 'usr/lib/package');
    const target = path.join(f.restored, 'usr/lib/package');
    const installAcl =
      "import os,struct,sys;v=struct.pack('<I',2)+b''.join(struct.pack('<HHI',t,p,0xffffffff) for t,p in [(1,7),(4,5),(32,5)]);[os.setxattr(p,'system.posix_acl_default',v) for p in sys.argv[1:]]";
    await python('/usr/bin/python3', ['-c', installAcl, source, target]);
    await baselineRootFilesystem(f);
    await python('/usr/bin/python3', [
      '-c',
      "import os,sys;os.removexattr(sys.argv[1],'system.posix_acl_default')",
      source,
    ]);
    await f.write('usr/lib/package/new-file', 'new file');
    const descriptor = await captureRootFilesystem(f);
    await restoreRootFilesystem({ ...f, root: f.restored, expected: descriptor });
    const result = await python('/usr/bin/python3', [
      '-c',
      "import os,sys;print('system.posix_acl_default' in os.listxattr(sys.argv[1]));print('system.posix_acl_access' in os.listxattr(sys.argv[2]))",
      target,
      path.join(target, 'new-file'),
    ]);
    expect(result.stdout.trim()).toBe('False\nFalse');
  });
  it('bounds capture before reading a sparse file larger than the single upload limit', async () => {
    const f = await fixture();
    await baselineRootFilesystem(f);
    const large = path.join(f.root, 'too-large');
    await writeFile(large, '');
    await truncate(large, 5 * 1024 ** 3 + 1);
    await rejects(captureRootFilesystem(f), { code: 'limit_exceeded' });
  });
  it('refuses a changed base or damaged archive before any deletion', async () => {
    const f = await fixture();
    await baselineRootFilesystem(f);
    await mutation(f);
    const descriptor = await captureRootFilesystem(f);
    await rejects(
      restoreRootFilesystem({
        ...f,
        root: f.restored,
        expected: descriptor,
        baseImage: 'other-image',
      }),
      { code: 'base_mismatch' }
    );
    expect(await readFile(path.join(f.restored, 'obsolete'), 'utf8')).toBe('remove me');
    await writeFile(f.archivePath, 'damaged');
    await rejects(restoreRootFilesystem({ ...f, root: f.restored, expected: descriptor }), {
      code: 'invalid_archive',
    });
    expect(await readFile(path.join(f.restored, 'obsolete'), 'utf8')).toBe('remove me');
  });
  it('bounds PAX allocation before parsing its declared payload', async () => {
    const f = await fixture();
    await python('/usr/bin/python3', [
      '-c',
      "import sys,tarfile;m=tarfile.TarInfo('PaxHeaders/oversized');m.type=tarfile.XHDTYPE;m.size=5*1024**3;open(sys.argv[1],'wb').write(m.tobuf(format=tarfile.USTAR_FORMAT)+bytes(512))",
      f.archivePath,
    ]);
    const body = await readFile(f.archivePath);
    const expected: RootfsArchiveDescriptor = {
      format: 1,
      baseImage: f.baseImage,
      size: body.length,
      sha256: createHash('sha256').update(body).digest('hex'),
      fileCount: 0,
      deletedCount: 0,
      expandedBytes: 0,
    };
    await rejects(restoreRootFilesystem({ ...f, root: f.restored, expected }), {
      code: 'limit_exceeded',
    });
    expect(await readFile(path.join(f.restored, 'obsolete'), 'utf8')).toBe('remove me');
  });
  it.skipIf(!process.env.ROOTFS_MOUNT_TEST_ROOT)(
    'excludes nested mounts and refuses replacing a mounted file',
    async () => {
      const f = await fixture();
      const root = process.env.ROOTFS_MOUNT_TEST_ROOT;
      if (!root) throw new Error('Missing test mount root');
      const expected = await hostile(f, [{ name: 'mounted-file', data: 'replacement' }], []);
      await rejects(restoreRootFilesystem({ ...f, root, expected }), { code: 'invalid_archive' });
      expect(await readFile(path.join(root, 'mounted-file'), 'utf8')).toBe('mounted file');
      await rm(f.archivePath);
      const location = { ...f, root };
      await baselineRootFilesystem(location);
      await writeFile(path.join(root, 'ordinary-file'), 'included');
      const descriptor = await captureRootFilesystem(location);
      expect(descriptor.fileCount).toBe(1);
      expect(descriptor.expandedBytes).toBe(8);
    }
  );
  it.skipIf(!process.env.ROOTFS_MOUNT_TEST_ROOT)(
    'refuses deletion across a nested filesystem boundary',
    async () => {
      const f = await fixture();
      const root = process.env.ROOTFS_MOUNT_TEST_ROOT;
      if (!root) throw new Error('Missing test mount root');
      await writeFile(path.join(root, 'mounted/keep'), 'mounted data');
      const expected = await hostile(f, [], ['mounted']);
      await rejects(restoreRootFilesystem({ ...f, root, expected }), {
        code: 'invalid_archive',
      });
      expect(await readFile(path.join(root, 'mounted/keep'), 'utf8')).toBe('mounted data');
    }
  );
});

async function hostile(
  f: Awaited<ReturnType<typeof fixture>>,
  entries: Record<string, unknown>[],
  deleted: string[] = []
): Promise<RootfsArchiveDescriptor> {
  await python('/usr/bin/python3', [
    '-c',
    `import io,json,sys,tarfile
cfg=json.loads(sys.argv[2])
with tarfile.open(sys.argv[1],'w',format=tarfile.PAX_FORMAT) as t:
 b=json.dumps({'format':1,'baseImage':cfg['baseImage'],'deleted':cfg['deleted']}).encode()
 m=tarfile.TarInfo('.kilo-rootfs/manifest.json');m.size=len(b);t.addfile(m,io.BytesIO(b))
 for e in cfg['entries']:
  m=tarfile.TarInfo(e['name']);m.mode=0o644
  if e.get('kind')=='symlink':m.type=tarfile.SYMTYPE;m.linkname=e['target']
  else:m.size=len(e.get('data','').encode())
  m.pax_headers=e.get('pax',{})
  t.addfile(m,None if m.issym() else io.BytesIO(e.get('data','').encode()))
`,
    f.archivePath,
    JSON.stringify({ baseImage: f.baseImage, entries, deleted }),
  ]);
  const body = await readFile(f.archivePath);
  return {
    format: 1,
    baseImage: f.baseImage,
    sha256: createHash('sha256').update(body).digest('hex'),
    size: body.length,
    expandedBytes: entries.reduce(
      (sum, value) => sum + (typeof value.data === 'string' ? Buffer.byteLength(value.data) : 0),
      0
    ),
    fileCount: entries.length,
    deletedCount: deleted.length,
  };
}
describe.skipIf(process.platform !== 'linux')(
  'archive validation before filesystem mutation',
  () => {
    it('rejects imported SELinux labels before applying any deletion', async () => {
      const f = await fixture();
      const key = 'KILO.xattr.' + Buffer.from('security.selinux').toString('base64url');
      const expected = await hostile(
        f,
        [
          {
            name: 'usr/lib/package/tool',
            data: 'unsafe label',
            pax: { [key]: Buffer.from('source-context').toString('base64') },
          },
        ],
        ['obsolete']
      );
      await rejects(restoreRootFilesystem({ ...f, root: f.restored, expected }), {
        code: 'unsupported_metadata',
      });
      expect(await readFile(path.join(f.restored, 'obsolete'), 'utf8')).toBe('remove me');
      expect(await readFile(path.join(f.restored, 'usr/lib/package/tool'), 'utf8')).toBe(
        'old package'
      );
    });
    it.each(
      [
        [{ name: '../outside', data: 'bad' }],
        [{ name: '/etc/hosts', data: 'bad' }],
        [{ name: 'etc/hosts', data: 'bad' }],
        [
          { name: 'new/link', kind: 'symlink', target: '../../outside' },
          { name: 'new/link/file', data: 'bad' },
        ],
        [
          { name: 'same', data: 'one' },
          { name: 'same', data: 'two' },
        ],
        [{ name: 'new-file', data: 'bad', pax: { mtime: 'NaN' } }],
        [{ name: 'new-file', data: 'bad', pax: { mtime: '1e999999999' } }],
      ].map(entries => ({ entries }))
    )(
      'refuses malformed or unsafe entries without applying the manifest deletion',
      async ({ entries }) => {
        const f = await fixture();
        const descriptor = await hostile(f, entries, ['obsolete']);
        await rejects(restoreRootFilesystem({ ...f, root: f.restored, expected: descriptor }), {
          code: 'invalid_archive',
        });
        expect(await readFile(path.join(f.restored, 'obsolete'), 'utf8')).toBe('remove me');
        expect(await stat(path.join(f.restored, 'new')).catch(() => null)).toBeNull();
        expect(await stat(path.join(f.restored, 'new-file')).catch(() => null)).toBeNull();
      }
    );
    it('refuses deletion of a protected ancestor before changing existing files', async () => {
      const f = await fixture();
      const descriptor = await hostile(f, [], ['etc']);
      await rejects(restoreRootFilesystem({ ...f, root: f.restored, expected: descriptor }), {
        code: 'invalid_archive',
      });
      expect(await readFile(path.join(f.restored, 'etc/hosts'), 'utf8')).toBe('provider hosts');
    });
    it('refuses an existing symlink parent instead of writing outside the restore root', async () => {
      const f = await fixture();
      const outside = path.join(f.directory, 'outside-directory');
      await mkdir(outside);
      await symlink(outside, path.join(f.restored, 'linked'));
      const descriptor = await hostile(f, [{ name: 'linked/file', data: 'bad' }]);
      await rejects(restoreRootFilesystem({ ...f, root: f.restored, expected: descriptor }), {
        code: 'invalid_archive',
      });
      expect(await stat(path.join(outside, 'file')).catch(() => null)).toBeNull();
    });
  }
);
