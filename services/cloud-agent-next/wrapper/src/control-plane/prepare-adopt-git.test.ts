import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
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
import { directoryHome } from './workspace-home.js';
import { profileConfigPath } from './runtime-profile.js';
import { gitCredentialRecordPath } from '../control/git-credentials.js';

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

function manager(allocationId: string, overrides: Partial<PrepareDeps> = {}) {
  const frames: ControlPlaneWrapperFrame[] = [];
  const gitCalls: string[][] = [];
  const runtimeEnvs: Record<string, string>[] = [];
  const restore = mock<NonNullable<PrepareDeps['restore']>>(async () => ({
    ok: true,
    downloaded: true,
    imported: true,
    diffs: { applied: 0, skipped: 0, total: 0 },
  }));
  const runSetup = mock(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
  const recoverWorktree = mock(async () => ({
    applied: 0,
    skipped: 0,
    total: 0,
    skippedDiffs: [],
  }));
  const prepared = createPreparationManager({
    timers: CONTROL_PLANE_TIMERS,
    allocationId,
    emit: frame => frames.push(frame),
    runtimes: {
      ensure: async input => {
        runtimeEnvs.push(input.env);
        return { serverUrl: 'http://127.0.0.1:1' } as unknown as WrapperKiloClient;
      },
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
    restore,
    runSetup,
    recoverWorktree,
    sleep: async () => undefined,
    ...overrides,
  });
  return { prepared, frames, gitCalls, restore, runtimeEnvs, runSetup, recoverWorktree };
}

function ready(frames: ControlPlaneWrapperFrame[]) {
  return frames.findLast(frame => frame.type === 'session.ready');
}

// The first manager stands in for the environment builder: another allocation
// prepared the workspace, so the second classifies it as a snapshot to adopt.
describe('adopting an environment snapshot against a real repository', () => {
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
    expect(await readWorkspaceStamp(directory)).toEqual({
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

    commitFile('README', 'two', 'second');
    git(author, 'push', '-q', 'origin', 'main');

    const restored = manager('alloc-restored');
    await restored.prepared.prepare(spec({ sessionId: 'ses_b' }));

    expect(ready(restored.frames)).toMatchObject({ workspace: 'cloned' });
    expect(restored.gitCalls.filter(args => args[0] === 'clone')).toHaveLength(1);
    expect(await fs.readFile(localEdit, 'utf8')).toBe('two');
    expect(await readWorkspaceStamp(directory)).toMatchObject({
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

  it('retains local workspace state', async () => {
    const first = manager('alloc-image');
    await first.prepared.prepare(spec());
    await fs.writeFile(path.join(directory, 'local.txt'), 'local changes');
    const commit = git(directory, 'rev-parse', 'HEAD');
    const second = manager('alloc-image');
    await second.prepared.prepare(spec({ sessionId: 'ses_b' }));

    expect(ready(second.frames)).toMatchObject({ workspace: 'same' });
    expect(git(directory, 'rev-parse', 'HEAD')).toBe(commit);
    expect(await fs.readFile(path.join(directory, 'local.txt'), 'utf8')).toBe('local changes');
  });
});

describe('restoring a private session disk snapshot', () => {
  const provenance = { sourceAllocationId: 'alloc-source' };

  it('preserves local git, files, home and history while refreshing credentials and config', async () => {
    await manager('alloc-source').prepared.prepare(spec());
    git(directory, 'checkout', '-q', '-b', 'local-work');
    await fs.writeFile(path.join(directory, '.gitignore'), 'node_modules/\n');
    await fs.writeFile(path.join(directory, 'local-commit.txt'), 'unpushed commit\n');
    git(directory, 'add', '.gitignore', 'local-commit.txt');
    git(directory, 'commit', '-q', '-m', 'local only');
    git(directory, 'branch', 'another-local-branch');
    await fs.writeFile(path.join(directory, 'README'), 'staged\n');
    git(directory, 'add', 'README');
    await fs.writeFile(path.join(directory, 'README'), 'unstaged\n');
    await fs.writeFile(path.join(directory, 'untracked.txt'), 'untracked\n');
    await fs.mkdir(path.join(directory, 'node_modules'));
    await fs.writeFile(path.join(directory, 'node_modules', 'cached'), 'ignored dependency\n');
    const home = directoryHome(directory, path.join(root, 'homes'));
    await fs.writeFile(path.join(home, 'user-state'), 'home state\n');
    await fs.mkdir(path.dirname(profileConfigPath(home)), { recursive: true });
    await fs.writeFile(profileConfigPath(home), '{"agent":{"stale":{}}}');
    git(directory, 'remote', 'set-url', 'origin', 'https://old:secret@github.com/acme/repo.git');
    const status = git(directory, 'status', '--porcelain=v1', '--untracked-files=all');
    const refs = git(directory, 'show-ref', '--heads');
    const head = git(directory, 'rev-parse', 'HEAD');
    const restored = manager('alloc-restored');
    const restoredSpec = spec({
      branch: 'main',
      sessionSnapshot: provenance,
      setupCommands: ['must not replay'],
      worktreeRecovery: { files: [{ path: 'README', status: 'modified', patch: 'older patch' }] },
      git: { url: 'https://github.com/acme/repo.git', token: 'current-git-token' },
      env: { CURRENT_CONFIG: 'refreshed' },
    });

    await restored.prepared.prepare(restoredSpec);

    expect(ready(restored.frames)).toMatchObject({ workspace: 'adopted' });
    expect(git(directory, 'status', '--porcelain=v1', '--untracked-files=all')).toBe(status);
    expect(git(directory, 'show-ref', '--heads')).toBe(refs);
    expect(git(directory, 'branch', '--show-current')).toBe('local-work');
    expect(git(directory, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(directory, 'show', ':README')).toBe('staged');
    expect(await fs.readFile(path.join(directory, 'README'), 'utf8')).toBe('unstaged\n');
    expect(await fs.readFile(path.join(directory, 'untracked.txt'), 'utf8')).toBe('untracked\n');
    expect(await fs.readFile(path.join(directory, 'node_modules', 'cached'), 'utf8')).toBe(
      'ignored dependency\n'
    );
    expect(await fs.readFile(path.join(home, 'user-state'), 'utf8')).toBe('home state\n');
    expect(await fs.stat(profileConfigPath(home)).catch(() => null)).toBeNull();
    expect(git(directory, 'remote', 'get-url', 'origin')).toBe('https://github.com/acme/repo.git');
    expect(restored.runtimeEnvs[0]?.CURRENT_CONFIG).toBe('refreshed');
    expect(await fs.readFile(gitCredentialRecordPath(home), 'utf8')).toContain(
      'password=current-git-token\n'
    );
    expect(restored.restore).not.toHaveBeenCalled();
    expect(restored.runSetup).not.toHaveBeenCalled();
    expect(restored.recoverWorktree).not.toHaveBeenCalled();
    expect(
      restored.gitCalls.some(args => ['clone', 'fetch', 'checkout', 'branch'].includes(args[0]!))
    ).toBe(false);
  });

  it('fails a source allocation mismatch without touching recovered files or starting Kilo', async () => {
    await manager('alloc-source').prepared.prepare(spec());
    await fs.writeFile(path.join(directory, 'recovered.txt'), 'keep me');
    const restored = manager('alloc-restored');
    await restored.prepared.prepare(spec({ sessionSnapshot: { sourceAllocationId: 'other' } }));
    expect(restored.frames.at(-1)).toMatchObject({
      type: 'session.failed',
      reason: 'workspace_setup_failed',
      step: 'restore',
    });
    expect(restored.gitCalls).toEqual([]);
    expect(restored.runtimeEnvs).toEqual([]);
    expect(restored.runSetup).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(directory, 'recovered.txt'), 'utf8')).toBe('keep me');
  });

  it('defers stamping until session resolution succeeds and falls back to history-only ingest', async () => {
    await manager('alloc-source').prepared.prepare(spec());
    const failed = manager('alloc-restored', {
      sessionExists: async () => false,
      restore: async () => ({ ok: false, error: 'unavailable', code: 503, step: 'download' }),
    });
    await failed.prepared.prepare(spec({ sessionSnapshot: provenance }));
    expect(failed.frames.at(-1)).toMatchObject({ type: 'session.failed', step: 'kilo_session' });
    expect(await readWorkspaceStamp(directory)).toMatchObject({
      allocationId: 'alloc-source',
    });
    const restarted = manager('alloc-restored', { sessionExists: async () => false });
    await restarted.prepared.prepare(spec({ sessionSnapshot: provenance }));
    expect(ready(restarted.frames)).toBeDefined();
    expect(restarted.restore.mock.calls[0]?.[3]?.restoreFiles).toBe(false);
  });

  it.each([false, true])('restores a bare session with git init=%s', async initializeGit => {
    const bareSpec = spec({ git: undefined });
    await manager('alloc-source').prepared.prepare(bareSpec);
    if (initializeGit) git(directory, 'init', '-q', '-b', 'local-work');
    await fs.writeFile(path.join(directory, 'local.txt'), 'local commit\n');
    if (initializeGit) {
      git(directory, 'add', 'local.txt');
      git(directory, 'commit', '-q', '-m', 'local only');
    }
    const head = initializeGit ? git(directory, 'rev-parse', 'HEAD') : '';
    const restored = manager('alloc-restored');

    await restored.prepared.prepare({ ...bareSpec, sessionSnapshot: provenance });

    expect(ready(restored.frames)).toMatchObject({ workspace: 'adopted' });
    expect(await fs.readFile(path.join(directory, 'local.txt'), 'utf8')).toBe('local commit\n');
    expect(await readWorkspaceStamp(directory)).toMatchObject({
      allocationId: 'alloc-restored',
      commit: head,
      workspacePrepared: false,
    });
    const restarted = manager('alloc-restored');
    await restarted.prepared.prepare({ ...bareSpec, sessionSnapshot: provenance });
    expect(ready(restarted.frames)).toMatchObject({ workspace: 'same' });
    if (initializeGit) expect(git(directory, 'rev-parse', 'HEAD')).toBe(head);
    const normal = manager('alloc-restored');
    await normal.prepared.prepare({ ...bareSpec, setupCommands: ['normal setup'] });
    expect(normal.runSetup).toHaveBeenCalledTimes(1);
  });
});
