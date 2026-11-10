import { captureRootSnapshots } from './root-changes.js';
import { collectWorktreeSnapshot } from '../control/worktree-changes.js';
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
import type { Harness } from './harness.js';
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

function manager(
  allocationId: string,
  overrides: Partial<PrepareDeps> = {},
  open = mock<Harness['open']>(async () => true)
) {
  const frames: ControlPlaneWrapperFrame[] = [];
  const gitCalls: string[][] = [];
  const runtimeEnvs: Record<string, string>[] = [];
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
        return { open } as unknown as Harness;
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
    runSetup,
    recoverWorktree,
    sleep: async () => undefined,
    ...overrides,
  });
  return { prepared, frames, gitCalls, open, runtimeEnvs, runSetup, recoverWorktree };
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
    expect(
      git(directory, 'for-each-ref', '--format=%(upstream)', 'refs/heads/session/scope-2')
    ).toBe('');
    expect(git(directory, 'rev-parse', 'HEAD')).toBe(tip);
    expect(git(directory, 'branch', '--format=%(refname:short)').split('\n')).toEqual([
      'main',
      'session/scope-1',
      'session/scope-2',
    ]);
    expect(restored.gitCalls.filter(args => args[0] === 'checkout')).toHaveLength(1);
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

  it('checks out the target without first touching a conflicting default branch', async () => {
    await manager('alloc-image').prepared.prepare(spec());
    git(author, 'checkout', '-q', '-b', 'feature');
    const featureTip = commitFile('feature.txt', 'feature', 'feature commit');
    git(author, 'push', '-q', 'origin', 'feature');
    git(author, 'checkout', '-q', 'main');
    commitFile('README', 'new default', 'advance default');
    git(author, 'push', '-q', 'origin', 'main');
    await fs.writeFile(path.join(directory, 'README'), 'edited by setup');
    await fs.mkdir(path.join(directory, 'node_modules'));
    await fs.writeFile(path.join(directory, 'node_modules', 'dep.js'), 'prepared dependency');

    const restored = manager('alloc-restored');
    await restored.prepared.prepare(spec({ branch: 'feature' }));

    expect(ready(restored.frames)).toMatchObject({ workspace: 'adopted' });
    expect(git(directory, 'rev-parse', 'HEAD')).toBe(featureTip);
    expect(await fs.readFile(path.join(directory, 'README'), 'utf8')).toBe('edited by setup');
    expect(await fs.readFile(path.join(directory, 'node_modules', 'dep.js'), 'utf8')).toBe(
      'prepared dependency'
    );
    expect(restored.gitCalls.filter(args => args[0] === 'checkout')).toHaveLength(1);
    expect(restored.gitCalls.some(args => args[0] === 'clone' || args[0] === 'branch')).toBe(false);
    expect(restored.gitCalls.some(args => args[0] === 'remote' && args[1] === 'set-head')).toBe(
      false
    );
  });

  it('creates an unpushed working branch from the current default, not a stale local branch', async () => {
    await manager('alloc-image').prepared.prepare(spec());
    const tip = commitFile('README', 'two', 'advance default');
    git(author, 'push', '-q', 'origin', 'main');

    const restored = manager('alloc-restored');
    await restored.prepared.prepare(spec({ branch: 'session/scope-1', branchMode: 'working' }));

    expect(ready(restored.frames)).toMatchObject({ workspace: 'adopted' });
    expect(git(directory, 'rev-parse', 'HEAD')).toBe(tip);
    expect(git(directory, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('session/scope-1');
    expect(
      git(directory, 'for-each-ref', '--format=%(upstream)', 'refs/heads/session/scope-1')
    ).toBe('');
    expect(restored.gitCalls.some(args => args[0] === 'clone')).toBe(false);
  });

  it('reports a missing requested branch without deleting the snapshot', async () => {
    await manager('alloc-image').prepared.prepare(spec());
    const stamp = await readWorkspaceStamp(directory);

    const restored = manager('alloc-restored');
    await restored.prepared.prepare(spec({ branch: 'missing' }));

    expect(restored.frames.findLast(frame => frame.type === 'session.failed')).toMatchObject({
      step: 'restore',
      subtype: 'git_branch_missing',
    });
    expect(restored.gitCalls.some(args => args[0] === 'clone' || args[0] === 'checkout')).toBe(
      false
    );
    expect(await readWorkspaceStamp(directory)).toEqual(stamp);
    expect(await fs.readFile(path.join(directory, 'README'), 'utf8')).toBe('one');
  });

  it('preserves setup changes and dependencies when checkout conflicts with upstream', async () => {
    const first = manager('alloc-image');
    await first.prepared.prepare(spec());
    const localEdit = path.join(directory, 'README');
    await fs.writeFile(localEdit, 'edited by setup');
    await fs.mkdir(path.join(directory, 'node_modules'));
    const dependency = path.join(directory, 'node_modules', 'dep.js');
    await fs.writeFile(dependency, 'prepared dependency');
    const stamp = await readWorkspaceStamp(directory);

    commitFile('README', 'two', 'second');
    git(author, 'push', '-q', 'origin', 'main');

    const restored = manager('alloc-restored');
    await restored.prepared.prepare(spec({ sessionId: 'ses_b' }));

    expect(restored.frames.findLast(frame => frame.type === 'session.failed')).toMatchObject({
      step: 'checkout',
      subtype: 'git_checkout_conflict',
    });
    expect(restored.gitCalls.some(args => args[0] === 'clone')).toBe(false);
    expect(await fs.readFile(localEdit, 'utf8')).toBe('edited by setup');
    expect(await fs.readFile(dependency, 'utf8')).toBe('prepared dependency');
    expect(await readWorkspaceStamp(directory)).toEqual(stamp);
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

  describe('with start commands', () => {
    const setupRun = (calls: unknown[][]) => calls.map(call => call[0]);

    it('runs only the start commands in a workspace restored from the environment snapshot', async () => {
      await manager('alloc-image').prepared.prepare(spec({ setupCommands: ['older install'] }));
      const restored = manager('alloc-restored');
      await restored.prepared.prepare(
        spec({
          sessionId: 'ses_b',
          setupCommands: ['install'],
          environmentSetupCommandCount: 1,
          startCommands: ['serve'],
        })
      );

      expect(ready(restored.frames)).toMatchObject({ workspace: 'adopted' });
      expect(setupRun(restored.runSetup.mock.calls)).toEqual(['serve']);
      expect(restored.frames).toContainEqual(
        expect.objectContaining({
          type: 'session.progress',
          step: 'setup',
          detail: 'Setup already ran in the environment snapshot',
        })
      );
    });

    it.each([
      { count: 1, setup: ['install', 'inline extra'], expected: ['inline extra', 'serve'] },
      { count: 0, setup: ['inline extra'], expected: ['inline extra', 'serve'] },
      {
        count: undefined,
        setup: ['install', 'inline extra'],
        expected: ['install', 'inline extra', 'serve'],
      },
    ])(
      'preserves session setup when the environment command count is $count',
      async ({ count, setup, expected }) => {
        await manager('alloc-image').prepared.prepare(spec({ setupCommands: ['older install'] }));
        const restored = manager('alloc-restored');
        await restored.prepared.prepare(
          spec({
            sessionId: 'ses_b',
            setupCommands: [...setup],
            environmentSetupCommandCount: count,
            startCommands: ['serve'],
          })
        );

        expect(ready(restored.frames)).toMatchObject({ workspace: 'adopted' });
        expect(setupRun(restored.runSetup.mock.calls)).toEqual([...expected]);
      }
    );

    it('runs start commands after a fresh clone and skips environment build commands', async () => {
      const fresh = manager('alloc-image');
      await fresh.prepared.prepare(
        spec({
          setupCommands: ['install'],
          environmentSetupCommandCount: 1,
          startCommands: ['serve'],
        })
      );

      expect(ready(fresh.frames)).toMatchObject({ workspace: 'cloned' });
      expect(setupRun(fresh.runSetup.mock.calls)).toEqual(['serve']);
    });

    it('runs neither for a workspace this allocation already prepared', async () => {
      await manager('alloc-image').prepared.prepare(spec());
      const sibling = manager('alloc-image');
      await sibling.prepared.prepare(
        spec({ sessionId: 'ses_b', setupCommands: ['install'], startCommands: ['serve'] })
      );

      expect(ready(sibling.frames)).toMatchObject({ workspace: 'same' });
      expect(sibling.runSetup).not.toHaveBeenCalled();
    });
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

describe('restoring a private workspace disk snapshot', () => {
  function workspaceSpec(overrides: Partial<ControlPlaneRouteSpec> = {}): ControlPlaneRouteSpec {
    const base = spec();
    return {
      ...base,
      kilo: { ...base.kilo!, scopeId: 'worktree_00000000-0000-4000-8000-000000000001' },
      ...overrides,
    };
  }
  const provenance = () => ({
    sourceAllocationId: 'alloc-source',
    workspaceId: 'worktree_00000000-0000-4000-8000-000000000001' as const,
    directory,
  });

  it('preserves local git, files, home and history while refreshing credentials and config', async () => {
    await manager('alloc-source').prepared.prepare(
      workspaceSpec({ env: { CAPTURED_CONFIG: 'stale' } })
    );
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
    const restoredSpec = workspaceSpec({
      branch: 'main',
      workspaceSnapshot: provenance(),
      setupCommands: ['must not replay'],
      worktreeRecovery: { files: [{ path: 'README', status: 'modified', patch: 'older patch' }] },
      git: { url: 'https://github.com/acme/repo.git', token: 'current-git-token' },
      env: { CURRENT_CONFIG: 'refreshed' },
    });

    await restored.prepared.prepare(restoredSpec);

    expect(ready(restored.frames)).toMatchObject({ workspace: 'adopted' });
    expect(
      restored.frames.filter(frame => frame.type === 'session.progress' && frame.step === 'restore')
    ).toContainEqual(expect.objectContaining({ detail: 'Using workspace snapshot' }));
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
    expect(restored.runtimeEnvs[0]?.CAPTURED_CONFIG).toBeUndefined();
    expect(await fs.readFile(gitCredentialRecordPath(home), 'utf8')).toContain(
      'password=current-git-token\n'
    );
    expect(restored.open.mock.calls[0]?.[0].restoreFiles).toBe(false);
    expect(restored.runSetup).not.toHaveBeenCalled();
    expect(restored.recoverWorktree).not.toHaveBeenCalled();
    expect(
      restored.gitCalls.some(args => ['clone', 'fetch', 'checkout', 'branch'].includes(args[0]!))
    ).toBe(false);
  });

  it('runs no commands after restoring a workspace snapshot', async () => {
    await manager('alloc-source').prepared.prepare(workspaceSpec());
    const restored = manager('alloc-restored');
    await restored.prepared.prepare(
      workspaceSpec({
        branch: 'main',
        workspaceSnapshot: provenance(),
        setupCommands: ['must not replay'],
        startCommands: ['serve'],
      })
    );

    expect(ready(restored.frames)).toMatchObject({ workspace: 'adopted' });
    expect(restored.runSetup).not.toHaveBeenCalled();
  });

  it('restores every repository of a workspace without replaying checkout or setup', async () => {
    const api = path.join(directory, 'api');
    const web = path.join(directory, 'web');
    const roots = [api, web].map((root, index) => ({
      directory: root,
      repoFullName: index === 0 ? 'acme/api' : 'acme/web',
      git: { url: pathToFileURL(origin).toString(), platform: 'github' as const },
      branch: 'main',
    }));
    const original = workspaceSpec({
      roots,
      setupCommands: ['initial workspace setup'],
    });
    await manager('alloc-source').prepared.prepare(original);
    for (const [index, root] of [api, web].entries()) {
      git(root, 'checkout', '-q', '-b', `local-${index}`);
      await fs.writeFile(path.join(root, 'README'), `staged-${index}`);
      git(root, 'add', 'README');
      await fs.writeFile(path.join(root, 'README'), `dirty-${index}`);
      await fs.writeFile(path.join(root, 'untracked'), `untracked-${index}`);
    }
    const statuses = [api, web].map(root => git(root, 'status', '--porcelain=v1'));
    const registered: ControlPlaneRouteSpec[] = [];
    const restored = manager('alloc-restored', {
      onPreparedRoute: canonical => registered.push(canonical),
    });
    await restored.prepared.prepare({
      ...original,
      sessionId: 'new-multi-chat',
      kiloSessionId: 'new-native',
      workspaceSnapshot: provenance(),
      setupCommands: ['must not replay'],
      env: { CURRENT_CONFIG: 'refreshed' },
    });
    expect(ready(restored.frames)).toMatchObject({ workspace: 'adopted' });
    for (const [index, root] of [api, web].entries()) {
      expect(git(root, 'status', '--porcelain=v1')).toBe(statuses[index]);
      expect(git(root, 'branch', '--show-current')).toBe(`local-${index}`);
      expect(git(root, 'show', ':README')).toBe(`staged-${index}`);
      expect(await fs.readFile(path.join(root, 'README'), 'utf8')).toBe(`dirty-${index}`);
    }
    expect(registered[0]?.roots).toEqual(roots);
    const prepared = restored.prepared.preparedRoute('new-multi-chat');
    if (!prepared) throw new Error('Missing prepared workspace');
    expect(prepared.roots.map(root => root.requestedBranch)).toEqual(['main', 'main']);
    const grouped = await captureRootSnapshots({
      roots: prepared.roots,
      revision: 1,
      capture: collectWorktreeSnapshot,
    });
    expect(grouped.repositories.map(root => root.capture.summary.comparison.baseRef)).toEqual([
      'refs/remotes/origin/main',
      'refs/remotes/origin/main',
    ]);
    expect(restored.runtimeEnvs[0]?.CURRENT_CONFIG).toBe('refreshed');
    expect(restored.runSetup).not.toHaveBeenCalled();
    expect(restored.open.mock.calls[0]?.[0].restoreFiles).toBe(false);
    expect(restored.gitCalls.some(args => ['clone', 'fetch', 'checkout'].includes(args[0]!))).toBe(
      false
    );
    expect(await readWorkspaceStamp(directory)).toMatchObject({
      allocationId: 'alloc-restored',
      workspaceId: provenance().workspaceId,
      directory,
    });
  });

  it('fails a source allocation mismatch without touching recovered files or starting Kilo', async () => {
    await manager('alloc-source').prepared.prepare(workspaceSpec());
    await fs.writeFile(path.join(directory, 'recovered.txt'), 'keep me');
    const restored = manager('alloc-restored');
    await restored.prepared.prepare(
      workspaceSpec({ workspaceSnapshot: { ...provenance(), sourceAllocationId: 'other' } })
    );
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

  it('defers stamping until the harness opens the session and requests history-only restoration', async () => {
    await manager('alloc-source').prepared.prepare(workspaceSpec());
    const failed = manager(
      'alloc-restored',
      {},
      mock<Harness['open']>(async () => {
        throw new Error('history unavailable');
      })
    );
    await failed.prepared.prepare(workspaceSpec({ workspaceSnapshot: provenance() }));
    expect(failed.frames.at(-1)).toMatchObject({ type: 'session.failed', step: 'kilo_session' });
    expect(await readWorkspaceStamp(directory)).toMatchObject({
      allocationId: 'alloc-source',
    });
    const restarted = manager('alloc-restored');
    await restarted.prepared.prepare(workspaceSpec({ workspaceSnapshot: provenance() }));
    expect(ready(restarted.frames)).toBeDefined();
    expect(restarted.open.mock.calls[0]?.[0].restoreFiles).toBe(false);
  });

  it.each([false, true])('restores a bare session with git init=%s', async initializeGit => {
    const bareSpec = workspaceSpec({ git: undefined });
    await manager('alloc-source').prepared.prepare(bareSpec);
    if (initializeGit) git(directory, 'init', '-q', '-b', 'local-work');
    await fs.writeFile(path.join(directory, 'local.txt'), 'local commit\n');
    if (initializeGit) {
      git(directory, 'add', 'local.txt');
      git(directory, 'commit', '-q', '-m', 'local only');
    }
    const head = initializeGit ? git(directory, 'rev-parse', 'HEAD') : '';
    const restored = manager('alloc-restored');

    await restored.prepared.prepare({ ...bareSpec, workspaceSnapshot: provenance() });

    expect(ready(restored.frames)).toMatchObject({ workspace: 'adopted' });
    expect(await fs.readFile(path.join(directory, 'local.txt'), 'utf8')).toBe('local commit\n');
    expect(await readWorkspaceStamp(directory)).toMatchObject({
      allocationId: 'alloc-restored',
      commit: head,
      workspacePrepared: false,
    });
    const restarted = manager('alloc-restored');
    await restarted.prepared.prepare({ ...bareSpec, workspaceSnapshot: provenance() });
    expect(ready(restarted.frames)).toMatchObject({ workspace: 'same' });
    if (initializeGit) expect(git(directory, 'rev-parse', 'HEAD')).toBe(head);
    const normal = manager('alloc-restored');
    await normal.prepared.prepare({ ...bareSpec, setupCommands: ['normal setup'] });
    expect(normal.runSetup).toHaveBeenCalledTimes(1);
  });
});
