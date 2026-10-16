import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectWorktreeChanges, collectWorktreeSnapshot } from './worktree-changes.js';
import { restoreWorktreeRecovery } from '../control-plane/worktree-recovery.js';
import { MAX_WORKTREE_CHANGES_BYTES } from '../../../src/shared/worktree-changes-wire.js';
import { git as runGit } from '../utils.js';

let directory: string;
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: directory, env, encoding: 'utf8' }).trim();
}

async function commit(text: string) {
  await writeFile(join(directory, 'same.txt'), text);
  git('add', '--all');
  git('commit', '-qm', 'change');
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'scoped-worktree-'));
  git('init', '-q', '-b', 'main');
  await commit('base\n');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('scoped worktree capture', () => {
  it('captures the same path in both scopes using HEAD content rather than staged or working content', async () => {
    await commit('committed\n');
    await writeFile(join(directory, 'same.txt'), 'staged\n');
    git('add', 'same.txt');
    await writeFile(join(directory, 'same.txt'), 'working\n');
    await writeFile(join(directory, 'untracked.txt'), 'untracked\n');
    const snapshot = await collectWorktreeSnapshot(directory, { revision: 1 });
    expect(snapshot.summary.files).toEqual([
      expect.objectContaining({
        path: 'same.txt',
        scope: 'uncommitted',
        additions: 1,
        deletions: 1,
      }),
      expect.objectContaining({
        path: 'same.txt',
        scope: 'against-base-branch',
        additions: 1,
        deletions: 1,
      }),
      expect.objectContaining({ path: 'untracked.txt', scope: 'uncommitted', tracked: false }),
    ]);
    const committed = snapshot.files.find(file => file.scope === 'against-base-branch');
    const uncommitted = snapshot.files.find(
      file => file.scope === 'uncommitted' && file.path === 'same.txt'
    );
    expect(committed?.content).toEqual({
      status: 'available',
      source: 'current',
      text: 'committed\n',
    });
    expect(uncommitted?.content).toEqual({
      status: 'available',
      source: 'current',
      text: 'working\n',
    });
    expect(committed?.diff).toEqual({
      status: 'available',
      patch: expect.stringContaining('-base\n+committed\n'),
    });
    expect(uncommitted?.diff).toEqual({
      status: 'available',
      patch: expect.stringContaining('-committed\n+working\n'),
    });
    expect(await collectWorktreeChanges(directory, { revision: 1 })).toEqual(snapshot.summary);
  });

  it('keeps committed and uncommitted edits that cancel in a combined comparison', async () => {
    await commit('committed\n');
    await writeFile(join(directory, 'same.txt'), 'base\n');
    expect(git('diff', 'refs/remotes/origin/main', '--', 'same.txt')).toBe('');
    const snapshot = await collectWorktreeSnapshot(directory, { revision: 1 });
    expect(snapshot.summary.files.map(file => file.scope)).toEqual([
      'uncommitted',
      'against-base-branch',
    ]);
    expect(snapshot.files.every(file => file.diff.status === 'available')).toBe(true);
    expect(snapshot.recovery).toEqual({ files: [] });
  });

  it('recovers final worktree content with one net patch when both display layers exceed the recovery budget together', async () => {
    const original = `${'A'.repeat(70_000)}\n`;
    const committed = `${'B'.repeat(70_000)}\n`;
    const working = `${'C'.repeat(70_000)}\n`;
    await commit(original);
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    await commit(committed);
    await writeFile(join(directory, 'same.txt'), working);
    const snapshot = await collectWorktreeSnapshot(directory, { revision: 1 });
    const displayBytes = snapshot.files.reduce(
      (sum, file) =>
        sum + (file.diff.status === 'available' ? Buffer.byteLength(file.diff.patch) : 0),
      0
    );
    expect(displayBytes).toBeGreaterThan(MAX_WORKTREE_CHANGES_BYTES);
    const recovery = snapshot.recovery;
    expect(recovery?.files).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify(recovery))).toBeLessThan(MAX_WORKTREE_CHANGES_BYTES);
    expect(recovery?.files[0].patch).toContain(`-${original}+${working}`);
    if (!recovery) throw new Error('Net recovery was not captured');
    git('checkout', '-qf', 'refs/remotes/origin/main');
    const restored = await restoreWorktreeRecovery(
      directory,
      recovery,
      env,
      AbortSignal.timeout(10_000)
    );
    expect(restored).toMatchObject({ applied: 1, skipped: 0 });
    expect(await readFile(join(directory, 'same.txt'), 'utf8')).toBe(working);
    expect(git('show', ':same.txt')).toBe(original.trim());
    expect(
      await restoreWorktreeRecovery(directory, recovery, env, AbortSignal.timeout(10_000))
    ).toMatchObject({ applied: 1, skipped: 0 });
  });

  it('omits an oversized net patch without recovering a committed intermediate state', async () => {
    const original = `${'A'.repeat(140_000)}\n`;
    await commit(original);
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    await commit(`${'B'.repeat(140_000)}\n`);
    await writeFile(join(directory, 'same.txt'), `${'C'.repeat(140_000)}\n`);
    const snapshot = await collectWorktreeSnapshot(directory, { revision: 1 });
    expect(snapshot.recovery).toEqual({ files: [{ path: 'same.txt', status: 'modified' }] });
    if (!snapshot.recovery) throw new Error('Net recovery was not captured');
    git('checkout', '-qf', 'refs/remotes/origin/main');
    expect(
      await restoreWorktreeRecovery(directory, snapshot.recovery, env, AbortSignal.timeout(10_000))
    ).toMatchObject({ applied: 0, skipped: 1 });
    expect(await readFile(join(directory, 'same.txt'), 'utf8')).toBe(original);
  });

  it('captures untracked net recovery even when duplicate display scopes exhaust the file limit', async () => {
    await commit('committed\n');
    await writeFile(join(directory, 'untracked.txt'), 'recover me\n');
    const head = git('rev-parse', 'HEAD');
    const injectedGit: typeof runGit = async (args, options) => {
      const refs = args.slice(args.indexOf('-z') + 1, args.indexOf('--'));
      if (
        args.includes('--numstat') &&
        !args.includes('--patch') &&
        (refs.length === 2 || refs[0] === head)
      ) {
        const paths = Array.from({ length: 600 }, (_, index) => `not-present-${index}.txt`);
        const stdout =
          paths
            .map(path => `:100644 100644 ${'0'.repeat(40)} ${'0'.repeat(40)} M\0${path}\0`)
            .join('') + paths.map(path => `1\t1\t${path}\0`).join('');
        return { stdout, stderr: '', exitCode: 0, stdoutBytes: Buffer.from(stdout) };
      }
      return runGit(args, options);
    };
    const snapshot = await collectWorktreeSnapshot(directory, { revision: 1 }, injectedGit);
    expect(snapshot.summary.truncated).toBe(true);
    expect(snapshot.summary.files.some(file => file.path === 'untracked.txt')).toBe(false);
    expect(snapshot.recovery?.files.find(file => file.path === 'untracked.txt')).toMatchObject({
      status: 'added',
      patch: expect.stringContaining('+recover me\n'),
    });
  });

  it('uses captured HEAD as the original for uncommitted deletions, including committed additions', async () => {
    await writeFile(join(directory, 'added.txt'), 'added at HEAD\n');
    await commit('committed\n');
    await rm(join(directory, 'same.txt'));
    await rm(join(directory, 'added.txt'));
    const snapshot = await collectWorktreeSnapshot(directory, { revision: 1 });
    expect(
      snapshot.files.find(file => file.path === 'same.txt' && file.scope === 'uncommitted')?.content
    ).toEqual({
      status: 'available',
      source: 'deleted-original',
      text: 'committed\n',
    });
    expect(
      snapshot.files.find(file => file.path === 'added.txt' && file.scope === 'uncommitted')
        ?.content
    ).toEqual({
      status: 'available',
      source: 'deleted-original',
      text: 'added at HEAD\n',
    });
    expect(
      snapshot.files.find(file => file.path === 'added.txt' && file.scope === 'against-base-branch')
        ?.content
    ).toEqual({
      status: 'available',
      source: 'current',
      text: 'added at HEAD\n',
    });
    expect(snapshot.files.every(file => file.diff.status === 'available')).toBe(true);
  });

  it('uses the merge-base original for committed deletion even when the path is recreated untracked', async () => {
    git('rm', 'same.txt');
    git('commit', '-qm', 'delete');
    await writeFile(join(directory, 'same.txt'), 'recreated\n');
    const snapshot = await collectWorktreeSnapshot(directory, { revision: 1 });
    expect(snapshot.summary.files).toEqual([
      expect.objectContaining({
        path: 'same.txt',
        scope: 'against-base-branch',
        status: 'deleted',
      }),
      expect.objectContaining({
        path: 'same.txt',
        scope: 'uncommitted',
        status: 'added',
        tracked: false,
      }),
    ]);
    expect(snapshot.files.find(file => file.scope === 'against-base-branch')?.content).toEqual({
      status: 'available',
      source: 'deleted-original',
      text: 'base\n',
    });
    expect(snapshot.files.find(file => file.scope === 'uncommitted')?.content).toEqual({
      status: 'available',
      source: 'current',
      text: 'recreated\n',
    });
    const recovery = snapshot.recovery;
    expect(recovery?.files).toEqual([
      {
        path: 'same.txt',
        status: 'modified',
        patch: expect.stringContaining('-base\n+recreated\n'),
      },
    ]);
    if (!recovery) throw new Error('Net recovery was not captured');
    git('checkout', '-qf', 'refs/remotes/origin/main');
    expect(
      await restoreWorktreeRecovery(directory, recovery, env, AbortSignal.timeout(10_000))
    ).toMatchObject({ applied: 1, skipped: 0 });
    expect(await readFile(join(directory, 'same.txt'), 'utf8')).toBe('recreated\n');
    expect(git('show', ':same.txt')).toBe('base');
  });

  it('omits oversized recreated net content without reverting to the committed deletion patch', async () => {
    git('rm', 'same.txt');
    git('commit', '-qm', 'delete');
    await writeFile(join(directory, 'same.txt'), `${'C'.repeat(MAX_WORKTREE_CHANGES_BYTES)}\n`);
    const snapshot = await collectWorktreeSnapshot(directory, { revision: 1 });
    expect(snapshot.recovery).toEqual({ files: [{ path: 'same.txt', status: 'modified' }] });
    if (!snapshot.recovery) throw new Error('Net recovery was not captured');
    git('checkout', '-qf', 'refs/remotes/origin/main');
    expect(
      await restoreWorktreeRecovery(directory, snapshot.recovery, env, AbortSignal.timeout(10_000))
    ).toMatchObject({ applied: 0, skipped: 1 });
    expect(await readFile(join(directory, 'same.txt'), 'utf8')).toBe('base\n');
  });

  it('ignores staged edits that are reverted in the worktree but includes staged-only edits', async () => {
    await writeFile(join(directory, 'same.txt'), 'staged\n');
    git('add', 'same.txt');
    const staged = await collectWorktreeSnapshot(directory, { revision: 1 });
    expect(staged.summary.files).toEqual([
      expect.objectContaining({ scope: 'uncommitted', path: 'same.txt' }),
    ]);
    await writeFile(join(directory, 'same.txt'), 'base\n');
    const cancelled = await collectWorktreeSnapshot(directory, { revision: 2 });
    expect(cancelled.summary.files).toEqual([]);
    expect(cancelled.files).toEqual([]);
  });

  it('preserves binary, unsupported and content-size omissions independently in both scopes', async () => {
    await writeFile(join(directory, 'binary.bin'), Buffer.from([0, 1, 2]));
    await symlink('same.txt', join(directory, 'link'));
    await commit(`${'x'.repeat(110_000)}\n`);
    await writeFile(join(directory, 'same.txt'), `${'y'.repeat(110_000)}\n`);
    await writeFile(join(directory, 'binary.bin'), Buffer.from([0, 3, 4]));
    const snapshot = await collectWorktreeSnapshot(directory, { revision: 1 });
    for (const scope of ['uncommitted', 'against-base-branch']) {
      expect(
        snapshot.files.find(file => file.path === 'binary.bin' && file.scope === scope)
      ).toMatchObject({
        diff: { status: 'omitted', reason: 'binary' },
        content: { status: 'unavailable', reason: 'binary' },
      });
      expect(
        snapshot.files.find(file => file.path === 'same.txt' && file.scope === scope)
      ).toMatchObject({
        diff: { status: 'available' },
        content: { status: 'unavailable', reason: 'too_large' },
      });
    }
    expect(snapshot.files.find(file => file.path === 'link')).toMatchObject({
      scope: 'against-base-branch',
      diff: { status: 'omitted', reason: 'unsupported' },
      content: { status: 'unavailable', reason: 'unsupported' },
    });
  });
});
