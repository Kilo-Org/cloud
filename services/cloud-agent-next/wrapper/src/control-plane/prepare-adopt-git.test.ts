import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CONTROL_PLANE_TIMERS } from '../../../src/shared/control-plane-timers.js';
import type {
  ControlPlaneRouteSpec,
  ControlPlaneWrapperFrame,
} from '../../../src/shared/control-plane-protocol.js';
import type { WrapperKiloClient } from '../kilo-api.js';
import { createPreparationManager, type PrepareDeps } from './prepare.js';
import {
  readWorkspaceStamp,
  SNAPSHOT_MAX_GENERATION,
  SNAPSHOT_REFRESH_AFTER_MS,
} from './workspace-stamp.js';

const T0 = 1_800_000_000_000;

// These tests run real git against a local origin. A mocked git proves the command
// sequence; only a real repository proves an adopted snapshot ends on the same
// commits and branches a fresh clone would.

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();
}

let root: string;
let origin: string;
let author: string;
let directory: string;

function commitFile(name: string, content: string, message: string): string {
  execFileSync('sh', ['-c', `printf '%s' "$1" > "$2"`, 'sh', content, path.join(author, name)]);
  git(author, 'add', name);
  git(author, 'commit', '-q', '-m', message);
  return git(author, 'rev-parse', 'HEAD');
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'adopt-git-'));
  origin = path.join(root, 'origin.git');
  author = path.join(root, 'author');
  directory = path.join(root, 'workspace', 'app');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { env: GIT_ENV });
  execFileSync('git', ['clone', '-q', origin, author], { env: GIT_ENV });
  git(author, 'checkout', '-q', '-b', 'main');
  commitFile('README', 'one', 'first');
  commitFile('.gitignore', 'node_modules/\n.env.local\n', 'setup artifacts');
  git(author, 'push', '-q', 'origin', 'main');
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function spec(overrides: Partial<ControlPlaneRouteSpec> = {}): ControlPlaneRouteSpec {
  return {
    sessionId: 'ses_a',
    kiloSessionId: 'kilo_a',
    attemptId: 'attempt-1',
    directory,
    env: {},
    git: { url: pathToFileURL(origin).toString() },
    kilo: {
      scopeId: 'scope-1',
      token: 'kilo-token',
      targets: {
        backendBaseUrl: 'https://backend.test',
        providerBaseUrl: 'https://provider.test',
        sessionIngestBaseUrl: 'https://ingest.test',
      },
    },
    ...overrides,
  };
}

type GitState = { origin: string; fetchHead: boolean; reflog: string };

/** What `.git` holds at the moment the Sandbox DO would snapshot the container. */
async function gitStateAtCapture(): Promise<GitState> {
  return {
    origin: git(directory, 'remote', 'get-url', 'origin'),
    fetchHead: await fs
      .access(path.join(directory, '.git', 'FETCH_HEAD'))
      .then(() => true)
      .catch(() => false),
    reflog: git(directory, 'reflog', '--all'),
  };
}

function manager(
  allocationId: string,
  now = T0,
  options: Pick<PrepareDeps, 'recoverWorktree'> & { onCapture?: () => Promise<void> } = {}
) {
  const frames: ControlPlaneWrapperFrame[] = [];
  const gitCalls: string[][] = [];
  const captures: GitState[] = [];
  const prepared = createPreparationManager({
    timers: CONTROL_PLANE_TIMERS,
    allocationId,
    now: () => now,
    capture: {
      request: async () => {
        captures.push(await gitStateAtCapture());
        await options.onCapture?.();
        return true;
      },
    },
    emit: frame => frames.push(frame),
    runtimes: {
      ensure: async () => ({ serverUrl: 'http://127.0.0.1:1' }) as unknown as WrapperKiloClient,
      installCredentials: async () => undefined,
      isUnavailable: () => false,
      remove: () => undefined,
      release: () => undefined,
    },
    inheritedEnv: { PATH: process.env.PATH ?? '', ...GIT_ENV } as NodeJS.ProcessEnv,
    homeRoot: path.join(root, 'homes'),
    runGit: async (args, options) => {
      gitCalls.push(args);
      const { git: run } = await import('../utils.js');
      return run(args, options);
    },
    seedRegistration: async () => undefined,
    sessionExists: async () => true,
    sleep: async () => undefined,
    recoverWorktree: options.recoverWorktree,
  });
  return { prepared, frames, gitCalls, captures };
}

function ready(frames: ControlPlaneWrapperFrame[]) {
  return frames.findLast(frame => frame.type === 'session.ready');
}

describe('adopting a repository snapshot against a real repository', () => {
  it('captures reusable state before restoring workspace A edits, then adopts it for workspace B', async () => {
    commitFile('staged.txt', 'base\n', 'staged file');
    git(author, 'push', '-q', 'origin', 'main');
    git(author, 'checkout', '-q', '-b', 'feature');
    git(author, 'push', '-q', 'origin', 'feature');
    const snapshot = path.join(root, 'snapshot');
    let capturedStatus: string | undefined;
    const first = manager('alloc-image', T0, {
      onCapture: async () => {
        capturedStatus = git(directory, 'status', '--porcelain');
        await fs.cp(directory, snapshot, { recursive: true });
      },
      recoverWorktree: async () => {
        await fs.writeFile(path.join(directory, 'README'), 'workspace A edit');
        await fs.writeFile(path.join(directory, 'staged.txt'), 'workspace A staged edit');
        git(directory, 'add', 'staged.txt');
        await fs.writeFile(path.join(directory, 'new.txt'), 'workspace A untracked file');
        return { applied: 3, skipped: 0, total: 3, skippedDiffs: [] };
      },
    });
    await first.prepared.prepare(spec({ capture: true, worktreeRecovery: { files: [] } }));

    expect(ready(first.frames)).toMatchObject({ workspace: 'cloned' });
    expect(capturedStatus).toBe('');
    expect(git(directory, 'diff', '--name-only')).toBe('README');
    expect(git(directory, 'diff', '--cached', '--name-only')).toBe('staged.txt');
    expect(await fs.readFile(path.join(directory, 'new.txt'), 'utf8')).toBe(
      'workspace A untracked file'
    );

    const workspaceB = path.join(root, 'workspace-b');
    await fs.cp(snapshot, workspaceB, { recursive: true });
    const restored = manager('alloc-restored');
    await restored.prepared.prepare(
      spec({ directory: workspaceB, sessionId: 'ses_b', branch: 'feature', branchMode: 'working' })
    );

    expect(ready(restored.frames)).toMatchObject({ workspace: 'adopted' });
    expect(git(workspaceB, 'status', '--porcelain')).toBe('');
    expect(git(workspaceB, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feature');
    expect(git(workspaceB, 'rev-parse', '--abbrev-ref', '@{upstream}')).toBe('origin/feature');
    expect(await fs.readFile(path.join(workspaceB, 'README'), 'utf8')).toBe('one');
    expect(await fs.readdir(workspaceB)).not.toContain('new.txt');
    expect(git(directory, 'status', '--porcelain')).toContain('?? new.txt');
  });

  it('starts a new session branch from the current origin tip, not the snapshot commit', async () => {
    const first = manager('alloc-image');
    await first.prepared.prepare(spec({ capture: true }));
    expect(ready(first.frames)).toMatchObject({ workspace: 'cloned' });
    expect(first.captures).toHaveLength(1);
    const snapshotCommit = git(directory, 'rev-parse', 'HEAD');

    const tip = commitFile('README', 'two', 'second');
    git(author, 'push', '-q', 'origin', 'main');
    expect(tip).not.toBe(snapshotCommit);

    const restored = manager('alloc-restored');
    await restored.prepared.prepare(
      spec({ sessionId: 'ses_b', kilo: { ...spec().kilo!, scopeId: 'scope-2' } })
    );

    expect(ready(restored.frames)).toMatchObject({ workspace: 'adopted' });
    expect(restored.gitCalls.some(args => args[0] === 'clone')).toBe(false);
    expect(git(directory, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('session/scope-2');
    expect(git(directory, 'rev-parse', 'HEAD')).toBe(tip);
    expect(git(directory, 'branch', '--format=%(refname:short)')).toBe('session/scope-2');
    expect(await readWorkspaceStamp(directory, true)).toEqual({
      allocationId: 'alloc-restored',
      commit: tip,
      capturedAt: T0,
      generation: 0,
    });
    expect(restored.captures).toEqual([]);
  });

  it("gives an existing session the branch it pushed, not the snapshot's stale one", async () => {
    const first = manager('alloc-image');
    await first.prepared.prepare(spec());
    expect(git(directory, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('session/scope-1');

    git(author, 'checkout', '-q', '-b', 'session/scope-1');
    const pushed = commitFile('work.txt', 'agent work', 'agent commit');
    git(author, 'push', '-q', 'origin', 'session/scope-1');

    const restored = manager('alloc-restored');
    await restored.prepared.prepare(spec({ branch: 'session/scope-1', branchMode: 'working' }));

    expect(ready(restored.frames)).toMatchObject({ workspace: 'adopted' });
    expect(git(directory, 'rev-parse', 'HEAD')).toBe(pushed);
    expect(git(directory, 'rev-parse', '--abbrev-ref', '@{upstream}')).toBe(
      'origin/session/scope-1'
    );
  });

  it('checks out an explicit branch at its current origin commit', async () => {
    const first = manager('alloc-image');
    await first.prepared.prepare(spec());

    git(author, 'checkout', '-q', '-b', 'feature');
    const featureTip = commitFile('feature.txt', 'feature', 'feature commit');
    git(author, 'push', '-q', 'origin', 'feature');

    const restored = manager('alloc-restored');
    await restored.prepared.prepare(spec({ branch: 'feature' }));

    expect(ready(restored.frames)).toMatchObject({ workspace: 'adopted' });
    expect(git(directory, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feature');
    expect(git(directory, 'rev-parse', 'HEAD')).toBe(featureTip);
  });

  it('removes inherited tracked, staged and untracked edits before adopting another branch', async () => {
    commitFile('staged.txt', 'base\n', 'staged file');
    git(author, 'push', '-q', 'origin', 'main');
    const first = manager('alloc-image');
    await first.prepared.prepare(spec({ capture: true }));
    await fs.writeFile(path.join(directory, 'README'), 'workspace A edit');
    await fs.writeFile(path.join(directory, 'staged.txt'), 'workspace A staged edit');
    git(directory, 'add', 'staged.txt');
    await fs.writeFile(path.join(directory, 'new.txt'), 'workspace A untracked file');
    git(directory, 'init', '-q', 'nested-repo');
    await fs.mkdir(path.join(directory, 'node_modules'), { recursive: true });
    await fs.writeFile(path.join(directory, 'node_modules', 'dep.js'), 'dependency');
    await fs.writeFile(path.join(directory, '.env.local'), 'setup artifact');
    git(author, 'checkout', '-q', '-b', 'feature');
    const tip = commitFile('feature.txt', 'workspace B branch', 'feature');
    git(author, 'push', '-q', 'origin', 'feature');

    const restored = manager('alloc-restored');
    await restored.prepared.prepare(
      spec({ sessionId: 'ses_b', branch: 'feature', branchMode: 'working' })
    );

    expect(ready(restored.frames)).toMatchObject({ workspace: 'adopted' });
    expect(restored.gitCalls.some(args => args[0] === 'clone')).toBe(false);
    expect(git(directory, 'status', '--porcelain')).toBe('');
    expect(await fs.readFile(path.join(directory, 'README'), 'utf8')).toBe('one');
    expect(await fs.readFile(path.join(directory, 'staged.txt'), 'utf8')).toBe('base\n');
    expect(await fs.readdir(directory)).not.toContain('new.txt');
    expect(await fs.readdir(directory)).not.toContain('nested-repo');
    expect(await fs.readFile(path.join(directory, 'node_modules', 'dep.js'), 'utf8')).toBe(
      'dependency'
    );
    expect(await fs.readFile(path.join(directory, '.env.local'), 'utf8')).toBe('setup artifact');
    expect(git(directory, 'rev-parse', 'HEAD')).toBe(tip);
    expect(git(directory, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feature');
    expect(git(directory, 'rev-parse', '--abbrev-ref', '@{upstream}')).toBe('origin/feature');
  });

  it('keeps installed dependencies, which is what makes the setup incremental', async () => {
    const first = manager('alloc-image');
    await first.prepared.prepare(spec());
    await fs.mkdir(path.join(directory, 'node_modules'), { recursive: true });
    await fs.writeFile(path.join(directory, 'node_modules', 'dep.js'), 'module.exports = 1');

    const restored = manager('alloc-restored');
    await restored.prepared.prepare(spec({ sessionId: 'ses_b' }));

    expect(ready(restored.frames)).toMatchObject({ workspace: 'adopted' });
    expect(await fs.readFile(path.join(directory, 'node_modules', 'dep.js'), 'utf8')).toBe(
      'module.exports = 1'
    );
  });

  it('falls back to a fresh clone when the snapshot cannot be reconciled', async () => {
    const first = manager('alloc-image');
    await first.prepared.prepare(spec());
    const localEdit = path.join(directory, 'README');
    await fs.writeFile(localEdit, 'edited by setup');
    git(directory, 'remote', 'remove', 'origin');

    commitFile('README', 'two', 'second');
    git(author, 'push', '-q', 'origin', 'main');

    const restored = manager('alloc-restored');
    await restored.prepared.prepare(spec({ sessionId: 'ses_b' }));

    expect(ready(restored.frames)).toMatchObject({ workspace: 'cloned' });
    expect(restored.gitCalls.filter(args => args[0] === 'clone')).toHaveLength(1);
    expect(await fs.readFile(localEdit, 'utf8')).toBe('two');
    expect(await readWorkspaceStamp(directory, true)).toMatchObject({
      allocationId: 'alloc-restored',
    });
  });

  it('preserves tracked, staged and untracked edits for a second route on the same allocation', async () => {
    const first = manager('alloc-image');
    await first.prepared.prepare(spec());
    await fs.writeFile(path.join(directory, 'README'), 'live edit');
    await fs.writeFile(path.join(directory, 'staged.txt'), 'live staged file');
    git(directory, 'add', 'staged.txt');
    await fs.writeFile(path.join(directory, 'new.txt'), 'live untracked file');
    const status = git(directory, 'status', '--porcelain');
    const second = manager('alloc-image');
    await second.prepared.prepare(spec({ sessionId: 'ses_b' }));

    expect(ready(second.frames)).toMatchObject({ workspace: 'same' });
    expect(second.gitCalls).toEqual([]);
    expect(git(directory, 'status', '--porcelain')).toBe(status);
    expect(await fs.readFile(path.join(directory, 'README'), 'utf8')).toBe('live edit');
    expect(await fs.readFile(path.join(directory, 'staged.txt'), 'utf8')).toBe('live staged file');
    expect(await fs.readFile(path.join(directory, 'new.txt'), 'utf8')).toBe('live untracked file');
  });
});

describe('refreshing an adopted snapshot against a real repository', () => {
  it('captures an old snapshot from the adopted workspace, with no credential left in .git', async () => {
    const first = manager('alloc-image', T0);
    await first.prepared.prepare(spec({ capture: true }));
    await fs.mkdir(path.join(directory, 'node_modules'), { recursive: true });
    await fs.writeFile(path.join(directory, 'node_modules', 'dep.js'), 'module.exports = 1');
    const tip = commitFile('README', 'two', 'second');
    git(author, 'push', '-q', 'origin', 'main');

    const refreshed = manager('alloc-refresh', T0 + SNAPSHOT_REFRESH_AFTER_MS);
    await refreshed.prepared.prepare(spec({ sessionId: 'ses_b', capture: true }));

    expect(ready(refreshed.frames)).toMatchObject({ workspace: 'adopted' });
    expect(refreshed.gitCalls.some(args => args[0] === 'clone')).toBe(false);
    expect(refreshed.captures).toHaveLength(1);
    const [atCapture] = refreshed.captures;
    expect(atCapture).toEqual({
      origin: pathToFileURL(origin).toString(),
      fetchHead: false,
      reflog: '',
    });
    expect(await readWorkspaceStamp(directory, true)).toEqual({
      allocationId: 'alloc-refresh',
      commit: tip,
      capturedAt: T0 + SNAPSHOT_REFRESH_AFTER_MS,
      generation: 1,
    });
    expect(await fs.readFile(path.join(directory, 'node_modules', 'dep.js'), 'utf8')).toBe(
      'module.exports = 1'
    );
  });

  it('does not capture before the snapshot is due, and rebuilds from a clone at the generation cap', async () => {
    await manager('alloc-image', T0).prepared.prepare(spec({ capture: true }));

    const early = manager('alloc-early', T0 + SNAPSHOT_REFRESH_AFTER_MS - 1);
    await early.prepared.prepare(spec({ sessionId: 'ses_b', capture: true }));
    expect(ready(early.frames)).toMatchObject({ workspace: 'adopted' });
    expect(early.captures).toEqual([]);

    let at = T0;
    for (let generation = 1; generation <= SNAPSHOT_MAX_GENERATION; generation += 1) {
      at += SNAPSHOT_REFRESH_AFTER_MS;
      const next = manager(`alloc-refresh-${generation}`, at);
      await next.prepared.prepare(spec({ sessionId: `ses_${generation}`, capture: true }));
      expect(next.captures).toHaveLength(1);
      expect(await readWorkspaceStamp(directory, true)).toMatchObject({ generation });
    }

    const rebuilt = manager('alloc-rebuilt', at + SNAPSHOT_REFRESH_AFTER_MS);
    await rebuilt.prepared.prepare(spec({ sessionId: 'ses_rebuilt', capture: true }));
    expect(ready(rebuilt.frames)).toMatchObject({ workspace: 'cloned' });
    expect(rebuilt.gitCalls.filter(args => args[0] === 'clone')).toHaveLength(1);
    expect(rebuilt.captures).toHaveLength(1);
    expect(await readWorkspaceStamp(directory, true)).toMatchObject({
      capturedAt: at + SNAPSHOT_REFRESH_AFTER_MS,
      generation: 0,
    });
  });
});
