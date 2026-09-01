import { rejects } from 'assert/strict';
import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { setTimeout as delay } from 'timers/promises';
import {
  MAX_WORKTREE_CHANGES_BYTES,
  MAX_WORKTREE_CHANGES_FILES,
  sessionGitSummaryResultSchema,
} from '../../../src/shared/sandbox-control-protocol.js';
import {
  MAX_WORKTREE_CONTENT_BYTES,
  MAX_WORKTREE_FILE_BYTES,
  MAX_WORKTREE_SNAPSHOT_BYTES,
  sessionGitSnapshotResultSchema,
  type SessionGitSnapshotResult,
  type WorktreeFileRecord,
} from '../../../src/shared/worktree-changes-wire.js';
import { git, runProcess, type ExecResult } from '../utils.js';
import {
  collectWorktreeChanges,
  collectWorktreeSnapshot,
  parseWorktreeDiff,
} from './worktree-changes';

const directories: string[] = [];
const baseRef = 'refs/remotes/origin/main';
const hash = 'a'.repeat(40);

function run(directory: string, args: string[], expectedExitCode = 0): string {
  const result = Bun.spawnSync({
    cmd: ['git', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args],
    cwd: directory,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== expectedExitCode)
    throw new Error(`Fixture git command failed: ${args[0]}`);
  return result.stdout.toString('utf8');
}

async function write(directory: string, path: string, content: string | Buffer): Promise<void> {
  const fullPath = join(directory, path);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content);
}

async function createRepo(
  files: Record<string, string | Buffer> = { 'seed.txt': 'seed\n' },
  objectFormat: 'sha1' | 'sha256' = 'sha1'
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'worktree-changes-'));
  directories.push(directory);
  run(directory, ['init', '-b', 'main', `--object-format=${objectFormat}`]);
  run(directory, ['config', 'core.filemode', 'true']);
  for (const [path, content] of Object.entries(files)) await write(directory, path, content);
  run(directory, ['add', '--all']);
  run(directory, ['commit', '--allow-empty', '-m', 'base']);
  run(directory, ['update-ref', baseRef, 'HEAD']);
  run(directory, ['symbolic-ref', 'refs/remotes/origin/HEAD', baseRef]);
  run(directory, ['switch', '-c', 'feature']);
  return directory;
}

function raw(path: string, status = 'M'): string {
  return `:100644 100644 ${hash} ${'0'.repeat(40)} ${status}\0${path}\0`;
}

function fakeGit(output: { diff?: string; untracked?: string } = {}): typeof git {
  return async (args, options) => {
    expect(options?.timeoutMs).toBeGreaterThan(0);
    expect(options?.timeoutMs).toBeLessThanOrEqual(20_000);
    expect(options?.maxOutputBytes).toBe(512 * 1024);
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    let stdout = '';
    if (args.includes('--show-prefix')) stdout = '\n';
    else if (args.includes('symbolic-ref')) stdout = `${baseRef}\n`;
    else if (args.includes('--verify') || args.includes('merge-base')) stdout = `${hash}\n`;
    else if (args.includes('diff')) stdout = output.diff ?? '';
    else if (args.includes('ls-files')) stdout = output.untracked ?? '';
    else if (!args.includes('check-ref-format')) throw new Error('Unexpected git command');
    return { stdout, stderr: '', exitCode: 0 };
  };
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))
  );
});

describe('collectWorktreeChanges', () => {
  const cleanRepositories: Record<string, string>[] = [{}, { 'seed.txt': 'seed\n' }];
  it.each(cleanRepositories)(
    'captures clean repositories without inventing changes',
    async files => {
      const directory = await createRepo(files);
      const head = run(directory, ['rev-parse', 'HEAD']).slice(0, -1);
      expect(await collectWorktreeChanges(directory, { revision: 7 })).toEqual({
        revision: 7,
        comparison: { baseRef, mergeBase: head, head },
        files: [],
        truncated: false,
      });
    }
  );

  it('combines commits, staged edits, unstaged edits, and untracked files without double counting', async () => {
    const directory = await createRepo({ 'changed.txt': 'base\n', 'cancelled.txt': 'base\n' });
    await write(directory, 'changed.txt', 'base\ncommitted\n');
    await write(directory, 'committed.txt', 'committed\n');
    await write(directory, 'removed-again.txt', 'temporary\n');
    run(directory, ['add', '--all']);
    run(directory, ['commit', '-m', 'feature']);
    await write(directory, 'changed.txt', 'base\ncommitted\nstaged\n');
    await write(directory, 'cancelled.txt', 'staged replacement\n');
    await write(directory, 'staged.txt', 'staged\n');
    run(directory, ['add', '--all']);
    await write(directory, 'changed.txt', 'base\ncommitted\nstaged\nunstaged\n');
    await write(directory, 'cancelled.txt', 'base\n');
    await rm(join(directory, 'removed-again.txt'));
    await write(directory, 'untracked.txt', 'first\nlast');

    const result = await collectWorktreeChanges(directory, { revision: 1, baseRef });
    expect(result.files).toEqual([
      {
        path: 'changed.txt',
        status: 'modified',
        additions: 3,
        deletions: 0,
        tracked: true,
        binary: false,
        countsComplete: true,
      },
      {
        path: 'committed.txt',
        status: 'added',
        additions: 1,
        deletions: 0,
        tracked: true,
        binary: false,
        countsComplete: true,
      },
      {
        path: 'staged.txt',
        status: 'added',
        additions: 1,
        deletions: 0,
        tracked: true,
        binary: false,
        countsComplete: true,
      },
      {
        path: 'untracked.txt',
        status: 'added',
        additions: 2,
        deletions: 0,
        tracked: false,
        binary: false,
        countsComplete: true,
      },
    ]);
    expect(result.truncated).toBe(false);
  });

  it('uses the merge base rather than a divergent upstream tip', async () => {
    const directory = await createRepo();
    const ancestor = run(directory, ['rev-parse', 'HEAD']).slice(0, -1);
    run(directory, ['switch', 'main']);
    await write(directory, 'upstream.txt', 'upstream\n');
    run(directory, ['add', '--all']);
    run(directory, ['commit', '-m', 'upstream']);
    run(directory, ['update-ref', baseRef, 'HEAD']);
    run(directory, ['switch', 'feature']);
    await write(directory, 'feature.txt', 'feature\n');
    run(directory, ['add', '--all']);
    run(directory, ['commit', '-m', 'feature']);

    const result = await collectWorktreeChanges(directory, { revision: 1 });
    expect(result.comparison.mergeBase).toBe(ancestor);
    expect(result.files.map(file => file.path)).toEqual(['feature.txt']);
  });

  it('respects Git ignores but excludes only the exact untracked bootstrap marker', async () => {
    const directory = await createRepo({ '.gitignore': 'ignored.txt\nignored-dir/\n' });
    await write(directory, 'ignored.txt', 'ignored\n');
    await write(directory, 'ignored-dir/file.txt', 'ignored\n');
    await write(directory, '.kilo-bootstrap-complete', 'wrapper\n');
    await write(directory, 'nested/.kilo-bootstrap-complete', 'project\n');
    await write(directory, 'dist/app.log', 'generated\n');

    const result = await collectWorktreeChanges(directory, { revision: 1 });
    expect(result.files.map(file => file.path)).toEqual([
      'dist/app.log',
      'nested/.kilo-bootstrap-complete',
    ]);
    run(directory, ['add', '.kilo-bootstrap-complete']);
    const trackedMarker = await collectWorktreeChanges(directory, { revision: 2 });
    expect(
      trackedMarker.files.find(file => file.path === '.kilo-bootstrap-complete')
    ).toMatchObject({ tracked: true, status: 'added' });
  });

  it('reports deletions and renames as deletion plus addition', async () => {
    const directory = await createRepo({ 'old.txt': 'move\n', 'deleted.txt': 'delete\n' });
    await rename(join(directory, 'old.txt'), join(directory, 'new.txt'));
    run(directory, ['add', '--all']);
    await rm(join(directory, 'deleted.txt'));

    const result = await collectWorktreeChanges(directory, { revision: 1 });
    expect(
      result.files.map(({ path, status, additions, deletions }) => ({
        path,
        status,
        additions,
        deletions,
      }))
    ).toEqual([
      { path: 'deleted.txt', status: 'deleted', additions: 0, deletions: 1 },
      { path: 'new.txt', status: 'added', additions: 1, deletions: 0 },
      { path: 'old.txt', status: 'deleted', additions: 0, deletions: 1 },
    ]);
  });

  it('keeps unresolved conflict contents as a meaningful modification', async () => {
    const directory = await createRepo();
    run(directory, ['switch', 'main']);
    await write(directory, 'seed.txt', 'main\n');
    run(directory, ['commit', '-am', 'main change']);
    run(directory, ['switch', 'feature']);
    await write(directory, 'seed.txt', 'feature\n');
    run(directory, ['commit', '-am', 'feature change']);
    run(directory, ['merge', '--no-edit', 'main'], 1);

    const result = await collectWorktreeChanges(directory, { revision: 1 });
    expect(result.files).toEqual([
      {
        path: 'seed.txt',
        status: 'modified',
        additions: 5,
        deletions: 1,
        tracked: true,
        binary: false,
        countsComplete: true,
      },
    ]);
  });

  it('preserves mode-only and file-type changes', async () => {
    const directory = await createRepo({ 'mode.txt': 'same\n', 'type.txt': 'before\n' });
    await chmod(join(directory, 'mode.txt'), 0o755);
    await rm(join(directory, 'type.txt'));
    await symlink('target', join(directory, 'type.txt'));

    const result = await collectWorktreeChanges(directory, { revision: 1 });
    expect(result.files).toEqual([
      {
        path: 'mode.txt',
        status: 'modified',
        additions: 0,
        deletions: 0,
        tracked: true,
        binary: false,
        countsComplete: true,
      },
      {
        path: 'type.txt',
        status: 'modified',
        additions: 1,
        deletions: 1,
        tracked: true,
        binary: false,
        countsComplete: true,
      },
    ]);
  });

  it('preserves Unicode, tabs, newlines, spaces, quotes, and backslashes in paths', async () => {
    const names = [
      ' leading space ',
      '\ttab\tname',
      'new\nline',
      'quote"back\\slash',
      'café-漢-𐐀',
      'parent-é/child',
      '-dash',
      ':(glob)*',
    ];
    const directory = await createRepo(
      Object.fromEntries(names.map(name => [`tracked/${name}`, 'before\n']))
    );
    for (const name of names) {
      await write(directory, `tracked/${name}`, 'after\nsecond\n');
      await write(directory, `untracked/${name}`, 'new\n');
    }

    const result = await collectWorktreeChanges(directory, { revision: 1 });
    expect(result.files).toHaveLength(names.length * 2);
    for (const name of names) {
      expect(result.files.find(file => file.path === `tracked/${name}`)).toMatchObject({
        additions: 2,
        deletions: 1,
        tracked: true,
      });
      expect(result.files.find(file => file.path === `untracked/${name}`)).toMatchObject({
        additions: 1,
        tracked: false,
      });
    }
  });

  it('flags tracked and sampled untracked binary files without returning contents', async () => {
    const directory = await createRepo({ 'tracked.bin': Buffer.from([0, 1, 2]) });
    await write(directory, 'tracked.bin', Buffer.from([0, 3, 4]));
    await write(directory, 'nul.txt', Buffer.from([65, 0, 65]));
    await write(directory, 'controls.txt', Buffer.from([1, 2, 65, 65, 65]));
    await write(
      directory,
      'thirty-percent.txt',
      Buffer.from([1, 2, 3, 65, 65, 65, 65, 65, 65, 65])
    );
    await write(directory, 'notes.bin', 'text\n');
    await write(directory, 'after-sample.txt', `${'a'.repeat(8192)}\0`);

    const result = await collectWorktreeChanges(directory, { revision: 1 });
    for (const path of ['tracked.bin', 'nul.txt', 'controls.txt']) {
      expect(result.files.find(file => file.path === path)).toMatchObject({
        binary: true,
        additions: 0,
        deletions: 0,
        countsComplete: false,
      });
    }
    for (const path of ['notes.bin', 'thirty-percent.txt', 'after-sample.txt']) {
      expect(result.files.find(file => file.path === path)).toMatchObject({
        binary: false,
        additions: 1,
        countsComplete: true,
      });
    }
    expect(sessionGitSummaryResultSchema.safeParse(result).success).toBe(true);
  });

  it('counts symlink target text without following existing or dangling targets', async () => {
    const directory = await createRepo();
    const outside = await mkdtemp(join(tmpdir(), 'worktree-symlink-target-'));
    directories.push(outside);
    await write(outside, 'secret.bin', Buffer.alloc(20_000, 0));
    await symlink(join(outside, 'secret.bin'), join(directory, 'link'));
    await symlink('missing\nsecond-line', join(directory, 'dangling'));

    const result = await collectWorktreeChanges(directory, { revision: 1 });
    expect(result.files).toEqual([
      {
        path: 'dangling',
        status: 'added',
        additions: 2,
        deletions: 0,
        tracked: false,
        binary: false,
        countsComplete: true,
      },
      {
        path: 'link',
        status: 'added',
        additions: 1,
        deletions: 0,
        tracked: false,
        binary: false,
        countsComplete: true,
      },
    ]);
  });

  it('caps untracked text reads and still samples oversized binaries', async () => {
    const directory = await createRepo();
    await write(directory, 'at-limit.txt', 'x\n'.repeat(500_000));
    await write(directory, 'oversized.txt', 'x'.repeat(1_000_001));
    await write(directory, 'oversized.bin', Buffer.alloc(1_000_001, 0));
    await write(directory, 'empty.txt', '');

    const result = await collectWorktreeChanges(directory, { revision: 1 });
    expect(result.files.find(file => file.path === 'at-limit.txt')).toMatchObject({
      additions: 500_000,
      countsComplete: true,
    });
    expect(result.files.find(file => file.path === 'oversized.txt')).toMatchObject({
      additions: 0,
      binary: false,
      countsComplete: false,
    });
    expect(result.files.find(file => file.path === 'oversized.bin')).toMatchObject({
      additions: 0,
      binary: true,
      countsComplete: false,
    });
    expect(result.files.find(file => file.path === 'empty.txt')).toMatchObject({
      additions: 0,
      binary: false,
      countsComplete: true,
    });
    expect(result.truncated).toBe(false);
  });

  it('bounds aggregate untracked reads while retaining sampled entries with incomplete counts', async () => {
    const directory = await createRepo();
    const content = 'x\n'.repeat(500_000);
    for (let index = 0; index < 20; index += 1)
      await write(directory, `large-${index}.txt`, content);

    const result = await collectWorktreeChanges(directory, { revision: 1 });
    expect(result.files).toHaveLength(20);
    const complete = result.files.filter(file => file.countsComplete).length;
    expect(complete).toBeGreaterThan(0);
    expect(complete).toBeLessThan(20);
    expect(complete * 1_000_000 + (20 - complete) * 8192).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(result.files.every(file => !file.binary)).toBe(true);
    expect(result.truncated).toBe(false);
  });

  it.each(['missing/ref', '--help', '-c core.worktree=/outside', '', 'main~1', 'main\n'])(
    'rejects invalid explicit base %j without fallback',
    async explicitBase => {
      const directory = await createRepo();
      await rejects(collectWorktreeChanges(directory, { revision: 1, baseRef: explicitBase }));
    }
  );

  it('fails without local origin/HEAD instead of falling back to mutable HEAD', async () => {
    const directory = await createRepo();
    run(directory, ['symbolic-ref', '--delete', 'refs/remotes/origin/HEAD']);
    await rejects(collectWorktreeChanges(directory, { revision: 1 }), /Worktree capture failed/);
    expect((await collectWorktreeChanges(directory, { revision: 1, baseRef })).files).toEqual([]);
  });

  it.each(['head', 'base', 'default-target'])(
    'rejects %s movement during capture',
    async movement => {
      const directory = await createRepo();
      run(directory, ['commit', '--allow-empty', '-m', 'feature']);
      run(directory, ['update-ref', 'refs/remotes/origin/other', baseRef]);
      const movingGit: typeof git = async (args, options) => {
        const result = await git(args, options);
        if (args.includes('diff')) {
          if (movement === 'head') run(directory, ['commit', '--allow-empty', '-m', 'moving HEAD']);
          if (movement === 'base') run(directory, ['update-ref', baseRef, 'HEAD']);
          if (movement === 'default-target')
            run(directory, [
              'symbolic-ref',
              'refs/remotes/origin/HEAD',
              'refs/remotes/origin/other',
            ]);
        }
        return result;
      };
      await rejects(
        collectWorktreeChanges(directory, { revision: 1 }, movingGit),
        /Worktree capture failed/
      );
    }
  );

  it('rejects a subdirectory rather than reading a parent repository', async () => {
    const directory = await createRepo();
    await mkdir(join(directory, 'nested'));
    await rejects(
      collectWorktreeChanges(join(directory, 'nested'), { revision: 1 }),
      /Worktree capture failed/
    );
  });

  it('fails when an untracked file vanishes after enumeration', async () => {
    const directory = await createRepo();
    await write(directory, 'vanishing.txt', 'before\n');
    const movingGit: typeof git = async (args, options) => {
      const result = await git(args, options);
      if (args.includes('ls-files')) await rm(join(directory, 'vanishing.txt'));
      return result;
    };
    await rejects(collectWorktreeChanges(directory, { revision: 1 }, movingGit));
  });

  it('rejects symlinked parent directories and special files without reading their contents', async () => {
    const directory = await createRepo();
    const outside = await mkdtemp(join(tmpdir(), 'worktree-outside-'));
    directories.push(outside);
    await write(outside, 'secret.txt', 'private\n');
    await symlink(outside, join(directory, 'parent'));
    await rejects(
      collectWorktreeChanges(
        directory,
        { revision: 1 },
        fakeGit({ untracked: 'parent/secret.txt\0' })
      ),
      /Worktree capture failed/
    );
    const fifo = Bun.spawnSync(['mkfifo', join(directory, 'pipe')]);
    expect(fifo.exitCode).toBe(0);
    await rejects(
      collectWorktreeChanges(directory, { revision: 1 }, fakeGit({ untracked: 'pipe\0' })),
      /Worktree capture failed/
    );
  });

  it('returns only whole entries up to the file limit from complete output', async () => {
    const directory = await createRepo();
    await Promise.all(
      Array.from({ length: MAX_WORKTREE_CHANGES_FILES + 5 }, (_, index) =>
        write(directory, `file-${String(index).padStart(4, '0')}`, '')
      )
    );

    const result = await collectWorktreeChanges(directory, { revision: 1 });
    expect(result.files).toHaveLength(MAX_WORKTREE_CHANGES_FILES);
    expect(result.files[0]?.path).toBe('file-0000');
    expect(result.files.at(-1)?.path).toBe('file-0999');
    expect(result.truncated).toBe(true);
  });

  it('reserves snapshot space and truncates whole entries by serialized UTF-8 bytes', async () => {
    const directory = await createRepo();
    const paths = Array.from(
      { length: 300 },
      (_, index) => `nested/${'\t"\\'.repeat(200)}/file-${index}`
    );
    const diff =
      paths.map(path => raw(path)).join('') + paths.map(path => `1\t0\t${path}\0`).join('');
    expect(Buffer.byteLength(diff)).toBeLessThan(512 * 1024);

    const result = await collectWorktreeChanges(directory, { revision: 1 }, fakeGit({ diff }));
    expect(result.truncated).toBe(true);
    expect(result.files.length).toBeGreaterThan(0);
    expect(result.files.length).toBeLessThan(paths.length);
    expect(result.files.map(file => file.path)).toEqual(paths.slice(0, result.files.length));
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
      MAX_WORKTREE_CHANGES_BYTES - 1024
    );
    expect(sessionGitSummaryResultSchema.safeParse(result).success).toBe(true);
  });

  it.each([
    { stdoutTruncated: true },
    { stderrTruncated: true },
    { exitCode: 1, stderr: 'private command failure' },
    { exitCode: 124, terminationReason: 'timeout' },
    { exitCode: 124, terminationReason: 'hard_timeout' },
  ] satisfies Partial<ExecResult>[])(
    'rejects valid-looking raw output after unsuccessful execution %j',
    async failure => {
      const directory = await createRepo();
      const runner = fakeGit({ diff: `${raw('valid.txt')}1\t0\tvalid.txt\0` });
      const failedGit: typeof git = async (args, options) => {
        const result = await runner(args, options);
        return args.includes('diff') ? { ...result, ...failure } : result;
      };
      await rejects(
        collectWorktreeChanges(directory, { revision: 1 }, failedGit),
        /Worktree capture failed/
      );
    }
  );

  it('shares a single deadline across otherwise successful Git commands', async () => {
    const directory = await createRepo();
    let now = Date.now();
    const clock = spyOn(Date, 'now').mockImplementation(() => now);
    const runner = fakeGit();
    const timeouts: number[] = [];
    let signal: AbortSignal | undefined;
    try {
      const slowGit: typeof git = async (args, options) => {
        const result = await runner(args, options);
        if (options?.timeoutMs !== undefined) timeouts.push(options.timeoutMs);
        signal = options?.signal;
        now += 5_000;
        return result;
      };
      await rejects(
        collectWorktreeChanges(directory, { revision: 1 }, slowGit),
        /Worktree capture failed/
      );
      expect(timeouts).toEqual([20_000, 15_000, 10_000, 5_000]);
      expect(signal?.aborted).toBe(true);
    } finally {
      clock.mockRestore();
    }
  });

  it('does not run Git after the wrapper has retired', async () => {
    const directory = await createRepo();
    const abort = new AbortController();
    abort.abort();
    const runGit = spyOn({ git }, 'git');
    try {
      await rejects(
        collectWorktreeChanges(directory, { revision: 1 }, runGit, abort.signal),
        /Worktree capture failed/
      );
      expect(runGit).not.toHaveBeenCalled();
    } finally {
      runGit.mockRestore();
    }
  });

  it('aborts in-flight Git collection when the wrapper retires', async () => {
    const directory = await createRepo();
    const abort = new AbortController();
    const started = Promise.withResolvers<AbortSignal>();
    const runGit: typeof git = async (_args, options) => {
      const signal = options?.signal;
      if (!signal) throw new Error('Missing capture cancellation signal');
      started.resolve(signal);
      await new Promise<void>(resolve => {
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return { stdout: '', stderr: '', exitCode: 124, terminationReason: 'abort' };
    };
    const pending = collectWorktreeChanges(directory, { revision: 1 }, runGit, abort.signal);
    const failed = rejects(pending, /Worktree capture failed/);
    try {
      const signal = await started.promise;
      expect(signal.aborted).toBe(false);
      abort.abort();
      await failed;
      expect(signal.aborted).toBe(true);
    } finally {
      abort.abort();
      await failed;
    }
  });

  it('does not inherit wrapper credentials or Git configuration overrides into capture processes', async () => {
    const directory = await createRepo();
    const overrides = {
      KILOCODE_TOKEN: 'fake-managed-token',
      SANDBOX_CONTROL_CREDENTIAL: 'fake-control-credential',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.worktree',
      GIT_CONFIG_VALUE_0: join(directory, 'missing-worktree'),
    };
    const previous = new Map(Object.keys(overrides).map(key => [key, process.env[key]]));
    let inspected = false;
    const runGit: typeof git = async (args, options) => {
      if (!inspected) {
        inspected = true;
        const result = await runProcess(
          process.execPath,
          [
            '-e',
            'process.stdout.write(JSON.stringify({ token: !!process.env.KILOCODE_TOKEN, control: !!process.env.SANDBOX_CONTROL_CREDENTIAL, override: !!process.env.GIT_CONFIG_COUNT }))',
          ],
          options
        );
        expect(result.exitCode).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({
          token: false,
          control: false,
          override: false,
        });
      }
      return git(args, options);
    };
    try {
      Object.assign(process.env, overrides);
      const result = await collectWorktreeChanges(directory, { revision: 1 }, runGit);
      expect(inspected).toBe(true);
      expect(result.files).toEqual([]);
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it.each(['unterminated', '\0', '../outside\0', '/absolute\0', 'same\0same\0'])(
    'rejects malformed untracked records %j',
    async untracked => {
      const directory = await createRepo();
      await rejects(
        collectWorktreeChanges(directory, { revision: 1 }, fakeGit({ untracked })),
        /Worktree capture failed/
      );
    }
  );

  it('keeps the tracked deletion once when the same path remains untracked', async () => {
    const directory = await createRepo();
    run(directory, ['rm', '--cached', 'seed.txt']);
    await write(directory, 'seed.txt', 'untracked\nreplacement\n');
    expect(run(directory, ['ls-files', '--others', '--exclude-standard', '-z'])).toBe('seed.txt\0');

    const result = await collectWorktreeChanges(directory, { revision: 1 });
    expect(result.files).toEqual([
      {
        path: 'seed.txt',
        status: 'deleted',
        additions: 0,
        deletions: 1,
        tracked: true,
        binary: false,
        countsComplete: true,
      },
    ]);
    expect(result.truncated).toBe(false);
  });

  it('disables external diff and textconv hooks', async () => {
    const directory = await createRepo({
      '.gitattributes': '*.txt diff=custom\n',
      'seed.txt': 'before\n',
    });
    run(directory, ['config', 'diff.external', 'false']);
    run(directory, ['config', 'diff.custom.command', 'false']);
    run(directory, ['config', 'diff.custom.textconv', 'false']);
    await write(directory, 'seed.txt', 'after\n');
    const result = await collectWorktreeChanges(directory, { revision: 1 });
    expect(result.files).toEqual([
      {
        path: 'seed.txt',
        status: 'modified',
        additions: 1,
        deletions: 1,
        tracked: true,
        binary: false,
        countsComplete: true,
      },
    ]);
  });
});

function snapshotFile(snapshot: SessionGitSnapshotResult, path: string): WorktreeFileRecord {
  const record = snapshot.files.find(file => file.path === path);
  if (!record) throw new Error(`Missing snapshot record: ${path}`);
  return record;
}

function snapshotPatch(snapshot: SessionGitSnapshotResult, path: string): string {
  const { diff } = snapshotFile(snapshot, path);
  if (diff.status !== 'available') throw new Error(`Patch omitted: ${diff.reason}`);
  return diff.patch;
}

describe('collectWorktreeSnapshot', () => {
  it('keeps one merge-base capture for commits, staged and unstaged changes, and untracked files', async () => {
    const directory = await createRepo({ 'changed.txt': 'base\n', 'removed.txt': 'original\n' });
    const ancestor = run(directory, ['rev-parse', 'HEAD']).trim();
    run(directory, ['switch', 'main']);
    await write(directory, 'upstream.txt', 'not a feature change\n');
    run(directory, ['add', '--all']);
    run(directory, ['commit', '-m', 'upstream']);
    run(directory, ['update-ref', baseRef, 'HEAD']);
    run(directory, ['switch', 'feature']);
    await write(directory, 'committed.txt', 'committed\n');
    await write(directory, 'changed.txt', 'base\ncommitted\n');
    run(directory, ['add', '--all']);
    run(directory, ['commit', '-m', 'feature']);
    await write(directory, 'changed.txt', 'base\ncommitted\nstaged\n');
    run(directory, ['add', 'changed.txt']);
    await write(directory, 'changed.txt', 'base\ncommitted\nstaged\nunstaged\n');
    await write(directory, 'untracked.txt', 'untracked\n');
    run(directory, ['rm', '--cached', 'removed.txt']);
    await write(directory, 'removed.txt', 'untracked replacement must not be saved\n');

    const result = await collectWorktreeSnapshot(directory, { revision: 12 });
    expect(result.summary).toEqual(await collectWorktreeChanges(directory, { revision: 12 }));
    expect(result.summary.comparison.mergeBase).toBe(ancestor);
    expect(result.files.map(file => file.path)).toEqual(
      result.summary.files.map(file => file.path)
    );
    expect(snapshotPatch(result, 'changed.txt')).toContain('+committed\n+staged\n+unstaged\n');
    expect(snapshotPatch(result, 'committed.txt')).toContain('+committed\n');
    expect(snapshotPatch(result, 'untracked.txt')).toContain('+untracked\n');
    expect(snapshotFile(result, 'removed.txt').content).toEqual({
      status: 'available',
      source: 'deleted-original',
      text: 'original\n',
    });
    expect(snapshotPatch(result, 'removed.txt')).toContain('-original\n');
    expect(JSON.stringify(result)).not.toContain('untracked replacement must not be saved');
    expect(sessionGitSnapshotResultSchema.safeParse(result).success).toBe(true);
  });

  it('forces canonical U10 context, coalescing, prefixes and blank lines despite Git configuration', async () => {
    const lines = Array.from({ length: 100 }, (_, index) => `line-${index + 1}`);
    lines[20] = '';
    const directory = await createRepo({
      '.gitattributes': '*.txt diff=custom\n',
      'context.txt': `${lines.join('\n')}\n`,
    });
    for (const [name, value] of [
      ['diff.context', '1'],
      ['diff.interHunkContext', '100'],
      ['diff.suppressBlankEmpty', 'true'],
      ['diff.noprefix', 'true'],
      ['diff.mnemonicPrefix', 'true'],
      ['diff.srcPrefix', 'old/'],
      ['diff.dstPrefix', 'new/'],
      ['color.ui', 'always'],
      ['diff.external', 'false'],
      ['diff.custom.command', 'false'],
      ['diff.custom.textconv', 'false'],
    ])
      run(directory, ['config', name, value]);
    lines[29] = 'changed-30';
    lines[44] = 'changed-45';
    lines[74] = 'changed-75';
    await write(directory, 'context.txt', `${lines.join('\n')}\n`);

    const result = await collectWorktreeSnapshot(directory, { revision: 1 });
    const patch = snapshotPatch(result, 'context.txt');
    expect(patch).toStartWith('diff --git a/context.txt b/context.txt\n');
    expect(patch).toContain('--- a/context.txt\n+++ b/context.txt\n');
    expect(patch).toContain('@@ -20,36 +20,36 @@');
    expect(patch).toContain('@@ -65,21 +65,21 @@');
    expect(patch.match(/^@@ /gm)).toHaveLength(2);
    expect(patch).toContain('\n \n');
    expect(patch).not.toContain('\x1b[');
  });

  it('keeps empty and mode-only patches as metadata and captures empty full text', async () => {
    const directory = await createRepo({ 'mode.txt': 'same\n', 'deleted-empty.txt': '' });
    await chmod(join(directory, 'mode.txt'), 0o755);
    await rm(join(directory, 'deleted-empty.txt'));
    await write(directory, 'added-empty.txt', '');
    await write(directory, 'untracked-empty.txt', '');
    run(directory, ['add', 'added-empty.txt']);

    const result = await collectWorktreeSnapshot(directory, { revision: 1 });
    for (const path of [
      'mode.txt',
      'deleted-empty.txt',
      'added-empty.txt',
      'untracked-empty.txt',
    ]) {
      expect(snapshotPatch(result, path)).not.toContain('@@');
    }
    expect(snapshotPatch(result, 'mode.txt')).toContain('old mode 100644\nnew mode 100755\n');
    for (const path of ['added-empty.txt', 'untracked-empty.txt']) {
      expect(snapshotFile(result, path).content).toEqual({
        status: 'available',
        source: 'current',
        text: '',
      });
    }
    expect(snapshotFile(result, 'deleted-empty.txt').content).toEqual({
      status: 'available',
      source: 'deleted-original',
      text: '',
    });
  });

  it('uses literal exact filenames for both tracked and safely copied untracked patches', async () => {
    const names = [
      ' leading space ',
      '\ttab\tname',
      'new\nline',
      'quote"back\\slash',
      'café-漢-𐐀',
      '-dash',
      ':(glob)*',
    ];
    const directory = await createRepo(
      Object.fromEntries(names.map(name => [`tracked/${name}`, 'before\n']))
    );
    for (const name of names) {
      await write(directory, `tracked/${name}`, 'after\n');
      await write(directory, `untracked/${name}`, 'new\n');
    }
    const result = await collectWorktreeSnapshot(directory, { revision: 3 });
    expect(result.files).toHaveLength(names.length * 2);
    for (const name of names) {
      for (const prefix of ['tracked', 'untracked']) {
        const path = `${prefix}/${name}`;
        const patch = snapshotPatch(result, path);
        expect(patch.match(/^diff --git /gm)).toHaveLength(1);
        expect(snapshotFile(result, path).content).toEqual({
          status: 'available',
          source: 'current',
          text: prefix === 'tracked' ? 'after\n' : 'new\n',
        });
      }
    }
  });

  it('retains a small patch when complete current contents exceed 100 KiB', async () => {
    const lines = Array.from({ length: 4000 }, (_, index) => `${index}:${'x'.repeat(100)}\n`);
    const directory = await createRepo({ 'schema.ts': lines.join('') });
    lines[2000] = 'changed\n';
    await write(directory, 'schema.ts', lines.join(''));
    const result = await collectWorktreeSnapshot(directory, { revision: 1 });
    expect(Buffer.byteLength(snapshotPatch(result, 'schema.ts'))).toBeLessThan(4000);
    expect(snapshotFile(result, 'schema.ts').content).toEqual({
      status: 'unavailable',
      reason: 'too_large',
    });
  });

  it('uses the exclusive UTF-8 content byte boundary without excluding the patches', async () => {
    const directory = await createRepo();
    const text = `${'é'.repeat(MAX_WORKTREE_CONTENT_BYTES / 2 - 1)}x`;
    await write(directory, 'below.txt', text);
    await write(directory, 'at.txt', `${text}x`);
    await write(directory, 'above.txt', `${text}xx`);
    const result = await collectWorktreeSnapshot(directory, { revision: 1 });
    expect(snapshotFile(result, 'below.txt').content).toEqual({
      status: 'available',
      source: 'current',
      text,
    });
    for (const path of ['at.txt', 'above.txt']) {
      expect(snapshotFile(result, path).diff.status).toBe('available');
      expect(snapshotFile(result, path).content).toEqual({
        status: 'unavailable',
        reason: 'too_large',
      });
    }
  });

  it('rejects raw invalid UTF-8 in patches and complete contents without replacement decoding', async () => {
    const lines = Array.from({ length: 100 }, (_, index) => `line-${index}\n`).join('');
    const original = Buffer.concat([Buffer.from(lines), Buffer.from([0xff, 10])]);
    const directory = await createRepo({
      'invalid-diff.txt': 'before\n',
      'invalid-content.txt': original,
    });
    await write(directory, 'invalid-diff.txt', Buffer.from([0xff, 10]));
    await write(directory, 'invalid-untracked.txt', Buffer.from([0xc3, 0x28, 10]));
    await write(
      directory,
      'invalid-content.txt',
      Buffer.concat([Buffer.from('changed\n'), original])
    );
    const result = await collectWorktreeSnapshot(directory, { revision: 1 });
    for (const path of ['invalid-diff.txt', 'invalid-untracked.txt']) {
      expect(snapshotFile(result, path).diff).toEqual({
        status: 'omitted',
        reason: 'invalid_utf8',
      });
      expect(snapshotFile(result, path).content).toEqual({
        status: 'unavailable',
        reason: 'invalid_utf8',
      });
    }
    expect(snapshotFile(result, 'invalid-content.txt').diff.status).toBe('available');
    expect(snapshotFile(result, 'invalid-content.txt').content).toEqual({
      status: 'unavailable',
      reason: 'invalid_utf8',
    });
    expect(JSON.stringify(result)).not.toContain('\ufffd');
  });

  it('omits binary files including NUL bytes beyond the summary sample', async () => {
    const directory = await createRepo({ 'tracked.bin': Buffer.from([0, 1]) });
    await write(directory, 'tracked.bin', Buffer.from([0, 2]));
    await write(directory, 'untracked.bin', Buffer.from([0, 3]));
    await write(directory, 'late-nul.txt', `${'x'.repeat(8192)}\0`);
    const result = await collectWorktreeSnapshot(directory, { revision: 1 });
    for (const file of result.files) {
      expect(file.diff).toEqual({ status: 'omitted', reason: 'binary' });
      expect(file.content).toEqual({ status: 'unavailable', reason: 'binary' });
    }
  });
});

describe('snapshot capture boundaries', () => {
  it('keeps ignored files undiscovered and rejects a nested repository directory', async () => {
    const directory = await createRepo({ '.gitignore': '.kilo/plans/\nignored.txt\n' });
    await write(directory, '.kilo/plans/plan.md', 'ignored-content\n');
    await write(directory, 'ignored.txt', 'ignored-content\n');
    await write(directory, '.kilo-bootstrap-complete', 'marker\n');
    const result = await collectWorktreeSnapshot(directory, { revision: 1 });
    expect(result.summary.files).toEqual([]);
    expect(result.files).toEqual([]);
    await mkdir(join(directory, 'nested'));
    await rejects(
      collectWorktreeSnapshot(join(directory, 'nested'), { revision: 2 }),
      /Worktree capture failed/
    );
  });

  it('bounds oversized untracked regular-file reads and accepts no-index difference exit status', async () => {
    const directory = await createRepo();
    await write(directory, 'a-large.txt', 'x'.repeat(8192));
    await truncate(join(directory, 'a-large.txt'), 2 ** 31);
    await write(directory, 'z-small.txt', 'small\n');
    let differences = 0;
    const checkingGit: typeof git = async (args, options) => {
      expect(options?.env?.GIT_NO_LAZY_FETCH).toBe('1');
      expect(options?.env?.GIT_LITERAL_PATHSPECS).toBe('1');
      expect(options?.rawOutput).toBe(true);
      const result = await git(args, options);
      if (args.includes('--no-index')) {
        expect(result.exitCode).toBe(1);
        differences += 1;
      }
      return result;
    };
    const result = await collectWorktreeSnapshot(directory, { revision: 1 }, checkingGit);
    expect(snapshotFile(result, 'a-large.txt').diff).toEqual({
      status: 'omitted',
      reason: 'too_large',
    });
    expect(snapshotFile(result, 'a-large.txt').content).toEqual({
      status: 'unavailable',
      reason: 'too_large',
    });
    expect(snapshotPatch(result, 'z-small.txt')).toContain('+small\n');
    expect(differences).toBe(1);
  });

  it('applies the exclusive content-byte boundary to immutable deleted originals', async () => {
    const below = `${'é'.repeat(MAX_WORKTREE_CONTENT_BYTES / 2 - 1)}x`;
    const directory = await createRepo({ 'below.txt': below, 'at.txt': `${below}x` });
    run(directory, ['rm', '--cached', 'below.txt', 'at.txt']);
    await write(directory, 'below.txt', 'replacement\n');
    await write(directory, 'at.txt', 'replacement\n');
    const result = await collectWorktreeSnapshot(directory, { revision: 1 });
    expect(snapshotFile(result, 'below.txt').content).toEqual({
      status: 'available',
      source: 'deleted-original',
      text: below,
    });
    expect(snapshotFile(result, 'at.txt').content).toEqual({
      status: 'unavailable',
      reason: 'too_large',
    });
    expect(snapshotFile(result, 'at.txt').diff.status).toBe('available');
    expect(JSON.stringify(result)).not.toContain('replacement');
  });

  it('continues after an oversized encoded patch and applies separate patch and source line limits', async () => {
    const lines = Array.from({ length: 10_001 }, (_, index) => `line-${index}\n`);
    const directory = await createRepo({
      'a-escaped.txt': `${'x'.repeat(210 * 1024)}\n`,
      'line-limited-source.txt': lines.join(''),
      'z-small.sql': 'SELECT 1;\n',
    });
    await write(directory, 'a-escaped.txt', `${'"'.repeat(210 * 1024)}\n`);
    lines[0] = 'changed\n';
    await write(directory, 'line-limited-source.txt', lines.join(''));
    await write(directory, 'line-limited-patch.txt', 'x\n'.repeat(10_000));
    await write(directory, 'z-small.sql', 'SELECT 2;\n');
    const result = await collectWorktreeSnapshot(directory, { revision: 1 });
    expect(snapshotFile(result, 'a-escaped.txt').diff).toEqual({
      status: 'omitted',
      reason: 'too_large',
    });
    expect(snapshotFile(result, 'line-limited-patch.txt').diff).toEqual({
      status: 'omitted',
      reason: 'line_limit',
    });
    expect(snapshotFile(result, 'line-limited-patch.txt').content.status).toBe('available');
    expect(snapshotFile(result, 'line-limited-source.txt').diff.status).toBe('available');
    expect(snapshotFile(result, 'line-limited-source.txt').content).toEqual({
      status: 'unavailable',
      reason: 'line_limit',
    });
    expect(snapshotPatch(result, 'z-small.sql')).toContain('+SELECT 2;\n');
    for (const file of result.files)
      expect(Buffer.byteLength(JSON.stringify(file))).toBeLessThanOrEqual(MAX_WORKTREE_FILE_BYTES);
  });

  it('spends capture space on ordinary diffs before generated files or optional contents', async () => {
    const ordinary = [
      ...Array.from({ length: 32 }, (_, index) => `code-${String(index).padStart(2, '0')}.txt`),
      'schema.ts',
      'migrations/0001.sql',
    ];
    const generated = ['aaa-generated.txt', 'Cargo.lock'];
    const before = `${'b'.repeat(210 * 1024)}\n`;
    const after = `${'c'.repeat(90 * 1024)}\n`;
    const directory = await createRepo({
      '.gitattributes': 'aaa-generated.txt linguist-generated=true\n',
      ...Object.fromEntries([...ordinary, ...generated].map(path => [path, before])),
      'a-oversized.txt': 'before\n',
      'z-small.sql': 'SELECT 1;\n',
    });
    for (const path of [...ordinary, ...generated]) await write(directory, path, after);
    await write(directory, 'a-oversized.txt', 'x'.repeat(MAX_WORKTREE_FILE_BYTES + 1));
    await write(directory, 'z-small.sql', 'SELECT 2;\n');

    const result = await collectWorktreeSnapshot(directory, { revision: 1 });
    expect(result.summary.truncated).toBe(false);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
      MAX_WORKTREE_SNAPSHOT_BYTES
    );
    expect(Buffer.byteLength(JSON.stringify(result))).toBeGreaterThan(
      MAX_WORKTREE_SNAPSHOT_BYTES - 100 * 1024
    );
    for (const path of ordinary) {
      expect(snapshotFile(result, path).diff.status).toBe('available');
      expect(snapshotFile(result, path).content).toEqual({
        status: 'unavailable',
        reason: 'budget_exhausted',
      });
    }
    for (const path of generated)
      expect(snapshotFile(result, path).diff).toEqual({
        status: 'omitted',
        reason: 'budget_exhausted',
      });
    expect(snapshotFile(result, 'a-oversized.txt').diff).toEqual({
      status: 'omitted',
      reason: 'too_large',
    });
    expect(snapshotPatch(result, 'z-small.sql')).toContain('+SELECT 2;\n');
    expect(sessionGitSnapshotResultSchema.safeParse(result).success).toBe(true);
  }, 60_000);

  it('drops optional complete content rather than an admitted patch when the record budget is full', async () => {
    const directory = await createRepo({ 'replaced.txt': `${'b'.repeat(400 * 1024)}\n` });
    await write(directory, 'replaced.txt', `${'c'.repeat(80 * 1024)}\n`);
    const result = await collectWorktreeSnapshot(directory, { revision: 1 });
    expect(snapshotFile(result, 'replaced.txt').diff.status).toBe('available');
    expect(snapshotFile(result, 'replaced.txt').content).toEqual({
      status: 'unavailable',
      reason: 'too_large',
    });
    expect(
      Buffer.byteLength(JSON.stringify(snapshotFile(result, 'replaced.txt')))
    ).toBeLessThanOrEqual(MAX_WORKTREE_FILE_BYTES);
  });

  it.each([
    { stdoutTruncated: true },
    { stderrTruncated: true },
    { exitCode: 124, terminationReason: 'timeout' },
    { exitCode: 2 },
  ] satisfies Partial<ExecResult>[])(
    'keeps the summary and emits omissions on failed patch output %j',
    async failure => {
      const directory = await createRepo();
      await write(directory, 'seed.txt', 'after\n');
      const failedGit: typeof git = async (args, options) => {
        const result = await git(args, options);
        return args.includes('--patch') ? { ...result, ...failure } : result;
      };
      const result = await collectWorktreeSnapshot(directory, { revision: 1 }, failedGit);
      expect(result.summary.files).toHaveLength(1);
      expect(snapshotFile(result, 'seed.txt').diff.status).toBe('omitted');
    }
  );

  it('rejects incomplete patches and truncated immutable base blobs without publishing partial data', async () => {
    const directory = await createRepo({ 'changed.txt': 'before\n', 'deleted.txt': 'original\n' });
    await write(directory, 'changed.txt', 'after\n');
    await rm(join(directory, 'deleted.txt'));
    const truncatedGit: typeof git = async (args, options) => {
      const result = await git(args, options);
      if (args.includes('--patch') && args.at(-1) === 'changed.txt') {
        return { ...result, stdoutBytes: result.stdoutBytes?.subarray(0, -1) };
      }
      if (args.includes('cat-file') && args.includes('blob')) {
        return { ...result, stdoutTruncated: true };
      }
      return result;
    };
    const result = await collectWorktreeSnapshot(directory, { revision: 1 }, truncatedGit);
    expect(snapshotFile(result, 'changed.txt').diff).toEqual({
      status: 'omitted',
      reason: 'capture_failed',
    });
    expect(snapshotFile(result, 'deleted.txt').diff).toEqual({
      status: 'omitted',
      reason: 'too_large',
    });
    expect(snapshotFile(result, 'deleted.txt').content).toEqual({
      status: 'unavailable',
      reason: 'too_large',
    });
  });

  it('does not follow symlinks, parent escapes, special files or gitlinks', async () => {
    const directory = await createRepo({ 'tracked-link.txt': 'before\n' });
    const outside = await mkdtemp(join(tmpdir(), 'snapshot-outside-'));
    directories.push(outside);
    await write(outside, 'secret.txt', 'outside-content-must-not-escape\n');
    await rm(join(directory, 'tracked-link.txt'));
    await symlink(join(outside, 'secret.txt'), join(directory, 'tracked-link.txt'));
    await symlink(join(outside, 'secret.txt'), join(directory, 'untracked-link.txt'));
    await symlink(outside, join(directory, 'parent'));
    const fifo = Bun.spawnSync(['mkfifo', join(directory, 'pipe')]);
    expect(fifo.exitCode).toBe(0);
    await mkdir(join(directory, 'submodule'));
    run(join(directory, 'submodule'), ['init', '-b', 'main']);
    run(join(directory, 'submodule'), ['commit', '--allow-empty', '-m', 'submodule']);
    run(directory, ['add', 'submodule']);
    const enumeratingGit: typeof git = async (args, options) => {
      const result = await git(args, options);
      if (args.includes('ls-files')) {
        const paths = new Set((result.stdoutBytes?.toString() ?? '').split('\0').filter(Boolean));
        paths.add('parent/secret.txt');
        paths.add('pipe');
        return { ...result, stdoutBytes: Buffer.from(`${[...paths].join('\0')}\0`) };
      }
      return result;
    };
    const result = await collectWorktreeSnapshot(directory, { revision: 1 }, enumeratingGit);
    for (const path of [
      'tracked-link.txt',
      'untracked-link.txt',
      'parent/secret.txt',
      'pipe',
      'submodule',
    ]) {
      expect(snapshotFile(result, path).diff).toEqual({ status: 'omitted', reason: 'unsupported' });
      expect(snapshotFile(result, path).content).toEqual({
        status: 'unavailable',
        reason: 'unsupported',
      });
    }
    expect(JSON.stringify(result)).not.toContain('outside-content-must-not-escape');
    expect(JSON.stringify(result)).not.toContain(outside);
  });

  it.each(['file', 'parent'])(
    'omits an unstable %s instead of pairing the patch with newer or escaped contents',
    async movement => {
      const directory = await createRepo({ 'nested/changed.txt': 'before\n' });
      await write(directory, 'nested/changed.txt', 'after\n');
      const outside = await mkdtemp(join(tmpdir(), 'snapshot-race-'));
      directories.push(outside);
      await write(outside, 'changed.txt', 'outside-race-content\n');
      const movingGit: typeof git = async (args, options) => {
        if (movement === 'parent' && args.includes('--patch')) {
          await rename(join(directory, 'nested'), join(directory, 'old-parent'));
          await symlink(outside, join(directory, 'nested'));
        }
        const result = await git(args, options);
        if (args.includes('--patch')) {
          if (movement === 'file') await write(directory, 'nested/changed.txt', 'newer content\n');
          else {
            await rm(join(directory, 'nested'));
            await rename(join(directory, 'old-parent'), join(directory, 'nested'));
          }
        }
        return result;
      };
      const result = await collectWorktreeSnapshot(directory, { revision: 1 }, movingGit);
      expect(snapshotFile(result, 'nested/changed.txt').diff).toEqual({
        status: 'omitted',
        reason: 'inconsistent',
      });
      expect(snapshotFile(result, 'nested/changed.txt').content).toEqual({
        status: 'unavailable',
        reason: 'inconsistent',
      });
      expect(JSON.stringify(result)).not.toContain('outside-race-content');
    }
  );

  it('preserves the enumerated summary when an untracked file disappears', async () => {
    const directory = await createRepo();
    await write(directory, 'vanishing.txt', 'before\n');
    const movingGit: typeof git = async (args, options) => {
      const result = await git(args, options);
      if (args.includes('ls-files')) await rm(join(directory, 'vanishing.txt'));
      return result;
    };
    const result = await collectWorktreeSnapshot(directory, { revision: 1 }, movingGit);
    expect(result.summary.files).toHaveLength(1);
    expect(snapshotFile(result, 'vanishing.txt').diff.status).toBe('omitted');
  });

  it.each(['patch', 'content'])(
    'reserves final consistency checks when %s capture consumes the remaining time',
    async stage => {
      const directory = await createRepo({
        'a.txt': stage === 'content' ? `${'a'.repeat(MAX_WORKTREE_CONTENT_BYTES)}\n` : 'a\n',
        'b.txt': 'b\n',
      });
      await rm(join(directory, 'a.txt'));
      await rm(join(directory, 'b.txt'));
      let now = Date.now();
      const clock = spyOn(Date, 'now').mockImplementation(() => now);
      const operations: string[][] = [];
      let exhausted = false;
      try {
        const slowGit: typeof git = async (args, options) => {
          operations.push(args);
          const result = await git(args, options);
          if (
            !exhausted &&
            (stage === 'patch'
              ? args.includes('--patch')
              : args.includes('cat-file') &&
                operations.filter(operation => operation.includes('--patch')).length === 2)
          ) {
            now += 18_100;
            exhausted = true;
          }
          return result;
        };
        const result = await collectWorktreeSnapshot(directory, { revision: 1 }, slowGit);
        expect(result.summary.files).toHaveLength(2);
        expect(operations.filter(args => args.includes('--verify'))).toHaveLength(4);
        for (const file of result.files) {
          expect(file.diff.status).toBe(stage === 'patch' ? 'omitted' : 'available');
          expect(file.content).toEqual({ status: 'unavailable', reason: 'budget_exhausted' });
        }
        if (stage === 'content') {
          expect(operations.filter(args => args.includes('--patch'))).toHaveLength(2);
        }
      } finally {
        clock.mockRestore();
      }
    }
  );

  it.each(['head', 'base', 'default-target'])(
    'rejects %s movement even after all file records were captured',
    async movement => {
      const directory = await createRepo();
      run(directory, ['commit', '--allow-empty', '-m', 'feature']);
      run(directory, ['update-ref', 'refs/remotes/origin/other', baseRef]);
      await write(directory, 'seed.txt', 'after\n');
      const movingGit: typeof git = async (args, options) => {
        const result = await git(args, options);
        if (args.includes('--patch')) {
          if (movement === 'head') run(directory, ['commit', '--allow-empty', '-m', 'moving']);
          if (movement === 'base') run(directory, ['update-ref', baseRef, 'HEAD']);
          if (movement === 'default-target')
            run(directory, [
              'symbolic-ref',
              'refs/remotes/origin/HEAD',
              'refs/remotes/origin/other',
            ]);
        }
        return result;
      };
      await rejects(
        collectWorktreeSnapshot(directory, { revision: 1 }, movingGit),
        /Worktree capture failed/
      );
    }
  );
});

describe('capture review regressions', () => {
  it.each(['system temp', 'checkout parent'])(
    'captures stable files during unrelated concurrent activity in the %s directory',
    async location => {
      const original = await createRepo({ 'tracked.txt': 'before\n', 'deleted.txt': 'original\n' });
      const parent = await mkdtemp(join(tmpdir(), 'worktree-concurrent-'));
      directories.push(parent);
      const directory = join(parent, 'checkout');
      await rename(original, directory);
      await write(directory, 'tracked.txt', 'after\n');
      await write(directory, 'untracked.txt', 'new\n');
      await rm(join(directory, 'deleted.txt'));
      const activityRoot = location === 'system temp' ? tmpdir() : parent;
      let active = true;
      let cycles = 0;
      const activity = (async () => {
        while (active) {
          const temporary = await mkdtemp(join(activityRoot, 'unrelated-cache-'));
          try {
            await writeFile(join(temporary, 'cache'), 'unrelated activity\n');
          } finally {
            await rm(temporary, { recursive: true, force: true });
          }
          cycles += 1;
          await delay(2);
        }
      })();
      try {
        const result = await collectWorktreeSnapshot(directory, { revision: 1 });
        expect(cycles).toBeGreaterThan(0);
        expect(result.files.every(file => file.diff.status === 'available')).toBe(true);
        expect(snapshotPatch(result, 'tracked.txt')).toContain('+after\n');
        expect(snapshotFile(result, 'tracked.txt').content).toEqual({
          status: 'available',
          source: 'current',
          text: 'after\n',
        });
        expect(snapshotPatch(result, 'untracked.txt')).toContain('+new\n');
        expect(snapshotFile(result, 'deleted.txt').content).toEqual({
          status: 'available',
          source: 'deleted-original',
          text: 'original\n',
        });
      } finally {
        active = false;
        await activity;
      }
    }
  );

  it.each([
    { relativeRoot: 'checkout', churn: false },
    { relativeRoot: 'parent/checkout', churn: false },
    { relativeRoot: 'checkout', churn: true },
  ])(
    'rejects a restored ancestor swap above the repository root %j',
    async ({ relativeRoot, churn }) => {
      const original = await createRepo();
      const container = await realpath(await mkdtemp(join(tmpdir(), 'worktree-ancestor-')));
      directories.push(container);
      const active = join(container, 'active');
      const outside = join(container, 'outside');
      const backup = join(container, 'backup');
      const directory = join(active, relativeRoot);
      const outsideRoot = join(outside, relativeRoot);
      await mkdir(dirname(directory), { recursive: true });
      await mkdir(dirname(outsideRoot), { recursive: true });
      await rename(original, directory);
      run(container, ['clone', '--no-hardlinks', directory, outsideRoot]);
      await write(directory, 'seed.txt', 'inside-source\n');
      await write(outsideRoot, 'seed.txt', 'outside-checkout-patch\n');
      let swapped = false;
      const movingGit: typeof git = async (args, options) => {
        if (!args.includes('--patch')) return git(args, options);
        swapped = true;
        await rename(active, backup);
        await rename(outside, active);
        try {
          return await git(args, options);
        } finally {
          await rename(active, outside);
          await rename(backup, active);
          if (churn) {
            const temporary = await mkdtemp(join(active, 'unrelated-cache-'));
            await rm(temporary, { recursive: true, force: true });
          }
        }
      };
      const result = await collectWorktreeSnapshot(directory, { revision: 1 }, movingGit);
      expect(swapped).toBe(true);
      expect(JSON.stringify(result).includes('outside-checkout-patch')).toBe(false);
      expect(snapshotFile(result, 'seed.txt').diff).toEqual({
        status: 'omitted',
        reason: 'inconsistent',
      });
      expect(snapshotFile(result, 'seed.txt').content).toEqual({
        status: 'unavailable',
        reason: 'inconsistent',
      });
    }
  );

  it.each(['sha1', 'sha256'] as const)(
    'verifies %s patch identities using Git normalization without changing saved source bytes',
    async objectFormat => {
      const directory = await createRepo(
        {
          '.gitattributes': '*.txt text eol=lf\n',
          'normalized.txt': 'before\n',
        },
        objectFormat
      );
      const text = 'after\r\n';
      await write(directory, 'normalized.txt', text);
      const result = await collectWorktreeSnapshot(directory, { revision: 1 });
      expect(snapshotPatch(result, 'normalized.txt')).toContain('-before\n+after\n');
      expect(snapshotFile(result, 'normalized.txt').content).toEqual({
        status: 'available',
        source: 'current',
        text,
      });
      expect(result.summary.comparison.head).toHaveLength(objectFormat === 'sha1' ? 40 : 64);
    }
  );

  it('captures the untracked exact dash filename rather than Git stdin', async () => {
    const directory = await createRepo();
    await write(directory, '-', 'literal dash contents\n');
    const result = await collectWorktreeSnapshot(directory, { revision: 1 });
    const patch = snapshotPatch(result, '-');
    expect(patch).toStartWith('diff --git a/- b/-\n');
    expect(patch).toContain('+++ b/-\n');
    expect(patch).toContain('@@ -0,0 +1 @@\n+literal dash contents\n');
    expect(snapshotFile(result, '-').content).toEqual({
      status: 'available',
      source: 'current',
      text: 'literal dash contents\n',
    });
  });

  it('preserves header-like source text when disambiguating the dash filename', async () => {
    const directory = await createRepo();
    const text = '++ b/./-\n-- a/./-\n';
    await write(directory, '-', text);
    const result = await collectWorktreeSnapshot(directory, { revision: 1 });
    const patch = snapshotPatch(result, '-');
    expect(patch).toStartWith('diff --git a/- b/-\n');
    expect(patch).toContain('--- /dev/null\n+++ b/-\n');
    expect(patch).toContain('\n+++ b/./-\n+-- a/./-\n');
    expect(snapshotFile(result, '-').content).toEqual({
      status: 'available',
      source: 'current',
      text,
    });
  });

  it.each(['file-to-directory', 'directory-to-file'])(
    'captures separate exact records for a tracked %s replacement',
    async direction => {
      const deletedPath = direction === 'file-to-directory' ? 'foo' : 'foo/bar';
      const addedPath = direction === 'file-to-directory' ? 'foo/bar' : 'foo';
      const directory = await createRepo({ [deletedPath]: 'original\n' });
      run(directory, ['rm', '-r', '--', 'foo']);
      await write(directory, addedPath, 'replacement\n');
      run(directory, ['add', '--', 'foo']);
      const result = await collectWorktreeSnapshot(directory, { revision: 1 });
      expect(result.summary.files.map(file => [file.path, file.status])).toEqual([
        ['foo', direction === 'file-to-directory' ? 'deleted' : 'added'],
        ['foo/bar', direction === 'file-to-directory' ? 'added' : 'deleted'],
      ]);
      expect(snapshotFile(result, deletedPath).content).toEqual({
        status: 'available',
        source: 'deleted-original',
        text: 'original\n',
      });
      const deletedPatch = snapshotPatch(result, deletedPath);
      expect(deletedPatch).toStartWith(`diff --git a/${deletedPath} b/${deletedPath}\n`);
      expect(deletedPatch).toContain('-original\n');
      expect(deletedPatch.match(/^diff --git /gm)).toHaveLength(1);
      expect(deletedPatch).not.toContain('+replacement');
      expect(snapshotFile(result, addedPath).content).toEqual({
        status: 'available',
        source: 'current',
        text: 'replacement\n',
      });
      const addedPatch = snapshotPatch(result, addedPath);
      expect(addedPatch).toStartWith(`diff --git a/${addedPath} b/${addedPath}\n`);
      expect(addedPatch).toContain('+replacement\n');
      expect(addedPatch.match(/^diff --git /gm)).toHaveLength(1);
    }
  );

  it('keeps temporary file hierarchies isolated when a generated untracked file replaces a directory', async () => {
    const directory = await createRepo({
      '.gitattributes': 'foo linguist-generated=true\n',
      'foo/bar': 'original\n',
    });
    run(directory, ['rm', '-r', '--', 'foo']);
    await write(directory, 'foo', 'replacement\n');
    const result = await collectWorktreeSnapshot(directory, { revision: 1 });
    expect(snapshotPatch(result, 'foo/bar')).toContain('-original\n');
    expect(snapshotPatch(result, 'foo')).toContain('+replacement\n');
    expect(snapshotFile(result, 'foo/bar').content).toEqual({
      status: 'available',
      source: 'deleted-original',
      text: 'original\n',
    });
    expect(snapshotFile(result, 'foo').content).toEqual({
      status: 'available',
      source: 'current',
      text: 'replacement\n',
    });
  });

  it('preserves deleted executable modes, empty metadata and exact dash headers', async () => {
    const text = '++ /dev/null\n-- a/./-\n';
    const directory = await createRepo({ '-': text, 'empty.sh': '' });
    await chmod(join(directory, '-'), 0o755);
    await chmod(join(directory, 'empty.sh'), 0o755);
    run(directory, ['add', '--all']);
    run(directory, ['commit', '-m', 'executable base']);
    run(directory, ['update-ref', baseRef, 'HEAD']);
    run(directory, ['rm', '--', '-', 'empty.sh']);
    const result = await collectWorktreeSnapshot(directory, { revision: 1 });
    const patch = snapshotPatch(result, '-');
    expect(patch).toStartWith('diff --git a/- b/-\n');
    expect(patch).toContain('deleted file mode 100755\n');
    expect(patch).toContain('--- a/-\n+++ /dev/null\n');
    expect(patch).toContain('\n-++ /dev/null\n--- a/./-\n');
    expect(snapshotFile(result, '-').content).toEqual({
      status: 'available',
      source: 'deleted-original',
      text,
    });
    const emptyPatch = snapshotPatch(result, 'empty.sh');
    expect(emptyPatch).toContain('deleted file mode 100755\n');
    expect(emptyPatch).not.toContain('@@');
    expect(snapshotFile(result, 'empty.sh').content).toEqual({
      status: 'available',
      source: 'deleted-original',
      text: '',
    });
  });

  it('probes deleted blob sizes before bounded reads and rejects invalid base UTF-8', async () => {
    const directory = await createRepo({
      'invalid.txt': Buffer.from([0xff, 10]),
      'oversized.txt': 'x'.repeat(MAX_WORKTREE_FILE_BYTES * 4),
      'z-small.txt': 'small\n',
    });
    run(directory, ['rm', '--', 'invalid.txt', 'oversized.txt', 'z-small.txt']);
    const bodyReads: string[] = [];
    const checkingGit: typeof git = async (args, options) => {
      if (args.includes('cat-file') && args.includes('blob')) {
        bodyReads.push(args.at(-1) ?? '');
        expect(options?.maxOutputBytes).toBeLessThanOrEqual(MAX_WORKTREE_FILE_BYTES);
      }
      return git(args, options);
    };
    const result = await collectWorktreeSnapshot(directory, { revision: 1 }, checkingGit);
    expect(bodyReads.some(blob => blob.endsWith(':oversized.txt'))).toBe(false);
    expect(snapshotFile(result, 'oversized.txt').diff).toEqual({
      status: 'omitted',
      reason: 'too_large',
    });
    expect(snapshotFile(result, 'oversized.txt').content).toEqual({
      status: 'unavailable',
      reason: 'too_large',
    });
    expect(snapshotFile(result, 'invalid.txt').diff).toEqual({
      status: 'omitted',
      reason: 'invalid_utf8',
    });
    expect(snapshotFile(result, 'invalid.txt').content).toEqual({
      status: 'unavailable',
      reason: 'invalid_utf8',
    });
    expect(snapshotPatch(result, 'z-small.txt')).toContain('-small\n');
    expect(snapshotFile(result, 'z-small.txt').content).toEqual({
      status: 'available',
      source: 'deleted-original',
      text: 'small\n',
    });
  });

  it('keeps canonical U10 when GIT_DIFF_OPTS requests zero context', async () => {
    const lines = Array.from({ length: 80 }, (_, index) => `line-${index + 1}`);
    const directory = await createRepo({ 'context.txt': `${lines.join('\n')}\n` });
    lines[39] = 'changed-40';
    await write(directory, 'context.txt', `${lines.join('\n')}\n`);
    const previous = process.env.GIT_DIFF_OPTS;
    process.env.GIT_DIFF_OPTS = '--unified=0';
    try {
      const result = await collectWorktreeSnapshot(directory, { revision: 1 });
      const patch = snapshotPatch(result, 'context.txt');
      expect(patch).toContain('@@ -30,21 +30,21 @@');
      expect(patch).toContain(' line-30\n');
      expect(patch).toContain(' line-50\n');
    } finally {
      if (previous === undefined) delete process.env.GIT_DIFF_OPTS;
      else process.env.GIT_DIFF_OPTS = previous;
    }
  });
});

describe('capture Git isolation regressions', () => {
  it.each([
    { location: 'original', deleted: false },
    { location: 'original', deleted: true },
    { location: 'swapped', deleted: false },
  ])(
    'ignores replacement objects in original summaries and swapped captures %j',
    async ({ location, deleted }) => {
      const original = await createRepo({ 'seed.txt': 'original base\n' });
      const container = await realpath(await mkdtemp(join(tmpdir(), 'worktree-replace-')));
      directories.push(container);
      const active = join(container, 'active');
      const outside = join(container, 'outside');
      const backup = join(container, 'backup');
      const directory = join(active, 'checkout');
      const outsideRoot = join(outside, 'checkout');
      await mkdir(active);
      await mkdir(outside);
      await rename(original, directory);
      run(container, ['clone', '--no-hardlinks', directory, outsideRoot]);
      if (deleted) await rm(join(directory, 'seed.txt'));
      else await write(directory, 'seed.txt', 'same current bytes\n');
      await write(outsideRoot, 'seed.txt', 'same current bytes\n');
      const originalBlob = run(directory, ['rev-parse', `${baseRef}:seed.txt`]).trim();
      const replacementPath = join(container, 'replacement');
      await writeFile(
        replacementPath,
        location === 'original' ? 'outside deleted line\nextra line\n' : 'outside deleted line\n'
      );
      const replacementRoot = location === 'original' ? directory : outsideRoot;
      const replacementBlob = run(replacementRoot, [
        'hash-object',
        '--no-filters',
        '-w',
        '--',
        replacementPath,
      ]).trim();
      run(replacementRoot, ['replace', originalBlob, replacementBlob]);
      const replacementSettings: Array<string | undefined> = [];
      const replacingGit: typeof git = async (args, options) => {
        replacementSettings.push(options?.env?.GIT_NO_REPLACE_OBJECTS);
        if (location !== 'swapped' || !args.includes('--patch')) return git(args, options);
        await rename(active, backup);
        await rename(outside, active);
        try {
          return await git(args, options);
        } finally {
          await rename(active, outside);
          await rename(backup, active);
        }
      };
      const summary = await collectWorktreeChanges(directory, { revision: 1 }, replacingGit);
      const result = await collectWorktreeSnapshot(directory, { revision: 1 }, replacingGit);
      expect(summary.files[0].deletions).toBe(1);
      expect(result.summary).toEqual(summary);
      expect(JSON.stringify(result).includes('outside deleted line')).toBe(false);
      expect(snapshotPatch(result, 'seed.txt')).toContain('-original base\n');
      expect(snapshotFile(result, 'seed.txt').content).toEqual({
        status: 'available',
        source: deleted ? 'deleted-original' : 'current',
        text: deleted ? 'original base\n' : 'same current bytes\n',
      });
      expect(replacementSettings.length).toBeGreaterThan(0);
      expect(replacementSettings.every(value => value === '1')).toBe(true);
    }
  );

  it('does not let a deleted attributes file normalize its own immutable bytes', async () => {
    const text = '* text eol=lf ident\r\n';
    const directory = await createRepo({ '.gitattributes': text });
    const blob = run(directory, [
      'hash-object',
      '--no-filters',
      '-w',
      '--',
      '.gitattributes',
    ]).trim();
    run(directory, ['update-index', '--cacheinfo', `100644,${blob},.gitattributes`]);
    run(directory, ['commit', '-m', 'raw attributes base']);
    run(directory, ['update-ref', baseRef, 'HEAD']);
    run(directory, ['rm', '-f', '--', '.gitattributes']);
    expect(run(directory, ['cat-file', 'blob', `${baseRef}:.gitattributes`])).toBe(text);
    const result = await collectWorktreeSnapshot(directory, { revision: 1 });
    const patch = snapshotPatch(result, '.gitattributes');
    expect(patch).toContain('-* text eol=lf ident\r\n');
    const capturedHash = /^index ([0-9a-f]+)\.\.0+$/m.exec(patch)?.[1];
    if (!capturedHash) throw new Error('Missing deleted blob identity');
    expect(blob.startsWith(capturedHash)).toBe(true);
    expect(snapshotFile(result, '.gitattributes').content).toEqual({
      status: 'available',
      source: 'deleted-original',
      text,
    });
  });

  it.each(['autocrlf', 'attributes'])(
    'preserves immutable CRLF deletion bytes despite global %s settings',
    async setting => {
      const text = '$Id: preserved value $\r\noriginal line\r\n';
      const directory = await createRepo({ 'deleted.txt': text });
      run(directory, ['config', 'core.autocrlf', 'false']);
      await rm(join(directory, 'deleted.txt'));
      const global = await mkdtemp(join(tmpdir(), 'worktree-global-config-'));
      directories.push(global);
      const config = join(global, 'gitconfig');
      run(global, [
        'config',
        '--file',
        config,
        'core.autocrlf',
        setting === 'autocrlf' ? 'true' : 'false',
      ]);
      if (setting === 'attributes') {
        const attributes = join(global, 'attributes');
        await writeFile(attributes, '* text eol=lf ident\n');
        run(global, ['config', '--file', config, 'core.attributesFile', attributes]);
      }
      const configuredGit: typeof git = (args, options) =>
        git(args, {
          ...options,
          env: { GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1', ...options?.env },
        });
      const native = await configuredGit(
        [
          'diff',
          '--no-ext-diff',
          '--no-textconv',
          '--no-color',
          '--no-renames',
          '--unified=10',
          '--inter-hunk-context=0',
          '--src-prefix=a/',
          '--dst-prefix=b/',
          baseRef,
          '--',
          'deleted.txt',
        ],
        { cwd: directory, timeoutMs: 5_000 }
      );
      expect(native.exitCode).toBe(0);
      expect(native.stdout).toContain('-$Id: preserved value $\r\n-original line\r\n');
      const result = await collectWorktreeSnapshot(directory, { revision: 1 }, configuredGit);
      expect(snapshotFile(result, 'deleted.txt').content).toEqual({
        status: 'available',
        source: 'deleted-original',
        text,
      });
      expect(snapshotPatch(result, 'deleted.txt')).toBe(native.stdout);
    }
  );
});

describe('parseWorktreeDiff', () => {
  it('joins numstat to exact paths rather than output order', () => {
    const first = ' first\t"\\\n漢 ';
    const second = 'second';
    const output = `${raw(first)}${raw(second, 'A')}2\t0\t${second}\0` + `1\t3\t${first}\0`;
    expect(parseWorktreeDiff(output)).toEqual([
      {
        path: first,
        status: 'modified',
        additions: 1,
        deletions: 3,
        tracked: true,
        binary: false,
        countsComplete: true,
      },
      {
        path: second,
        status: 'added',
        additions: 2,
        deletions: 0,
        tracked: true,
        binary: false,
        countsComplete: true,
      },
    ]);
  });

  it.each([
    'unterminated',
    '\0',
    raw('missing-counts', 'A'),
    raw('missing-type-counts', 'T'),
    '1\t0\tmissing-raw\0',
    `${raw('one')}1\t0\tother\0`,
    `${raw('one')}1\t0\tone\0` + '1\t0\tone\0',
    `${raw('one')}${raw('one')}1\t0\tone\0`,
    `${raw('one', 'U')}1\t0\tone\0`,
    `${raw('one', 'R')}1\t0\tone\0`,
    `${raw('one')}-\t0\tone\0`,
    `${raw('one')}-1\t0\tone\0`,
    `${raw('one')}9007199254740992\t0\tone\0`,
    `${raw('one')}1x\t0\tone\0`,
    `${raw('../outside')}1\t0\t../outside\0`,
    `${raw('one')}1\t0\t\0`,
  ])('fails on malformed or unsupported raw/numstat data %j', output => {
    expect(() => parseWorktreeDiff(output)).toThrow('Worktree capture failed');
  });
});
