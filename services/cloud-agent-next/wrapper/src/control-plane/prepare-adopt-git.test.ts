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
import { readWorkspaceStamp } from './workspace-stamp.js';

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

function manager(allocationId: string, options: Pick<PrepareDeps, 'recoverWorktree'> = {}) {
  const frames: ControlPlaneWrapperFrame[] = [];
  const gitCalls: string[][] = [];
  const prepared = createPreparationManager({
    timers: CONTROL_PLANE_TIMERS,
    allocationId,
    emit: frame => frames.push(frame),
    runtimes: {
      ensure: async () => ({ serverUrl: 'http://127.0.0.1:1' }) as unknown as WrapperKiloClient,
      installCredentials: async () => undefined,
      isUnavailable: () => false,
      getLiveClient: () => undefined,
      remove: () => undefined,
      release: () => undefined,
    },
    inheritedEnv: { PATH: process.env.PATH ?? '', ...GIT_ENV } as NodeJS.ProcessEnv,
    homeRoots: { directory: path.join(root, 'homes'), legacy: path.join(root, 'legacy-homes') },
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
  return { prepared, frames, gitCalls };
}

function ready(frames: ControlPlaneWrapperFrame[]) {
  return frames.findLast(frame => frame.type === 'session.ready');
}

// The first manager stands in for the environment builder: another allocation
// prepared the workspace, so the second classifies it as a snapshot to adopt.
describe('adopting an environment snapshot against a real repository', () => {
  it('keeps the environment snapshot reusable while A recovers edits and B adopts another branch', async () => {
    commitFile('staged.txt', 'base\n', 'staged file');
    git(author, 'push', '-q', 'origin', 'main');
    git(author, 'checkout', '-q', '-b', 'feature');
    git(author, 'push', '-q', 'origin', 'feature');
    const snapshot = path.join(root, 'snapshot');
    const builder = manager('alloc-builder');
    await builder.prepared.prepare(spec());
    expect(ready(builder.frames)).toMatchObject({ workspace: 'cloned' });
    expect(git(directory, 'status', '--porcelain')).toBe('');
    await fs.cp(directory, snapshot, { recursive: true });
    const first = manager('alloc-a', {
      recoverWorktree: async () => {
        await fs.writeFile(path.join(directory, 'README'), 'workspace A edit');
        await fs.writeFile(path.join(directory, 'staged.txt'), 'workspace A staged edit');
        git(directory, 'add', 'staged.txt');
        await fs.writeFile(path.join(directory, 'new.txt'), 'workspace A untracked file');
        return { applied: 3, skipped: 0, total: 3, skippedDiffs: [] };
      },
    });
    await first.prepared.prepare(spec({ worktreeRecovery: { files: [] } }));

    expect(ready(first.frames)).toMatchObject({ workspace: 'adopted' });
    expect(first.frames.some(frame => frame.type === 'workspace.capture')).toBe(false);
    expect(git(snapshot, 'status', '--porcelain')).toBe('');
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
    await first.prepared.prepare(spec());
    expect(ready(first.frames)).toMatchObject({ workspace: 'cloned' });
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
    });
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
    await first.prepared.prepare(spec());
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

  it('rewrites a credential-bearing origin to the canonical URL before Kilo starts', async () => {
    await manager('alloc-image').prepared.prepare(spec());
    const credentialed = 'https://x-access-token:stale@github.com/acme/repo.git';
    git(directory, 'remote', 'set-url', 'origin', credentialed);
    await fs.rm(path.join(directory, '.git', 'kilo-workspace.json'));

    const reused = manager('alloc-image');
    await reused.prepared.prepare(spec({ sessionId: 'ses_b' }));

    expect(ready(reused.frames)).toMatchObject({ workspace: 'cloned' });
    // Only the userinfo is dropped: the agent's chosen remote is preserved.
    expect(git(directory, 'remote', 'get-url', 'origin')).toBe('https://github.com/acme/repo.git');
    expect(await fs.readFile(path.join(directory, '.git/config'), 'utf8')).not.toContain(
      'x-access-token'
    );
  });

  it('preserves tracked, staged and untracked edits for a second route on the same allocation', async () => {
    const first = manager('alloc-image');
    await first.prepared.prepare(spec());
    await fs.writeFile(path.join(directory, 'local.txt'), 'local changes');
    const commit = git(directory, 'rev-parse', 'HEAD');
    await fs.writeFile(path.join(directory, 'README'), 'live edit');
    await fs.writeFile(path.join(directory, 'staged.txt'), 'live staged file');
    git(directory, 'add', 'staged.txt');
    await fs.writeFile(path.join(directory, 'new.txt'), 'live untracked file');
    const status = git(directory, 'status', '--porcelain');
    const second = manager('alloc-image');
    await second.prepared.prepare(spec({ sessionId: 'ses_b' }));

    expect(ready(second.frames)).toMatchObject({ workspace: 'same' });
    expect(git(directory, 'rev-parse', 'HEAD')).toBe(commit);
    expect(await fs.readFile(path.join(directory, 'local.txt'), 'utf8')).toBe('local changes');
    expect(
      second.gitCalls.some(args =>
        ['clone', 'fetch', 'checkout', 'reset', 'clean'].includes(args[0] ?? '')
      )
    ).toBe(false);
    expect(git(directory, 'status', '--porcelain')).toBe(status);
    expect(await fs.readFile(path.join(directory, 'README'), 'utf8')).toBe('live edit');
    expect(await fs.readFile(path.join(directory, 'staged.txt'), 'utf8')).toBe('live staged file');
    expect(await fs.readFile(path.join(directory, 'new.txt'), 'utf8')).toBe('live untracked file');
  });
});
