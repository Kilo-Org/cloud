import { rejects } from 'assert/strict';
import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { chmod, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import {
  MAX_WORKTREE_CHANGES_BYTES,
  MAX_WORKTREE_CHANGES_FILES,
  sessionGitSummaryResultSchema,
} from '../../../src/shared/sandbox-control-protocol.js';
import { git, runProcess, type ExecResult } from '../utils.js';
import { collectWorktreeChanges, parseWorktreeDiff } from './worktree-changes';

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
  files: Record<string, string | Buffer> = { 'seed.txt': 'seed\n' }
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'worktree-changes-'));
  directories.push(directory);
  run(directory, ['init', '-b', 'main']);
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
