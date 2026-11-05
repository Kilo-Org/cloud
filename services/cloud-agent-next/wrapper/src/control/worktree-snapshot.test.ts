import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash, randomBytes } from 'node:crypto';
import {
  InvalidWorktreeSnapshotError,
  applyWorktreeSnapshot,
  captureWorktreeSnapshotWithLimits,
  type WorktreeSnapshotLimits,
} from './worktree-snapshot.js';

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
};

const LIMITS: WorktreeSnapshotLimits = {
  files: 10_000,
  fileBytes: 10 * 1024 * 1024,
  totalBytes: 50 * 1024 * 1024,
  archiveBytes: 64 * 1024 * 1024,
  manifestBytes: 4 * 1024 * 1024,
  uncompressedBytes: 64 * 1024 * 1024,
};

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();
}

type Fixture = {
  base: string;
  origin: string;
  work: string;
  cleanup(): Promise<void>;
};

async function createFixture(prefix: string): Promise<Fixture> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const origin = path.join(base, 'origin.git');
  const work = path.join(base, 'work');
  git(base, ['init', '--bare', '-b', 'main', origin]);
  git(base, ['clone', origin, work]);
  await fs.writeFile(path.join(work, 'base.txt'), 'base\n');
  await fs.writeFile(path.join(work, 'tracked.txt'), 'tracked\n');
  await fs.writeFile(path.join(work, 'deleted.txt'), 'deleted\n');
  await fs.writeFile(path.join(work, '.gitignore'), 'ignored.txt\n.env\n');
  git(work, ['add', '.']);
  git(work, ['commit', '-m', 'initial']);
  git(work, ['push', '-u', 'origin', 'main']);
  git(work, ['remote', 'set-head', 'origin', 'main']);
  return {
    base,
    origin,
    work,
    cleanup: () => fs.rm(base, { recursive: true, force: true }),
  };
}

async function clone(fixture: Fixture, name: string): Promise<string> {
  const target = path.join(fixture.base, name);
  git(fixture.base, ['clone', fixture.origin, target]);
  return target;
}

function signal(): AbortSignal {
  return AbortSignal.timeout(60_000);
}

async function countGitCommands<T>(
  run: () => Promise<T>
): Promise<{ result: T; commands: number }> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'snapshot-git-count-'));
  const callsPath = path.join(directory, 'calls');
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const shim = path.join(directory, 'git');
  await fs.writeFile(
    shim,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(callsPath)}\nexec ${JSON.stringify(realGit)} "$@"\n`
  );
  await fs.chmod(shim, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${directory}:${previousPath ?? ''}`;
  try {
    const result = await run();
    const calls = await fs.readFile(callsPath, 'utf8');
    return {
      result,
      commands: calls.split('\n').filter(line => line.length > 0).length,
    };
  } finally {
    process.env.PATH = previousPath;
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function capture(work: string, worktreeId = 'worktree_test') {
  return captureWorktreeSnapshotWithLimits(
    { directory: work, worktreeId, signal: signal() },
    LIMITS
  );
}

function tarHeader(name: string, size: number, type = '0', mode = 0o644): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write(`${mode.toString(8).padStart(7, '0')}\0`, 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  header.write('00000000000\0', 136, 12, 'ascii');
  header.write(type, 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  header.fill(32, 148, 156);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, '0'), 148, 6, 'ascii');
  header[154] = 0;
  header[155] = 32;
  return header;
}

function tarEntry(name: string, data: Buffer, type = '0', mode = 0o644): Buffer[] {
  const padding = (512 - (data.length % 512)) % 512;
  return [tarHeader(name, data.length, type, mode), data, Buffer.alloc(padding)];
}

function tarGnuLongNameEntry(name: string, data: Buffer, mode = 0o644): Buffer[] {
  return [
    ...tarEntry('././@LongLink', Buffer.from(name, 'utf8'), 'L'),
    ...tarEntry(name.slice(0, 100), data, '0', mode),
  ];
}

function tarArchive(entries: Buffer[][]): Buffer {
  return Buffer.concat([...entries.flat(), Buffer.alloc(1024)]);
}

function manifestBytes(overrides: Record<string, unknown> = {}): Buffer {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      worktreeId: 'worktree_test',
      branch: 'main',
      base: '0'.repeat(40),
      capturedAt: '2026-01-01T00:00:00.000Z',
      deleted: [],
      omitted: [],
      partial: false,
      ...overrides,
    })
  );
}

async function writeArchive(directory: string, bytes: Buffer): Promise<string> {
  const archivePath = path.join(directory, `archive-${Math.random().toString(16).slice(2)}.tar.gz`);
  await fs.writeFile(archivePath, bytes);
  return archivePath;
}

function sanitizedTimestamp(capturedAt: string): string {
  return capturedAt.replace(/[^0-9A-Za-z._-]/g, '-');
}

async function expectInvalid(promise: Promise<unknown>): Promise<void> {
  let error: unknown;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(InvalidWorktreeSnapshotError);
}

async function expectFailure(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  let error: unknown;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).toMatch(pattern);
}

describe('worktree snapshot capture', () => {
  it('captures unstaged, staged, committed, untracked, binary, executable and deleted files', async () => {
    const fixture = await createFixture('snapshot-capture-');
    const target = await clone(fixture, 'target');
    try {
      await fs.writeFile(path.join(fixture.work, 'base.txt'), 'staged change\n');
      git(fixture.work, ['add', 'base.txt']);
      await fs.writeFile(path.join(fixture.work, 'tracked.txt'), 'unstaged change\n');
      await fs.writeFile(path.join(fixture.work, 'committed.txt'), 'committed but unpushed\n');
      git(fixture.work, ['add', 'committed.txt']);
      git(fixture.work, ['commit', '-m', 'unpushed']);
      await fs.writeFile(path.join(fixture.work, 'new.txt'), 'untracked\n');
      await fs.writeFile(
        path.join(fixture.work, 'binary.dat'),
        Buffer.from([0, 1, 2, 255, 0, 10, 13])
      );
      await fs.writeFile(path.join(fixture.work, 'tool.sh'), '#!/bin/sh\necho hi\n');
      chmodSync(path.join(fixture.work, 'tool.sh'), 0o755);
      await fs.unlink(path.join(fixture.work, 'deleted.txt'));
      await fs.writeFile(path.join(fixture.work, 'ignored.txt'), 'ignored\n');
      await fs.writeFile(path.join(fixture.work, '.env'), 'SECRET=1\n');
      await fs.symlink('new.txt', path.join(fixture.work, 'link'));
      mkdirSync(path.join(fixture.work, 'nested'));
      git(fixture.work, ['init', path.join(fixture.work, 'nested')]);
      writeFileSync(path.join(fixture.work, 'nested', 'file.txt'), 'nested\n');

      const snapshot = await capture(fixture.work);
      expect(snapshot).not.toBeNull();
      if (!snapshot) throw new Error('expected snapshot');
      try {
        expect(snapshot.contentDigest).toMatch(/^[0-9a-f]{64}$/);
        expect(snapshot.size).toBeGreaterThan(0);
        expect(snapshot.manifest.base).toBe(git(fixture.work, ['rev-parse', 'origin/main']));
        expect(snapshot.manifest.branch).toBe('main');
        expect(snapshot.manifest.deleted).toEqual(['deleted.txt']);
        expect(snapshot.manifest.partial).toBe(true);
        expect(snapshot.manifest.omitted).toContainEqual({ path: 'link', reason: 'symlink' });
        expect(snapshot.manifest.omitted).toContainEqual({ path: 'nested', reason: 'submodule' });

        const result = await applyWorktreeSnapshot({
          directory: target,
          worktreeId: 'worktree_test',
          archivePath: snapshot.archivePath,
          signal: signal(),
        });
        expect(result).toEqual({
          applied: 7,
          omitted: 2,
          conflicts: [],
          partial: true,
        });
        expect(await fs.readFile(path.join(target, 'base.txt'), 'utf8')).toBe('staged change\n');
        expect(await fs.readFile(path.join(target, 'tracked.txt'), 'utf8')).toBe(
          'unstaged change\n'
        );
        expect(await fs.readFile(path.join(target, 'committed.txt'), 'utf8')).toBe(
          'committed but unpushed\n'
        );
        expect(await fs.readFile(path.join(target, 'new.txt'), 'utf8')).toBe('untracked\n');
        expect(await fs.readFile(path.join(target, 'binary.dat'))).toEqual(
          Buffer.from([0, 1, 2, 255, 0, 10, 13])
        );
        expect((await fs.stat(path.join(target, 'tool.sh'))).mode & 0o777).toBe(0o755);
        expect((await fs.stat(path.join(target, 'base.txt'))).mode & 0o777).toBe(0o644);
        expect(
          await fs.access(path.join(target, 'deleted.txt')).then(
            () => true,
            () => false
          )
        ).toBe(false);
        expect(
          await fs.access(path.join(target, 'ignored.txt')).then(
            () => true,
            () => false
          )
        ).toBe(false);
        expect(
          await fs.access(path.join(target, '.env')).then(
            () => true,
            () => false
          )
        ).toBe(false);
        expect(
          await fs.access(path.join(target, 'link')).then(
            () => true,
            () => false
          )
        ).toBe(false);
        expect(
          await fs.access(path.join(target, 'nested')).then(
            () => true,
            () => false
          )
        ).toBe(false);
      } finally {
        await snapshot.cleanup();
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it('round-trips a path longer than the ustar name field', async () => {
    const fixture = await createFixture('snapshot-long-path-');
    const target = await clone(fixture, 'target');
    try {
      const name = `${'a'.repeat(120)}.txt`;
      await fs.writeFile(path.join(fixture.work, name), 'long path content\n');
      const snapshot = await capture(fixture.work);
      expect(snapshot).not.toBeNull();
      if (!snapshot) throw new Error('expected snapshot');
      try {
        const result = await applyWorktreeSnapshot({
          directory: target,
          worktreeId: 'worktree_test',
          archivePath: snapshot.archivePath,
          signal: signal(),
        });
        expect(result.applied).toBe(1);
        expect(await fs.readFile(path.join(target, name), 'utf8')).toBe('long path content\n');
      } finally {
        await snapshot.cleanup();
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it('reads a v1 archive with a GNU long path written by the previous implementation', async () => {
    const fixture = await createFixture('snapshot-v1-gnu-');
    const target = await clone(fixture, 'target');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'snapshot-v1-gnu-archive-'));
    try {
      const name = `${'g'.repeat(120)}.txt`;
      const archivePath = path.join(directory, 'snapshot.tar.gz');
      await fs.writeFile(
        archivePath,
        gzipSync(
          tarArchive([
            tarEntry(
              'snapshot.json',
              manifestBytes({ base: git(fixture.work, ['rev-parse', 'origin/main']) })
            ),
            tarGnuLongNameEntry(`files/${name}`, Buffer.from('legacy long path\n')),
          ])
        )
      );

      const result = await applyWorktreeSnapshot({
        directory: target,
        worktreeId: 'worktree_test',
        archivePath,
        signal: signal(),
      });
      expect(result).toEqual({ applied: 1, omitted: 0, conflicts: [], partial: false });
      expect(await fs.readFile(path.join(target, name), 'utf8')).toBe('legacy long path\n');
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
      await fixture.cleanup();
    }
  });

  it('applies an archive written by system tar', async () => {
    const fixture = await createFixture('snapshot-system-tar-');
    const target = await clone(fixture, 'target');
    const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'snapshot-system-tar-source-'));
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'snapshot-system-tar-archive-'));
    try {
      await fs.mkdir(path.join(staging, 'files'));
      await fs.mkdir(path.join(staging, 'recovery', 'stamp'), { recursive: true });
      await fs.writeFile(
        path.join(staging, 'snapshot.json'),
        manifestBytes({ base: git(fixture.work, ['rev-parse', 'origin/main']) })
      );
      await fs.writeFile(path.join(staging, 'files', 'interop.txt'), 'system tar bytes\n');
      await fs.writeFile(
        path.join(staging, 'recovery', 'stamp', 'recovered.txt'),
        'recovered bytes\n'
      );
      const archivePath = path.join(directory, 'snapshot.tar.gz');
      execFileSync('tar', [
        '-czf',
        archivePath,
        '-C',
        staging,
        'snapshot.json',
        'files/interop.txt',
        'recovery/stamp/recovered.txt',
      ]);

      const result = await applyWorktreeSnapshot({
        directory: target,
        worktreeId: 'worktree_test',
        archivePath,
        signal: signal(),
      });
      expect(result).toEqual({ applied: 1, omitted: 0, conflicts: [], partial: false });
      expect(await fs.readFile(path.join(target, 'interop.txt'), 'utf8')).toBe(
        'system tar bytes\n'
      );
      expect(
        await fs.readFile(
          path.join(target, '.git', 'kilo-recovered', 'stamp', 'recovered.txt'),
          'utf8'
        )
      ).toBe('recovered bytes\n');
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
      await fs.rm(staging, { recursive: true, force: true });
      await fixture.cleanup();
    }
  });

  it('writes an archive readable by system tar, including a PAX long path', async () => {
    const fixture = await createFixture('snapshot-system-tar-read-');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'snapshot-system-tar-read-'));
    try {
      const name = `${'p'.repeat(120)}.txt`;
      await fs.writeFile(path.join(fixture.work, name), 'long path bytes\n');
      const snapshot = await capture(fixture.work);
      expect(snapshot).not.toBeNull();
      if (!snapshot) throw new Error('expected snapshot');
      try {
        const listing = execFileSync('tar', ['-tzf', snapshot.archivePath], {
          encoding: 'utf8',
        });
        expect(listing).toContain('snapshot.json');
        expect(listing).toContain(`files/${name}`);

        execFileSync('tar', ['-xzf', snapshot.archivePath, '-C', directory]);
        expect(await fs.readFile(path.join(directory, 'files', name), 'utf8')).toBe(
          'long path bytes\n'
        );
      } finally {
        await snapshot.cleanup();
      }
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
      await fixture.cleanup();
    }
  });

  it('derives contentDigest from the timestamp-independent manifest and file bytes', async () => {
    const fixture = await createFixture('snapshot-digest-algorithm-');
    try {
      const bytes = Buffer.from('digest bytes\n');
      await fs.writeFile(path.join(fixture.work, 'base.txt'), bytes);
      const snapshot = await capture(fixture.work);
      expect(snapshot).not.toBeNull();
      if (!snapshot) throw new Error('expected snapshot');
      try {
        const { version, worktreeId, branch, base, deleted, omitted, partial } = snapshot.manifest;
        const expected = createHash('sha256');
        expected.update(
          JSON.stringify({ version, worktreeId, branch, base, deleted, omitted, partial })
        );
        expected.update(`\0file\0base.txt\0${(0o644).toString(8)}\0${bytes.length.toString(10)}\0`);
        expected.update(bytes);
        expect(snapshot.contentDigest).toBe(expected.digest('hex'));
      } finally {
        await snapshot.cleanup();
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it('produces the same digest for identical content and a new digest after a push', async () => {
    const fixture = await createFixture('snapshot-digest-');
    try {
      await fs.writeFile(path.join(fixture.work, 'base.txt'), 'same content\n');
      const first = await capture(fixture.work);
      const firstDigest = first?.contentDigest;
      await new Promise(resolve => setTimeout(resolve, 10));
      const second = await capture(fixture.work);
      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      if (!first || !second) throw new Error('expected snapshots');
      try {
        expect(second.manifest.capturedAt).not.toBe(first.manifest.capturedAt);
        expect(second.contentDigest).toBe(first.contentDigest);
        await fs.writeFile(path.join(fixture.work, 'base.txt'), 'different content\n');
        const changed = await capture(fixture.work);
        if (!changed) throw new Error('expected changed snapshot');
        try {
          expect(changed.contentDigest).not.toBe(first.contentDigest);
        } finally {
          await changed.cleanup();
        }
      } finally {
        await first.cleanup();
        await second.cleanup();
      }

      git(fixture.work, ['reset', '--hard', 'HEAD']);
      await fs.writeFile(path.join(fixture.work, 'base.txt'), 'pushed content\n');
      git(fixture.work, ['add', 'base.txt']);
      git(fixture.work, ['commit', '-m', 'push']);
      git(fixture.work, ['push', 'origin', 'main']);
      const afterPush = await capture(fixture.work);
      expect(afterPush).not.toBeNull();
      if (!afterPush) throw new Error('expected snapshot');
      try {
        expect(afterPush.manifest.base).toBe(git(fixture.work, ['rev-parse', 'HEAD']));
        expect(afterPush.contentDigest).not.toBe(firstDigest);
        expect(afterPush.manifest.deleted).toEqual([]);
        expect(afterPush.manifest.omitted).toEqual([]);
        expect(afterPush.manifest.partial).toBe(false);

        const target = await clone(fixture, 'target');
        const result = await applyWorktreeSnapshot({
          directory: target,
          worktreeId: 'worktree_test',
          archivePath: afterPush.archivePath,
          signal: signal(),
        });
        expect(result).toEqual({ applied: 0, omitted: 0, conflicts: [], partial: false });
      } finally {
        await afterPush.cleanup();
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it('uses the merge base for a never-pushed branch and detached HEAD, and refuses capture without a remote', async () => {
    const fixture = await createFixture('snapshot-base-');
    try {
      git(fixture.work, ['checkout', '-b', 'feature']);
      await fs.writeFile(path.join(fixture.work, 'feature.txt'), 'feature\n');
      const branchSnapshot = await capture(fixture.work);
      expect(branchSnapshot).not.toBeNull();
      if (!branchSnapshot) throw new Error('expected snapshot');
      try {
        expect(branchSnapshot.manifest.branch).toBe('feature');
        expect(branchSnapshot.manifest.base).toBe(git(fixture.work, ['rev-parse', 'origin/main']));
      } finally {
        await branchSnapshot.cleanup();
      }

      git(fixture.work, ['add', 'feature.txt']);
      git(fixture.work, ['commit', '-m', 'feature']);
      git(fixture.work, ['checkout', '--detach', 'HEAD']);
      const detachedSnapshot = await capture(fixture.work);
      expect(detachedSnapshot).not.toBeNull();
      if (!detachedSnapshot) throw new Error('expected detached snapshot');
      try {
        expect(detachedSnapshot.manifest.branch).toBeNull();
        expect(detachedSnapshot.manifest.base).toBe(
          git(fixture.work, ['rev-parse', 'origin/main'])
        );
      } finally {
        await detachedSnapshot.cleanup();
      }
    } finally {
      await fixture.cleanup();
    }

    const isolated = await fs.mkdtemp(path.join(os.tmpdir(), 'snapshot-no-remote-'));
    try {
      git(isolated, ['init', '-b', 'main']);
      await fs.writeFile(path.join(isolated, 'file.txt'), 'content\n');
      expect(await capture(isolated)).toBeNull();
    } finally {
      await fs.rm(isolated, { recursive: true, force: true });
    }
  });

  it('uses the merge base when the tracking ref is ahead of HEAD', async () => {
    const fixture = await createFixture('snapshot-ahead-');
    const other = await clone(fixture, 'other');
    try {
      const head = git(fixture.work, ['rev-parse', 'HEAD']);
      await fs.writeFile(path.join(other, 'upstream.txt'), 'upstream\n');
      await fs.writeFile(path.join(other, 'tracked.txt'), 'upstream edit\n');
      git(other, ['add', '.']);
      git(other, ['commit', '-m', 'upstream']);
      git(other, ['push', 'origin', 'main']);
      git(fixture.work, ['fetch', 'origin']);
      await fs.writeFile(path.join(fixture.work, 'local.txt'), 'local\n');

      const snapshot = await capture(fixture.work);
      expect(snapshot).not.toBeNull();
      if (!snapshot) throw new Error('expected snapshot');
      try {
        expect(snapshot.manifest.base).toBe(head);
        expect(snapshot.manifest.deleted).toEqual([]);
        expect(snapshot.manifest.omitted).toEqual([]);

        const target = await clone(fixture, 'target');
        const result = await applyWorktreeSnapshot({
          directory: target,
          worktreeId: 'worktree_test',
          archivePath: snapshot.archivePath,
          signal: signal(),
        });
        expect(result).toEqual({ applied: 1, omitted: 0, conflicts: [], partial: false });
        expect(await fs.readFile(path.join(target, 'local.txt'), 'utf8')).toBe('local\n');
        expect(await fs.readFile(path.join(target, 'upstream.txt'), 'utf8')).toBe('upstream\n');
        expect(await fs.readFile(path.join(target, 'tracked.txt'), 'utf8')).toBe('upstream edit\n');
      } finally {
        await snapshot.cleanup();
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it('captures unmerged paths and lists changed gitlinks as omitted submodules', async () => {
    const fixture = await createFixture('snapshot-unmerged-');
    try {
      const submoduleCommit = git(fixture.work, ['rev-parse', 'HEAD']);
      git(fixture.work, [
        'update-index',
        '--add',
        '--cacheinfo',
        `160000,${submoduleCommit},vendor/lib`,
      ]);
      git(fixture.work, ['commit', '-m', 'gitlink']);
      git(fixture.work, ['push', 'origin', 'main']);

      git(fixture.work, ['checkout', '-b', 'side']);
      await fs.writeFile(path.join(fixture.work, 'tracked.txt'), 'side\n');
      git(fixture.work, ['commit', '-m', 'side', '--', 'tracked.txt']);
      const sideCommit = git(fixture.work, ['rev-parse', 'HEAD']);
      git(fixture.work, ['checkout', 'main']);
      await fs.writeFile(path.join(fixture.work, 'tracked.txt'), 'main\n');
      git(fixture.work, ['commit', '-m', 'main', '--', 'tracked.txt']);
      expect(() =>
        execFileSync('git', ['merge', 'side'], { cwd: fixture.work, env: GIT_ENV, stdio: 'ignore' })
      ).toThrow();
      git(fixture.work, ['update-index', '--cacheinfo', `160000,${sideCommit},vendor/lib`]);

      const snapshot = await capture(fixture.work);
      expect(snapshot).not.toBeNull();
      if (!snapshot) throw new Error('expected snapshot');
      try {
        expect(snapshot.manifest.omitted).toContainEqual({
          path: 'vendor/lib',
          reason: 'submodule',
        });
        expect(snapshot.manifest.deleted).not.toContain('vendor/lib');
        expect(snapshot.manifest.deleted).not.toContain('tracked.txt');

        const target = await clone(fixture, 'target');
        const result = await applyWorktreeSnapshot({
          directory: target,
          worktreeId: 'worktree_test',
          archivePath: snapshot.archivePath,
          signal: signal(),
        });
        expect(result.conflicts).toEqual([]);
        expect(await fs.readFile(path.join(target, 'tracked.txt'), 'utf8')).toContain('<<<<<<<');
      } finally {
        await snapshot.cleanup();
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it('omits files over the per-file and total byte caps and respects the file count cap', async () => {
    const fixture = await createFixture('snapshot-caps-');
    try {
      await fs.writeFile(path.join(fixture.work, 'too-large.bin'), Buffer.alloc(40));
      const limited = await captureWorktreeSnapshotWithLimits(
        { directory: fixture.work, worktreeId: 'worktree_test', signal: signal() },
        { ...LIMITS, fileBytes: 20, totalBytes: 20 }
      );
      expect(limited).not.toBeNull();
      if (!limited) throw new Error('expected snapshot');
      try {
        expect(limited.manifest.omitted).toContainEqual({
          path: 'too-large.bin',
          reason: 'too_large',
        });
        expect(limited.manifest.partial).toBe(true);
      } finally {
        await limited.cleanup();
      }

      await fs.unlink(path.join(fixture.work, 'too-large.bin'));
      for (const name of ['a.txt', 'b.txt', 'c.txt']) {
        await fs.writeFile(path.join(fixture.work, name), '0123456789');
      }
      const total = await captureWorktreeSnapshotWithLimits(
        { directory: fixture.work, worktreeId: 'worktree_test', signal: signal() },
        { ...LIMITS, totalBytes: 15 }
      );
      expect(total).not.toBeNull();
      if (!total) throw new Error('expected total snapshot');
      try {
        expect(total.manifest.omitted).toContainEqual({
          path: 'b.txt',
          reason: 'budget_exhausted',
        });
        expect(total.manifest.omitted).toContainEqual({
          path: 'c.txt',
          reason: 'budget_exhausted',
        });
      } finally {
        await total.cleanup();
      }

      const count = await captureWorktreeSnapshotWithLimits(
        { directory: fixture.work, worktreeId: 'worktree_test', signal: signal() },
        { ...LIMITS, files: 1 }
      );
      expect(count).not.toBeNull();
      if (!count) throw new Error('expected count snapshot');
      try {
        expect(count.manifest.omitted).toEqual([
          { path: 'b.txt', reason: 'file_limit' },
          { path: 'c.txt', reason: 'file_limit' },
        ]);
      } finally {
        await count.cleanup();
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it('keeps an unsafe omitted path display-only so the snapshot still applies', async () => {
    const fixture = await createFixture('snapshot-omitted-unsafe-');
    const target = await clone(fixture, 'target');
    try {
      const unsafeName = 'a\\b.txt';
      await fs.writeFile(path.join(fixture.work, unsafeName), 'unsafe\n');
      await fs.writeFile(path.join(fixture.work, 'safe.txt'), 'safe\n');
      const snapshot = await capture(fixture.work);
      expect(snapshot).not.toBeNull();
      if (!snapshot) throw new Error('expected snapshot');
      try {
        expect(snapshot.manifest.omitted).toContainEqual({
          path: unsafeName,
          reason: 'unsafe_path',
        });
        expect(snapshot.manifest.partial).toBe(true);
        const result = await applyWorktreeSnapshot({
          directory: target,
          worktreeId: 'worktree_test',
          archivePath: snapshot.archivePath,
          signal: signal(),
        });
        expect(result).toEqual({ applied: 1, omitted: 1, conflicts: [], partial: true });
        expect(await fs.readFile(path.join(target, 'safe.txt'), 'utf8')).toBe('safe\n');
        expect(
          await fs.access(path.join(target, unsafeName)).then(
            () => true,
            () => false
          )
        ).toBe(false);
      } finally {
        await snapshot.cleanup();
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it('caps the deletion list and omits the remainder', async () => {
    const fixture = await createFixture('snapshot-deletion-cap-');
    try {
      for (const name of ['d1.txt', 'd2.txt', 'd3.txt']) {
        await fs.writeFile(path.join(fixture.work, name), `${name}\n`);
      }
      git(fixture.work, ['add', '.']);
      git(fixture.work, ['commit', '-m', 'deletions']);
      git(fixture.work, ['push', 'origin', 'main']);
      for (const name of ['d1.txt', 'd2.txt', 'd3.txt']) {
        await fs.unlink(path.join(fixture.work, name));
      }

      const snapshot = await captureWorktreeSnapshotWithLimits(
        { directory: fixture.work, worktreeId: 'worktree_test', signal: signal() },
        { ...LIMITS, files: 2 }
      );
      expect(snapshot).not.toBeNull();
      if (!snapshot) throw new Error('expected snapshot');
      try {
        expect(snapshot.manifest.deleted).toEqual(['d1.txt', 'd2.txt']);
        expect(snapshot.manifest.omitted).toContainEqual({
          path: 'd3.txt',
          reason: 'file_limit',
        });
        expect(snapshot.manifest.partial).toBe(true);

        const target = await clone(fixture, 'target');
        const result = await applyWorktreeSnapshot({
          directory: target,
          worktreeId: 'worktree_test',
          archivePath: snapshot.archivePath,
          signal: signal(),
        });
        expect(result.applied).toBe(2);
        expect(result.omitted).toBe(1);
        expect(result.conflicts).toEqual([]);
        expect(
          await fs.access(path.join(target, 'd1.txt')).then(
            () => true,
            () => false
          )
        ).toBe(false);
        expect(
          await fs.access(path.join(target, 'd2.txt')).then(
            () => true,
            () => false
          )
        ).toBe(false);
        expect(await fs.readFile(path.join(target, 'd3.txt'), 'utf8')).toBe('d3.txt\n');
      } finally {
        await snapshot.cleanup();
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it('bounds the manifest and trims omission details to the configured limit', async () => {
    const fixture = await createFixture('snapshot-manifest-cap-');
    const target = await clone(fixture, 'target');
    try {
      for (let index = 0; index < 15; index += 1) {
        await fs.symlink(
          'base.txt',
          path.join(fixture.work, `omitted-link-${index.toString().padStart(2, '0')}.txt`)
        );
      }
      await fs.writeFile(path.join(fixture.work, 'kept.txt'), 'kept\n');

      const snapshot = await captureWorktreeSnapshotWithLimits(
        { directory: fixture.work, worktreeId: 'worktree_test', signal: signal() },
        { ...LIMITS, manifestBytes: 700 }
      );
      expect(snapshot).not.toBeNull();
      if (!snapshot) throw new Error('expected snapshot');
      try {
        expect(Buffer.byteLength(JSON.stringify(snapshot.manifest))).toBeLessThanOrEqual(700);
        expect(snapshot.manifest.partial).toBe(true);
        const result = await applyWorktreeSnapshot({
          directory: target,
          worktreeId: 'worktree_test',
          archivePath: snapshot.archivePath,
          signal: signal(),
        });
        expect(result.applied).toBe(1);
        expect(result.conflicts).toEqual([]);
        expect(await fs.readFile(path.join(target, 'kept.txt'), 'utf8')).toBe('kept\n');
      } finally {
        await snapshot.cleanup();
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it('bounds uncompressed tar size including headers, padding and long names', async () => {
    const fixture = await createFixture('snapshot-uncompressed-cap-');
    const target = await clone(fixture, 'target');
    try {
      const names = [`${'n'.repeat(120)}-a.txt`, `${'n'.repeat(120)}-b.txt`].sort();
      for (const name of names) {
        await fs.writeFile(path.join(fixture.work, name), 'x'.repeat(50));
      }
      const snapshot = await captureWorktreeSnapshotWithLimits(
        { directory: fixture.work, worktreeId: 'worktree_test', signal: signal() },
        { ...LIMITS, manifestBytes: 2048, uncompressedBytes: 6600 }
      );
      expect(snapshot).not.toBeNull();
      if (!snapshot) throw new Error('expected snapshot');
      try {
        expect(snapshot.manifest.partial).toBe(true);
        expect(snapshot.manifest.omitted.some(entry => entry.reason === 'budget_exhausted')).toBe(
          true
        );
        const result = await applyWorktreeSnapshot({
          directory: target,
          worktreeId: 'worktree_test',
          archivePath: snapshot.archivePath,
          signal: signal(),
        });
        expect(result.applied).toBe(1);
        expect(result.conflicts).toEqual([]);
        expect(await fs.readFile(path.join(target, names[0]), 'utf8')).toBe('x'.repeat(50));
        expect(
          await fs.access(path.join(target, names[1])).then(
            () => true,
            () => false
          )
        ).toBe(false);
      } finally {
        await snapshot.cleanup();
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it('captures retained bytes after git rm --cached instead of recording a deletion', async () => {
    const fixture = await createFixture('snapshot-rm-cached-');
    const target = await clone(fixture, 'target');
    try {
      git(fixture.work, ['rm', '--cached', 'tracked.txt']);
      await fs.writeFile(path.join(fixture.work, 'tracked.txt'), 'retained after rm cached\n');
      const snapshot = await capture(fixture.work);
      expect(snapshot).not.toBeNull();
      if (!snapshot) throw new Error('expected snapshot');
      try {
        expect(snapshot.manifest.deleted).not.toContain('tracked.txt');
        expect(snapshot.manifest.omitted).not.toContainEqual({
          path: 'tracked.txt',
          reason: 'inconsistent',
        });
        const result = await applyWorktreeSnapshot({
          directory: target,
          worktreeId: 'worktree_test',
          archivePath: snapshot.archivePath,
          signal: signal(),
        });
        expect(result.conflicts).toEqual([]);
        expect(await fs.readFile(path.join(target, 'tracked.txt'), 'utf8')).toBe(
          'retained after rm cached\n'
        );
      } finally {
        await snapshot.cleanup();
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it('captures an ignored file kept on disk after git rm --cached instead of deleting it', async () => {
    const fixture = await createFixture('snapshot-rm-cached-ignored-');
    const target = await clone(fixture, 'target');
    try {
      await fs.writeFile(path.join(fixture.work, '.git', 'info', 'exclude'), 'tracked.txt\n');
      git(fixture.work, ['rm', '--cached', 'tracked.txt']);
      await fs.writeFile(path.join(fixture.work, 'tracked.txt'), 'ignored but retained\n');
      const snapshot = await capture(fixture.work);
      expect(snapshot).not.toBeNull();
      if (!snapshot) throw new Error('expected snapshot');
      try {
        expect(snapshot.manifest.deleted).not.toContain('tracked.txt');
        const result = await applyWorktreeSnapshot({
          directory: target,
          worktreeId: 'worktree_test',
          archivePath: snapshot.archivePath,
          signal: signal(),
        });
        expect(result.conflicts).toEqual([]);
        expect(await fs.readFile(path.join(target, 'tracked.txt'), 'utf8')).toBe(
          'ignored but retained\n'
        );
      } finally {
        await snapshot.cleanup();
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it('captures a regular file that replaces a gitlink', async () => {
    const fixture = await createFixture('snapshot-gitlink-file-');
    try {
      const submoduleCommit = git(fixture.work, ['rev-parse', 'HEAD']);
      git(fixture.work, [
        'update-index',
        '--add',
        '--cacheinfo',
        `160000,${submoduleCommit},vendor/lib`,
      ]);
      git(fixture.work, ['commit', '-m', 'gitlink']);
      git(fixture.work, ['push', 'origin', 'main']);
      git(fixture.work, ['rm', '--cached', 'vendor/lib']);
      await fs.rm(path.join(fixture.work, 'vendor', 'lib'), { recursive: true, force: true });
      await fs.mkdir(path.join(fixture.work, 'vendor'), { recursive: true });
      await fs.writeFile(path.join(fixture.work, 'vendor', 'lib'), 'now a file\n');
      git(fixture.work, ['add', 'vendor/lib']);

      const snapshot = await capture(fixture.work);
      expect(snapshot).not.toBeNull();
      if (!snapshot) throw new Error('expected snapshot');
      try {
        expect(snapshot.manifest.omitted).not.toContainEqual({
          path: 'vendor/lib',
          reason: 'submodule',
        });
        expect(snapshot.manifest.deleted).not.toContain('vendor/lib');
        expect(snapshot.manifest.partial).toBe(false);
      } finally {
        await snapshot.cleanup();
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it('ignores injected git environment overrides', async () => {
    const fixture = await createFixture('snapshot-git-env-');
    const target = await clone(fixture, 'target');
    try {
      await fs.writeFile(path.join(fixture.work, 'base.txt'), 'captured from worktree\n');
      const previous = {
        GIT_DIR: process.env.GIT_DIR,
        GIT_WORK_TREE: process.env.GIT_WORK_TREE,
        GIT_INDEX_FILE: process.env.GIT_INDEX_FILE,
      };
      process.env.GIT_DIR = fixture.origin;
      process.env.GIT_WORK_TREE = fixture.origin;
      process.env.GIT_INDEX_FILE = path.join(fixture.base, 'injected.index');
      try {
        const snapshot = await captureWorktreeSnapshotWithLimits(
          { directory: fixture.work, worktreeId: 'worktree_test', signal: signal() },
          LIMITS
        );
        expect(snapshot).not.toBeNull();
        if (!snapshot) throw new Error('expected snapshot');
        try {
          expect(snapshot.manifest.base).toBe(git(fixture.work, ['rev-parse', 'origin/main']));
          const result = await applyWorktreeSnapshot({
            directory: target,
            worktreeId: 'worktree_test',
            archivePath: snapshot.archivePath,
            signal: signal(),
          });
          expect(result.conflicts).toEqual([]);
          expect(await fs.readFile(path.join(target, 'base.txt'), 'utf8')).toBe(
            'captured from worktree\n'
          );
        } finally {
          await snapshot.cleanup();
        }
      } finally {
        for (const [name, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it('captures and restores 50 MiB of incompressible files within the bounds', async () => {
    const fixture = await createFixture('snapshot-benchmark-');
    try {
      const expectedDigests = new Map<string, string>();
      for (let index = 0; index < 5; index += 1) {
        const name = `large-${index}.bin`;
        const bytes = randomBytes(10 * 1024 * 1024);
        expectedDigests.set(name, createHash('sha256').update(bytes).digest('hex'));
        await fs.writeFile(path.join(fixture.work, name), bytes);
      }
      const startedAt = Date.now();
      const snapshot = await capture(fixture.work);
      const elapsed = Date.now() - startedAt;
      expect(snapshot).not.toBeNull();
      if (!snapshot) throw new Error('expected snapshot');
      try {
        expect(snapshot.manifest.partial).toBe(false);
        expect(snapshot.manifest.omitted).toEqual([]);
        expect(elapsed).toBeLessThan(20_000);
        expect(snapshot.size).toBeGreaterThan(50 * 1024 * 1024);
        const target = await clone(fixture, 'target');
        const restoreStartedAt = Date.now();
        const restored = await applyWorktreeSnapshot({
          directory: target,
          worktreeId: 'worktree_test',
          archivePath: snapshot.archivePath,
          signal: signal(),
        });
        const restoreElapsed = Date.now() - restoreStartedAt;
        expect(restored).toMatchObject({ applied: 5, omitted: 0, conflicts: [], partial: false });
        expect(restoreElapsed).toBeLessThan(60_000);
        for (const [name, digest] of expectedDigests) {
          const actual = await fs.readFile(path.join(target, name));
          expect(createHash('sha256').update(actual).digest('hex')).toBe(digest);
        }
        console.info(
          `worktree snapshot benchmark bytes=${snapshot.size} captureMs=${elapsed} restoreMs=${restoreElapsed}`
        );
      } finally {
        await snapshot.cleanup();
      }
    } finally {
      await fixture.cleanup();
    }
  }, 120_000);

  it('captures and restores 3000 small files from a fresh clone with bounded git commands', async () => {
    const fixture = await createFixture('snapshot-many-small-');
    const fileCount = 3000;
    try {
      const directory = path.join(fixture.work, 'small');
      await fs.mkdir(directory);
      for (let index = 0; index < fileCount; index += 1) {
        await fs.writeFile(
          path.join(directory, `${String(index).padStart(4, '0')}.txt`),
          `file ${index}\n`
        );
      }

      const captureStartedAt = Date.now();
      const captured = await countGitCommands(() => capture(fixture.work));
      const captureElapsed = Date.now() - captureStartedAt;
      const snapshot = captured.result;
      expect(snapshot).not.toBeNull();
      if (!snapshot) throw new Error('expected snapshot');
      try {
        expect(snapshot.manifest.partial).toBe(false);
        expect(snapshot.manifest.omitted).toEqual([]);
        expect(snapshot.manifest.deleted).toEqual([]);
        expect(captured.commands).toBeLessThanOrEqual(10);

        git(fixture.work, ['add', '-A']);
        git(fixture.work, ['commit', '-m', 'push small files']);
        git(fixture.work, ['push', 'origin', 'main']);
        const target = await clone(fixture, 'target');

        const restoreStartedAt = Date.now();
        const restored = await countGitCommands(() =>
          applyWorktreeSnapshot({
            directory: target,
            worktreeId: 'worktree_test',
            archivePath: snapshot.archivePath,
            signal: signal(),
          })
        );
        const restoreElapsed = Date.now() - restoreStartedAt;
        expect(restored.result).toEqual({
          applied: 0,
          omitted: 0,
          conflicts: [],
          partial: false,
        });
        expect(restored.commands).toBeLessThanOrEqual(8);
        expect(restored.commands * 100).toBeLessThan(fileCount);
        expect(await fs.readFile(path.join(target, 'small', '0000.txt'), 'utf8')).toBe('file 0\n');
        expect(await fs.readFile(path.join(target, 'small', '2999.txt'), 'utf8')).toBe(
          'file 2999\n'
        );
        console.info(
          `worktree snapshot many-small benchmark files=${fileCount} bytes=${snapshot.size} captureMs=${captureElapsed} captureGitCommands=${captured.commands} restoreMs=${restoreElapsed} restoreGitCommands=${restored.commands}`
        );
      } finally {
        await snapshot.cleanup();
      }
    } finally {
      await fixture.cleanup();
    }
  }, 180_000);

  it('refuses unsafe or over-limit recovery payloads instead of dropping them', async () => {
    const fixture = await createFixture('snapshot-recovery-unsafe-');
    try {
      const recovery = path.join(fixture.work, '.git', 'kilo-recovered', 'stamp');
      await fs.mkdir(recovery, { recursive: true });
      await fs.symlink('../../config', path.join(recovery, 'link'));
      await expectFailure(capture(fixture.work), /recovery/);
      await fs.unlink(path.join(recovery, 'link'));

      await fs.writeFile(path.join(recovery, 'a.bin'), Buffer.alloc(40));
      await fs.writeFile(path.join(recovery, 'b.bin'), Buffer.alloc(40));
      await expectFailure(
        captureWorktreeSnapshotWithLimits(
          { directory: fixture.work, worktreeId: 'worktree_test', signal: signal() },
          { ...LIMITS, fileBytes: 32 }
        ),
        /recovery/
      );
      await expectFailure(
        captureWorktreeSnapshotWithLimits(
          { directory: fixture.work, worktreeId: 'worktree_test', signal: signal() },
          { ...LIMITS, totalBytes: 50 }
        ),
        /recovery/
      );
      await expectFailure(
        captureWorktreeSnapshotWithLimits(
          { directory: fixture.work, worktreeId: 'worktree_test', signal: signal() },
          { ...LIMITS, files: 1 }
        ),
        /recovery/
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('keeps recovery payloads when ordinary files exhaust the total byte budget', async () => {
    const fixture = await createFixture('snapshot-recovery-priority-');
    try {
      const recovery = path.join(fixture.work, '.git', 'kilo-recovered', 'stamp');
      await fs.mkdir(recovery, { recursive: true });
      await fs.writeFile(path.join(recovery, 'conflict.txt'), 'conflict10');
      await fs.writeFile(path.join(fixture.work, 'new.txt'), 'newfile010');

      const snapshot = await captureWorktreeSnapshotWithLimits(
        { directory: fixture.work, worktreeId: 'worktree_test', signal: signal() },
        { ...LIMITS, totalBytes: 15 }
      );
      expect(snapshot).not.toBeNull();
      if (!snapshot) throw new Error('expected snapshot');
      try {
        expect(snapshot.manifest.omitted).toEqual([
          { path: 'new.txt', reason: 'budget_exhausted' },
        ]);
        expect(snapshot.manifest.partial).toBe(true);

        const target = await clone(fixture, 'target');
        const result = await applyWorktreeSnapshot({
          directory: target,
          worktreeId: 'worktree_test',
          archivePath: snapshot.archivePath,
          signal: signal(),
        });
        expect(result).toEqual({ applied: 0, omitted: 1, conflicts: [], partial: true });
        expect(
          await fs.readFile(
            path.join(target, '.git', 'kilo-recovered', 'stamp', 'conflict.txt'),
            'utf8'
          )
        ).toBe('conflict10');
        expect(
          await fs.access(path.join(target, 'new.txt')).then(
            () => true,
            () => false
          )
        ).toBe(false);
      } finally {
        await snapshot.cleanup();
      }
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('worktree snapshot apply', () => {
  it('writes untouched paths, skips already-pushed paths and records conflicts', async () => {
    const fixture = await createFixture('snapshot-ancestor-');
    try {
      await fs.writeFile(path.join(fixture.work, 'a.txt'), 'base a\n');
      await fs.writeFile(path.join(fixture.work, 'b.txt'), 'base b\n');
      await fs.writeFile(path.join(fixture.work, 'c.txt'), 'base c\n');
      git(fixture.work, ['add', '.']);
      git(fixture.work, ['commit', '-m', 'add ancestry files']);
      git(fixture.work, ['push', 'origin', 'main']);
      const base = git(fixture.work, ['rev-parse', 'HEAD']);

      await fs.writeFile(path.join(fixture.work, 'a.txt'), 'snapshot a\n');
      await fs.writeFile(path.join(fixture.work, 'b.txt'), 'pushed b\n');
      await fs.writeFile(path.join(fixture.work, 'c.txt'), 'snapshot c\n');
      await fs.unlink(path.join(fixture.work, 'deleted.txt'));
      const snapshot = await capture(fixture.work);
      expect(snapshot).not.toBeNull();
      if (!snapshot) throw new Error('expected snapshot');
      try {
        const target = await clone(fixture, 'target');
        await fs.writeFile(path.join(target, 'b.txt'), 'pushed b\n');
        await fs.writeFile(path.join(target, 'c.txt'), 'different c\n');
        await fs.unlink(path.join(target, 'deleted.txt'));
        git(target, ['add', '-A']);
        git(target, ['commit', '-m', 'diverged']);
        expect(git(target, ['rev-parse', 'HEAD'])).not.toBe(base);

        const result = await applyWorktreeSnapshot({
          directory: target,
          worktreeId: 'worktree_test',
          archivePath: snapshot.archivePath,
          signal: signal(),
        });
        expect(result.applied).toBe(1);
        expect(result.conflicts).toEqual(['c.txt']);
        expect(result.omitted).toBe(0);
        expect(result.partial).toBe(false);
        expect(await fs.readFile(path.join(target, 'a.txt'), 'utf8')).toBe('snapshot a\n');
        expect(await fs.readFile(path.join(target, 'b.txt'), 'utf8')).toBe('pushed b\n');
        expect(await fs.readFile(path.join(target, 'c.txt'), 'utf8')).toBe('different c\n');
        expect(
          await fs.readFile(
            path.join(
              target,
              '.git',
              'kilo-recovered',
              sanitizedTimestamp(snapshot.manifest.capturedAt),
              'c.txt'
            ),
            'utf8'
          )
        ).toBe('snapshot c\n');
        expect(
          await fs.access(path.join(target, 'deleted.txt')).then(
            () => true,
            () => false
          )
        ).toBe(false);
      } finally {
        await snapshot.cleanup();
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it('removes a preparation-recreated file when the captured deletion was pushed upstream', async () => {
    const fixture = await createFixture('snapshot-pushed-deletion-');
    try {
      await fs.unlink(path.join(fixture.work, 'deleted.txt'));
      const snapshot = await capture(fixture.work);
      expect(snapshot).not.toBeNull();
      if (!snapshot) throw new Error('expected snapshot');
      try {
        expect(snapshot.manifest.deleted).toEqual(['deleted.txt']);
        git(fixture.work, ['add', '-A']);
        git(fixture.work, ['commit', '-m', 'push deletion']);
        git(fixture.work, ['push', 'origin', 'main']);

        const target = await clone(fixture, 'target');
        expect(
          await fs.access(path.join(target, 'deleted.txt')).then(
            () => true,
            () => false
          )
        ).toBe(false);
        await fs.writeFile(path.join(target, 'deleted.txt'), 'recreated by preparation\n');

        const result = await applyWorktreeSnapshot({
          directory: target,
          worktreeId: 'worktree_test',
          archivePath: snapshot.archivePath,
          signal: signal(),
        });
        expect(result).toEqual({ applied: 1, omitted: 0, conflicts: [], partial: false });
        expect(
          await fs.access(path.join(target, 'deleted.txt')).then(
            () => true,
            () => false
          )
        ).toBe(false);

        const repeated = await applyWorktreeSnapshot({
          directory: target,
          worktreeId: 'worktree_test',
          archivePath: snapshot.archivePath,
          signal: signal(),
        });
        expect(repeated).toEqual({ applied: 0, omitted: 0, conflicts: [], partial: false });
      } finally {
        await snapshot.cleanup();
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it('preserves an upstream modification of a path captured as deleted', async () => {
    const fixture = await createFixture('snapshot-pushed-deletion-modified-');
    try {
      await fs.unlink(path.join(fixture.work, 'deleted.txt'));
      const snapshot = await capture(fixture.work);
      expect(snapshot).not.toBeNull();
      if (!snapshot) throw new Error('expected snapshot');
      try {
        expect(snapshot.manifest.deleted).toEqual(['deleted.txt']);
        const upstream = await clone(fixture, 'upstream');
        await fs.writeFile(path.join(upstream, 'deleted.txt'), 'upstream modification\n');
        git(upstream, ['commit', '-am', 'keep modified']);
        git(upstream, ['push', 'origin', 'main']);

        const target = await clone(fixture, 'target');
        const result = await applyWorktreeSnapshot({
          directory: target,
          worktreeId: 'worktree_test',
          archivePath: snapshot.archivePath,
          signal: signal(),
        });
        expect(result).toEqual({
          applied: 0,
          omitted: 0,
          conflicts: ['deleted.txt'],
          partial: false,
        });
        expect(await fs.readFile(path.join(target, 'deleted.txt'), 'utf8')).toBe(
          'upstream modification\n'
        );
      } finally {
        await snapshot.cleanup();
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it('carries recovered conflict payloads into the next snapshot across a second recycle', async () => {
    const fixture = await createFixture('snapshot-recovery-cycle-');
    const upstream = await clone(fixture, 'upstream');
    try {
      await fs.writeFile(path.join(fixture.work, 'tracked.txt'), 'snapshot conflict bytes\n');
      const first = await capture(fixture.work);
      expect(first).not.toBeNull();
      if (!first) throw new Error('expected snapshot');
      try {
        await fs.writeFile(path.join(upstream, 'tracked.txt'), 'advanced upstream bytes\n');
        git(upstream, ['commit', '-am', 'advance']);
        git(upstream, ['push', 'origin', 'main']);
        const advanced = git(upstream, ['rev-parse', 'HEAD']);

        const firstTarget = await clone(fixture, 'target-one');
        const firstApply = await applyWorktreeSnapshot({
          directory: firstTarget,
          worktreeId: 'worktree_test',
          archivePath: first.archivePath,
          signal: signal(),
        });
        expect(firstApply).toEqual({
          applied: 0,
          omitted: 0,
          conflicts: ['tracked.txt'],
          partial: false,
        });
        const recovered = path.join(
          firstTarget,
          '.git',
          'kilo-recovered',
          sanitizedTimestamp(first.manifest.capturedAt),
          'tracked.txt'
        );
        expect(await fs.readFile(recovered, 'utf8')).toBe('snapshot conflict bytes\n');
        expect(await fs.readFile(path.join(firstTarget, 'tracked.txt'), 'utf8')).toBe(
          'advanced upstream bytes\n'
        );

        await fs.writeFile(path.join(firstTarget, 'new-edit.txt'), 'new edit after recycle\n');
        const second = await capture(firstTarget);
        expect(second).not.toBeNull();
        if (!second) throw new Error('expected second snapshot');
        try {
          expect(second.manifest.base).toBe(advanced);
          expect(second.manifest.deleted).toEqual([]);
          expect(second.manifest.omitted).toEqual([]);
          expect(second.manifest.partial).toBe(false);

          const secondTarget = await clone(fixture, 'target-two');
          const secondApply = await applyWorktreeSnapshot({
            directory: secondTarget,
            worktreeId: 'worktree_test',
            archivePath: second.archivePath,
            signal: signal(),
          });
          expect(secondApply).toEqual({
            applied: 1,
            omitted: 0,
            conflicts: [],
            partial: false,
          });
          expect(await fs.readFile(path.join(secondTarget, 'new-edit.txt'), 'utf8')).toBe(
            'new edit after recycle\n'
          );
          expect(
            await fs.readFile(
              path.join(
                secondTarget,
                '.git',
                'kilo-recovered',
                sanitizedTimestamp(first.manifest.capturedAt),
                'tracked.txt'
              ),
              'utf8'
            )
          ).toBe('snapshot conflict bytes\n');
          expect(await fs.readFile(path.join(secondTarget, 'tracked.txt'), 'utf8')).toBe(
            'advanced upstream bytes\n'
          );
        } finally {
          await second.cleanup();
        }
      } finally {
        await first.cleanup();
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it('restores saved bytes when preparation changes or removes a file whose HEAD content matches', async () => {
    const fixture = await createFixture('snapshot-setup-replay-');
    try {
      await fs.writeFile(path.join(fixture.work, 'tracked.txt'), 'saved tracked bytes\n');
      await fs.writeFile(path.join(fixture.work, 'base.txt'), 'saved base bytes\n');
      const snapshot = await capture(fixture.work);
      expect(snapshot).not.toBeNull();
      if (!snapshot) throw new Error('expected snapshot');
      try {
        git(fixture.work, ['add', '.']);
        git(fixture.work, ['commit', '-m', 'push snapshot bytes']);
        git(fixture.work, ['push', 'origin', 'main']);

        const target = await clone(fixture, 'target');
        await fs.writeFile(path.join(target, 'tracked.txt'), 'setup replay bytes\n');
        await fs.unlink(path.join(target, 'base.txt'));

        const result = await applyWorktreeSnapshot({
          directory: target,
          worktreeId: 'worktree_test',
          archivePath: snapshot.archivePath,
          signal: signal(),
        });
        expect(result).toEqual({ applied: 2, omitted: 0, conflicts: [], partial: false });
        expect(await fs.readFile(path.join(target, 'tracked.txt'), 'utf8')).toBe(
          'saved tracked bytes\n'
        );
        expect(await fs.readFile(path.join(target, 'base.txt'), 'utf8')).toBe('saved base bytes\n');
      } finally {
        await snapshot.cleanup();
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it('restores executable mode and replaces a symlink when HEAD content already matches', async () => {
    const fixture = await createFixture('snapshot-setup-modes-');
    try {
      await fs.writeFile(path.join(fixture.work, 'tool.sh'), '#!/bin/sh\necho saved\n');
      chmodSync(path.join(fixture.work, 'tool.sh'), 0o755);
      await fs.writeFile(path.join(fixture.work, 'data.txt'), 'saved data\n');
      const snapshot = await capture(fixture.work);
      expect(snapshot).not.toBeNull();
      if (!snapshot) throw new Error('expected snapshot');
      try {
        git(fixture.work, ['add', '.']);
        git(fixture.work, ['commit', '-m', 'push snapshot bytes']);
        git(fixture.work, ['push', 'origin', 'main']);

        const target = await clone(fixture, 'target');
        await fs.chmod(path.join(target, 'tool.sh'), 0o644);
        await fs.unlink(path.join(target, 'data.txt'));
        await fs.symlink('tool.sh', path.join(target, 'data.txt'));

        const result = await applyWorktreeSnapshot({
          directory: target,
          worktreeId: 'worktree_test',
          archivePath: snapshot.archivePath,
          signal: signal(),
        });
        expect(result).toEqual({ applied: 2, omitted: 0, conflicts: [], partial: false });
        expect((await fs.stat(path.join(target, 'tool.sh'))).mode & 0o777).toBe(0o755);
        const restored = await fs.lstat(path.join(target, 'data.txt'));
        expect(restored.isFile()).toBe(true);
        expect(restored.isSymbolicLink()).toBe(false);
        expect(await fs.readFile(path.join(target, 'data.txt'), 'utf8')).toBe('saved data\n');
      } finally {
        await snapshot.cleanup();
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it('records a conflict when HEAD changes the executable mode of matching bytes', async () => {
    const fixture = await createFixture('snapshot-head-mode-');
    try {
      await fs.writeFile(path.join(fixture.work, 'tool.sh'), '#!/bin/sh\necho saved\n');
      chmodSync(path.join(fixture.work, 'tool.sh'), 0o755);
      const snapshot = await capture(fixture.work);
      expect(snapshot).not.toBeNull();
      if (!snapshot) throw new Error('expected snapshot');
      try {
        git(fixture.work, ['add', 'tool.sh']);
        git(fixture.work, ['update-index', '--chmod=-x', 'tool.sh']);
        git(fixture.work, ['commit', '-m', 'push non executable']);
        git(fixture.work, ['push', 'origin', 'main']);

        const target = await clone(fixture, 'target');
        const result = await applyWorktreeSnapshot({
          directory: target,
          worktreeId: 'worktree_test',
          archivePath: snapshot.archivePath,
          signal: signal(),
        });
        expect(result).toEqual({ applied: 0, omitted: 0, conflicts: ['tool.sh'], partial: false });
        expect((await fs.stat(path.join(target, 'tool.sh'))).mode & 0o777).toBe(0o644);
        const recovered = path.join(
          target,
          '.git',
          'kilo-recovered',
          sanitizedTimestamp(snapshot.manifest.capturedAt),
          'tool.sh'
        );
        expect((await fs.stat(recovered)).mode & 0o777).toBe(0o755);
        expect(await fs.readFile(recovered, 'utf8')).toBe('#!/bin/sh\necho saved\n');
      } finally {
        await snapshot.cleanup();
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it('treats a missing base commit as a conflict for every file', async () => {
    const fixture = await createFixture('snapshot-missing-base-');
    try {
      await fs.writeFile(path.join(fixture.work, 'base.txt'), 'snapshot value\n');
      const snapshot = await capture(fixture.work);
      expect(snapshot).not.toBeNull();
      if (!snapshot) throw new Error('expected snapshot');
      try {
        const target = await fs.mkdtemp(path.join(os.tmpdir(), 'snapshot-unrelated-'));
        try {
          git(target, ['init', '-b', 'main']);
          await fs.writeFile(path.join(target, 'unrelated.txt'), 'unrelated\n');
          git(target, ['add', 'unrelated.txt']);
          git(target, ['commit', '-m', 'unrelated']);

          const result = await applyWorktreeSnapshot({
            directory: target,
            worktreeId: 'worktree_test',
            archivePath: snapshot.archivePath,
            signal: signal(),
          });
          expect(result.applied).toBe(0);
          expect(result.conflicts).toEqual(['base.txt']);
        } finally {
          await fs.rm(target, { recursive: true, force: true });
        }
      } finally {
        await snapshot.cleanup();
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it('treats a rewritten history as a conflict for every file', async () => {
    const fixture = await createFixture('snapshot-force-');
    try {
      await fs.writeFile(path.join(fixture.work, 'base.txt'), 'snapshot value\n');
      const snapshot = await capture(fixture.work);
      expect(snapshot).not.toBeNull();
      if (!snapshot) throw new Error('expected snapshot');
      try {
        const target = await clone(fixture, 'target');
        git(target, ['checkout', '--orphan', 'rewritten']);
        git(target, ['rm', '-rf', '.']);
        await fs.writeFile(path.join(target, 'unrelated.txt'), 'unrelated\n');
        git(target, ['add', 'unrelated.txt']);
        git(target, ['commit', '-m', 'rewritten']);

        const result = await applyWorktreeSnapshot({
          directory: target,
          worktreeId: 'worktree_test',
          archivePath: snapshot.archivePath,
          signal: signal(),
        });
        expect(result.applied).toBe(0);
        expect(result.conflicts).toEqual(['base.txt']);
        expect(
          await fs.access(path.join(target, 'base.txt')).then(
            () => true,
            () => false
          )
        ).toBe(false);
        expect(
          await fs.readFile(
            path.join(
              target,
              '.git',
              'kilo-recovered',
              sanitizedTimestamp(snapshot.manifest.capturedAt),
              'base.txt'
            ),
            'utf8'
          )
        ).toBe('snapshot value\n');
      } finally {
        await snapshot.cleanup();
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it('applies a deletion before files that replace the deleted path', async () => {
    const fixture = await createFixture('snapshot-file-to-dir-');
    try {
      await fs.writeFile(path.join(fixture.work, 'cfg'), 'base file\n');
      git(fixture.work, ['add', 'cfg']);
      git(fixture.work, ['commit', '-m', 'base file']);
      git(fixture.work, ['push', 'origin', 'main']);

      git(fixture.work, ['rm', 'cfg']);
      await fs.mkdir(path.join(fixture.work, 'cfg'));
      await fs.writeFile(path.join(fixture.work, 'cfg', 'a.txt'), 'inside\n');
      const snapshot = await capture(fixture.work);
      expect(snapshot).not.toBeNull();
      if (!snapshot) throw new Error('expected snapshot');
      try {
        expect(snapshot.manifest.deleted).toContain('cfg');
        const target = await clone(fixture, 'target');
        const result = await applyWorktreeSnapshot({
          directory: target,
          worktreeId: 'worktree_test',
          archivePath: snapshot.archivePath,
          signal: signal(),
        });
        expect(result.applied).toBe(2);
        expect(result.conflicts).toEqual([]);
        expect((await fs.lstat(path.join(target, 'cfg'))).isDirectory()).toBe(true);
        expect(await fs.readFile(path.join(target, 'cfg', 'a.txt'), 'utf8')).toBe('inside\n');
      } finally {
        await snapshot.cleanup();
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it('removes an emptied directory before writing a file at its path', async () => {
    const fixture = await createFixture('snapshot-dir-to-file-');
    try {
      await fs.mkdir(path.join(fixture.work, 'cfg'));
      await fs.writeFile(path.join(fixture.work, 'cfg', 'a.txt'), 'base inside\n');
      git(fixture.work, ['add', 'cfg']);
      git(fixture.work, ['commit', '-m', 'base dir']);
      git(fixture.work, ['push', 'origin', 'main']);

      git(fixture.work, ['rm', 'cfg/a.txt']);
      await fs.rmdir(path.join(fixture.work, 'cfg')).catch(() => undefined);
      await fs.writeFile(path.join(fixture.work, 'cfg'), 'now a file\n');
      const snapshot = await capture(fixture.work);
      expect(snapshot).not.toBeNull();
      if (!snapshot) throw new Error('expected snapshot');
      try {
        expect(snapshot.manifest.deleted).toContain('cfg/a.txt');
        const target = await clone(fixture, 'target');
        const result = await applyWorktreeSnapshot({
          directory: target,
          worktreeId: 'worktree_test',
          archivePath: snapshot.archivePath,
          signal: signal(),
        });
        expect(result.applied).toBe(2);
        expect(result.conflicts).toEqual([]);
        expect((await fs.lstat(path.join(target, 'cfg'))).isFile()).toBe(true);
        expect(await fs.readFile(path.join(target, 'cfg'), 'utf8')).toBe('now a file\n');
        expect(
          await fs.access(path.join(target, 'cfg', 'a.txt')).then(
            () => true,
            () => false
          )
        ).toBe(false);
      } finally {
        await snapshot.cleanup();
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it('records a conflict when upstream replaces a captured file with a directory', async () => {
    const fixture = await createFixture('snapshot-upstream-file-to-dir-');
    try {
      await fs.writeFile(path.join(fixture.work, 'cfg'), 'base file\n');
      git(fixture.work, ['add', 'cfg']);
      git(fixture.work, ['commit', '-m', 'base file']);
      git(fixture.work, ['push', 'origin', 'main']);
      await fs.writeFile(path.join(fixture.work, 'cfg'), 'snapshot file\n');

      const snapshot = await capture(fixture.work);
      expect(snapshot).not.toBeNull();
      if (!snapshot) throw new Error('expected snapshot');
      try {
        const upstream = await clone(fixture, 'upstream');
        git(upstream, ['rm', 'cfg']);
        await fs.mkdir(path.join(upstream, 'cfg'));
        await fs.writeFile(path.join(upstream, 'cfg', 'a.txt'), 'upstream directory\n');
        git(upstream, ['add', '-A']);
        git(upstream, ['commit', '-m', 'replace file with directory']);
        git(upstream, ['push', 'origin', 'main']);

        const target = await clone(fixture, 'target');
        const result = await applyWorktreeSnapshot({
          directory: target,
          worktreeId: 'worktree_test',
          archivePath: snapshot.archivePath,
          signal: signal(),
        });
        expect(result).toEqual({
          applied: 0,
          omitted: 0,
          conflicts: ['cfg'],
          partial: false,
        });
        expect((await fs.lstat(path.join(target, 'cfg'))).isDirectory()).toBe(true);
        expect(await fs.readFile(path.join(target, 'cfg', 'a.txt'), 'utf8')).toBe(
          'upstream directory\n'
        );
        expect(
          await fs.readFile(
            path.join(
              target,
              '.git',
              'kilo-recovered',
              sanitizedTimestamp(snapshot.manifest.capturedAt),
              'cfg'
            ),
            'utf8'
          )
        ).toBe('snapshot file\n');
      } finally {
        await snapshot.cleanup();
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it('records a residual type clash as a conflict and preserves the snapshot copy', async () => {
    const fixture = await createFixture('snapshot-type-clash-');
    try {
      await fs.writeFile(path.join(fixture.work, 'cfg'), 'snapshot file\n');
      const snapshot = await capture(fixture.work);
      expect(snapshot).not.toBeNull();
      if (!snapshot) throw new Error('expected snapshot');
      try {
        const target = await clone(fixture, 'target');
        await fs.mkdir(path.join(target, 'cfg'));
        await fs.writeFile(path.join(target, 'cfg', 'other.txt'), 'local other\n');
        const result = await applyWorktreeSnapshot({
          directory: target,
          worktreeId: 'worktree_test',
          archivePath: snapshot.archivePath,
          signal: signal(),
        });
        expect(result.applied).toBe(0);
        expect(result.conflicts).toEqual(['cfg']);
        expect((await fs.lstat(path.join(target, 'cfg'))).isDirectory()).toBe(true);
        expect(await fs.readFile(path.join(target, 'cfg', 'other.txt'), 'utf8')).toBe(
          'local other\n'
        );
        expect(
          await fs.readFile(
            path.join(
              target,
              '.git',
              'kilo-recovered',
              sanitizedTimestamp(snapshot.manifest.capturedAt),
              'cfg'
            ),
            'utf8'
          )
        ).toBe('snapshot file\n');
      } finally {
        await snapshot.cleanup();
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects unsafe members, unsupported entry types, unknown versions and corrupt data', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'snapshot-invalid-'));
    try {
      const cases: Buffer[] = [
        gzipSync(
          tarArchive([
            tarEntry('snapshot.json', manifestBytes()),
            tarEntry('files/../escape.txt', Buffer.from('escape')),
          ])
        ),
        gzipSync(
          tarArchive([
            tarEntry('snapshot.json', manifestBytes()),
            tarEntry('/absolute.txt', Buffer.from('escape')),
          ])
        ),
        gzipSync(
          tarArchive([
            tarEntry('snapshot.json', manifestBytes()),
            tarEntry('.git/config', Buffer.from('escape')),
          ])
        ),
        gzipSync(
          tarArchive([
            tarEntry('snapshot.json', manifestBytes()),
            tarEntry('files/a\\b.txt', Buffer.from('escape')),
          ])
        ),
        gzipSync(
          tarArchive([
            tarEntry('snapshot.json', manifestBytes()),
            tarEntry('files/link', Buffer.alloc(0), '2'),
          ])
        ),
        gzipSync(
          tarArchive([
            tarEntry('snapshot.json', manifestBytes()),
            tarEntry('recovery/../escape.txt', Buffer.from('escape')),
          ])
        ),
        gzipSync(
          tarArchive([
            tarEntry('snapshot.json', manifestBytes()),
            tarEntry('recovery/stamp/../escape.txt', Buffer.from('escape')),
          ])
        ),
        gzipSync(
          tarArchive([
            tarEntry('snapshot.json', manifestBytes()),
            tarEntry('recovery/stamp/.git/config', Buffer.from('escape')),
          ])
        ),
        gzipSync(
          tarArchive([
            tarEntry('snapshot.json', manifestBytes()),
            tarEntry('recovery/stamp/a\\b.txt', Buffer.from('escape')),
          ])
        ),
        gzipSync(
          tarArchive([
            tarEntry('snapshot.json', manifestBytes()),
            tarEntry('recovery/stamp/link', Buffer.alloc(0), '2'),
          ])
        ),
        gzipSync(
          tarArchive([
            tarEntry('snapshot.json', manifestBytes()),
            tarEntry('files/a.txt', Buffer.from('first')),
            tarEntry('files/a.txt', Buffer.from('second')),
          ])
        ),
        gzipSync(
          tarArchive([
            tarEntry('snapshot.json', manifestBytes()),
            tarEntry('files/a', Buffer.from('file')),
            tarEntry('files/a/b.txt', Buffer.from('nested')),
          ])
        ),
        gzipSync(
          tarArchive([
            tarEntry('snapshot.json', manifestBytes()),
            tarEntry('files/a.txt', Buffer.from('mode'), '0', 0o600),
          ])
        ),
        gzipSync(tarArchive([tarEntry('snapshot.json', manifestBytes({ version: 2 }))])),
        gzipSync(tarArchive([tarEntry('snapshot.json', manifestBytes({ capturedAt: '..' }))])),
        gzipSync(
          tarArchive([tarEntry('snapshot.json', manifestBytes({ capturedAt: 'not-a-time' }))])
        ),
        gzipSync(tarArchive([tarEntry('snapshot.json', manifestBytes({ base: 'nope' }))])),
        gzipSync(
          tarArchive([
            tarEntry('snapshot.json', manifestBytes({ deleted: ['same.txt', 'same.txt'] })),
          ])
        ),
        gzipSync(
          tarArchive([tarEntry('snapshot.json', manifestBytes({ deleted: ['../escape.txt'] }))])
        ),
        gzipSync(
          tarArchive([
            tarEntry(
              'snapshot.json',
              manifestBytes({ omitted: [{ path: 'file.txt', reason: 'unknown' }] })
            ),
          ])
        ),
        gzipSync(
          tarArchive([
            tarEntry('snapshot.json', manifestBytes({ omitted: [{ path: 1, reason: 'symlink' }] })),
          ])
        ),
        Buffer.from('not a gzip stream'),
      ];

      for (const bytes of cases) {
        const archivePath = await writeArchive(directory, bytes);
        await expectInvalid(
          applyWorktreeSnapshot({
            directory,
            worktreeId: 'worktree_test',
            archivePath,
            signal: signal(),
          })
        );
      }
      expect(await fs.readdir(directory)).not.toContain('escape.txt');
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it('is idempotent for an empty snapshot and removes the archive on cleanup', async () => {
    const fixture = await createFixture('snapshot-empty-');
    try {
      const target = await clone(fixture, 'target');
      const snapshot = await capture(fixture.work);
      expect(snapshot).not.toBeNull();
      if (!snapshot) throw new Error('expected snapshot');
      const archivePath = snapshot.archivePath;
      expect(await fs.stat(archivePath)).toBeDefined();
      await snapshot.cleanup();
      await snapshot.cleanup();
      expect(
        await fs.access(archivePath).then(
          () => true,
          () => false
        )
      ).toBe(false);

      const direct = await capture(fixture.work);
      if (!direct) throw new Error('expected direct snapshot');
      try {
        const result = await applyWorktreeSnapshot({
          directory: target,
          worktreeId: 'worktree_test',
          archivePath: direct.archivePath,
          signal: signal(),
        });
        expect(result).toEqual({ applied: 0, omitted: 0, conflicts: [], partial: false });
      } finally {
        await direct.cleanup();
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects a snapshot for a different worktree', async () => {
    const fixture = await createFixture('snapshot-worktree-');
    try {
      const snapshot = await capture(fixture.work);
      expect(snapshot).not.toBeNull();
      if (!snapshot) throw new Error('expected snapshot');
      try {
        await expectInvalid(
          applyWorktreeSnapshot({
            directory: fixture.work,
            worktreeId: 'worktree_other',
            archivePath: snapshot.archivePath,
            signal: signal(),
          })
        );
      } finally {
        await snapshot.cleanup();
      }
    } finally {
      await fixture.cleanup();
    }
  });
});
