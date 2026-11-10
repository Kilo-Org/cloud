import { afterEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createWorktreeGitExecutor,
  lastKnownRemoteRef,
  refreshChangesRemotes,
  runWorktreeRestack,
  runWorktreeSync,
  WorktreeGitError,
} from './worktree-git-operations.js';
import { git } from '../utils.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

type Fixture = {
  root: string;
  remote: string;
  seed: string;
  work: string;
  env: NodeJS.ProcessEnv;
};

function run(cwd: string, args: string[], env: NodeJS.ProcessEnv): string {
  return execFileSync('git', args, {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function tryRun(cwd: string, args: string[], env: NodeJS.ProcessEnv): string | null {
  try {
    return run(cwd, args, env);
  } catch {
    return null;
  }
}

async function makeFixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), 'kilo-worktree-git-'));
  roots.push(root);
  const home = path.join(root, 'home');
  await mkdir(home, { recursive: true });
  await writeFile(
    path.join(home, '.gitconfig'),
    [
      '[user]',
      '  name = Kilo Test',
      '  email = kilo-test@example.com',
      '[init]',
      '  defaultBranch = main',
      '[protocol]',
      '  file = always',
    ].join('\n')
  );
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'),
    GIT_AUTHOR_NAME: 'Kilo Test',
    GIT_AUTHOR_EMAIL: 'kilo-test@example.com',
    GIT_COMMITTER_NAME: 'Kilo Test',
    GIT_COMMITTER_EMAIL: 'kilo-test@example.com',
  };

  const remote = path.join(root, 'remote.git');
  run(root, ['init', '--bare', '-b', 'main', remote], env);
  const seed = path.join(root, 'seed');
  run(root, ['clone', remote, seed], env);
  await writeFile(path.join(seed, 'README.md'), 'base\n');
  run(seed, ['add', '.'], env);
  run(seed, ['commit', '-m', 'base'], env);
  run(seed, ['push', '-u', 'origin', 'main'], env);

  const work = path.join(root, 'work');
  run(root, ['clone', remote, work], env);
  return { root, remote, seed, work, env };
}

function clone(fixture: Fixture, name: string): string {
  const directory = path.join(fixture.root, name);
  run(fixture.root, ['clone', fixture.remote, directory], fixture.env);
  return directory;
}

async function commitFile(
  directory: string,
  name: string,
  content: string,
  message: string,
  env: NodeJS.ProcessEnv
): Promise<string> {
  await writeFile(path.join(directory, name), content);
  run(directory, ['add', name], env);
  run(directory, ['commit', '-m', message], env);
  return run(directory, ['rev-parse', 'HEAD'], env);
}

function durable(directory: string, branch: string, env: NodeJS.ProcessEnv): string | null {
  return tryRun(directory, ['rev-parse', '--verify', lastKnownRemoteRef(branch)], env);
}

function head(directory: string, env: NodeJS.ProcessEnv): string {
  return run(directory, ['rev-parse', 'HEAD'], env);
}

function porcelain(directory: string, env: NodeJS.ProcessEnv): string {
  return run(directory, ['status', '--porcelain'], env);
}

function pushFeature(fixture: Fixture): { branch: string; first: string } {
  const branch = 'feature';
  run(fixture.work, ['checkout', '-b', branch], fixture.env);
  const first = run(fixture.work, ['rev-parse', 'HEAD'], fixture.env);
  run(fixture.work, ['push', '-u', 'origin', branch], fixture.env);
  return { branch, first };
}

function remoteTip(fixture: Fixture, branch: string): string {
  return run(fixture.work, ['ls-remote', 'origin', `refs/heads/${branch}`], fixture.env).split(
    /\s+/
  )[0];
}

describe('worktree Sync', () => {
  it('rebases unpushed local commits onto a newly fetched teammate commit using the durable ref', async () => {
    const fixture = await makeFixture();
    const { branch, first } = pushFeature(fixture);
    const local = await commitFile(fixture.work, 'local.txt', 'local\n', 'local work', fixture.env);
    run(fixture.work, ['update-ref', lastKnownRemoteRef(branch), first], fixture.env);

    const teammate = clone(fixture, 'teammate');
    run(teammate, ['checkout', branch], fixture.env);
    const remote = await commitFile(teammate, 'teammate.txt', 'remote\n', 'teammate', fixture.env);
    run(teammate, ['push', 'origin', branch], fixture.env);

    // A prior Changes refresh fetch must not change the durable baseline.
    run(fixture.work, ['fetch', 'origin', branch], fixture.env);
    expect(durable(fixture.work, branch, fixture.env)).toBe(first);

    const executor = createWorktreeGitExecutor({
      directory: fixture.work,
      env: fixture.env,
    });
    const result = await runWorktreeSync(executor, { baseBranch: 'main' });

    expect(result.status).toBe('changed');
    expect(result.operation).toBe('sync');
    expect(result.previousRemoteSha).toBe(first);
    expect(result.remoteSha).toBe(remote);
    if (result.status !== 'changed') throw new Error('expected changed');
    expect(result.headSha).not.toBe(local);
    expect(run(fixture.work, ['merge-base', '--is-ancestor', remote, 'HEAD'], fixture.env)).toBe(
      ''
    );
    expect(run(fixture.work, ['log', '-1', '--format=%s'], fixture.env)).toBe('local work');
    expect(durable(fixture.work, branch, fixture.env)).toBe(remote);
  });

  it('resets to the remote when there are no unpushed commits', async () => {
    const fixture = await makeFixture();
    const { branch, first } = pushFeature(fixture);
    run(fixture.work, ['update-ref', lastKnownRemoteRef(branch), first], fixture.env);

    const teammate = clone(fixture, 'teammate-reset');
    run(teammate, ['checkout', branch], fixture.env);
    const remote = await commitFile(
      teammate,
      'remote.txt',
      'remote\n',
      'remote advance',
      fixture.env
    );
    run(teammate, ['push', 'origin', branch], fixture.env);

    const executor = createWorktreeGitExecutor({ directory: fixture.work, env: fixture.env });
    const result = await runWorktreeSync(executor, {});

    expect(result.status).toBe('changed');
    expect(result.operation).toBe('sync');
    expect(result.headSha).toBe(remote);
    expect(head(fixture.work, fixture.env)).toBe(remote);
    expect(durable(fixture.work, branch, fixture.env)).toBe(remote);
  });

  it('fast-forwards a rewound HEAD even when the durable ref matches the remote', async () => {
    const fixture = await makeFixture();
    const { branch } = pushFeature(fixture);
    const pushed = await commitFile(fixture.work, 'pushed.txt', 'pushed\n', 'pushed', fixture.env);
    run(fixture.work, ['push', 'origin', branch], fixture.env);
    run(fixture.work, ['update-ref', lastKnownRemoteRef(branch), pushed], fixture.env);
    run(fixture.work, ['reset', '--hard', 'HEAD~1'], fixture.env);

    const executor = createWorktreeGitExecutor({ directory: fixture.work, env: fixture.env });
    const result = await runWorktreeSync(executor, {});

    expect(result.status).toBe('changed');
    expect(head(fixture.work, fixture.env)).toBe(pushed);
  });

  it('does not record the remote as synced when the fast-forward reset fails', async () => {
    const fixture = await makeFixture();
    const { branch, first } = pushFeature(fixture);
    run(fixture.work, ['update-ref', lastKnownRemoteRef(branch), first], fixture.env);
    const teammate = clone(fixture, 'teammate-locked');
    run(teammate, ['checkout', branch], fixture.env);
    await commitFile(teammate, 'remote.txt', 'remote\n', 'remote advance', fixture.env);
    run(teammate, ['push', 'origin', branch], fixture.env);
    await writeFile(path.join(fixture.work, '.git', 'index.lock'), '');

    const executor = createWorktreeGitExecutor({ directory: fixture.work, env: fixture.env });
    const error = await runWorktreeSync(executor, {}).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(WorktreeGitError);

    expect(head(fixture.work, fixture.env)).toBe(first);
    expect(durable(fixture.work, branch, fixture.env)).toBe(first);
  });

  it('seeds a missing durable ref only from an origin that is an ancestor of HEAD', async () => {
    const fixture = await makeFixture();
    const { branch, first } = pushFeature(fixture);
    await commitFile(fixture.work, 'local.txt', 'local\n', 'unpushed', fixture.env);

    const executor = createWorktreeGitExecutor({ directory: fixture.work, env: fixture.env });
    const result = await runWorktreeSync(executor, {});

    expect(result.status).toBe('unchanged');
    expect(result.previousRemoteSha).toBe(first);
    expect(result.remoteSha).toBe(first);
    expect(durable(fixture.work, branch, fixture.env)).toBe(first);
  });

  it('records the remote tip when a durable ref is absent and the remote advanced', async () => {
    const fixture = await makeFixture();
    const { branch } = pushFeature(fixture);
    const teammate = clone(fixture, 'teammate-no-ref');
    run(teammate, ['checkout', branch], fixture.env);
    const remote = await commitFile(
      teammate,
      'remote.txt',
      'remote\n',
      'remote advance',
      fixture.env
    );
    run(teammate, ['push', 'origin', branch], fixture.env);

    const executor = createWorktreeGitExecutor({ directory: fixture.work, env: fixture.env });
    const result = await runWorktreeSync(executor, {});

    expect(result.status).toBe('changed');
    expect(result.headSha).toBe(remote);
    expect(durable(fixture.work, branch, fixture.env)).toBe(remote);
  });
});

describe('worktree Restack', () => {
  it('replays only the child commit onto a squash-merged parent', async () => {
    const fixture = await makeFixture();
    run(fixture.work, ['checkout', '-b', 'parent'], fixture.env);
    const parent = await commitFile(fixture.work, 'parent.txt', 'parent\n', 'parent', fixture.env);
    run(fixture.work, ['push', '-u', 'origin', 'parent'], fixture.env);

    const child = clone(fixture, 'child');
    run(child, ['checkout', '-b', 'child', 'origin/parent'], fixture.env);
    await commitFile(child, 'child.txt', 'child\n', 'child', fixture.env);
    run(child, ['push', '-u', 'origin', 'child'], fixture.env);

    run(fixture.seed, ['fetch', 'origin'], fixture.env);
    run(fixture.seed, ['checkout', 'main'], fixture.env);
    run(fixture.seed, ['merge', '--squash', 'origin/parent'], fixture.env);
    run(fixture.seed, ['commit', '-m', 'squash parent'], fixture.env);
    run(fixture.seed, ['push', 'origin', 'main'], fixture.env);
    const squash = head(fixture.seed, fixture.env);

    const executor = createWorktreeGitExecutor({ directory: child, env: fixture.env });
    const result = await runWorktreeRestack(executor, {
      baseBranch: 'main',
      upstreamSha: parent,
    });

    expect(result.status).toBe('changed');
    expect(result.operation).toBe('restack');
    expect(result.baseSha).toBe(squash);
    if (result.status !== 'changed') throw new Error('expected changed');
    expect(run(child, ['rev-parse', 'HEAD^'], fixture.env)).toBe(squash);
    expect(run(child, ['show', '--format=%s', '--no-patch', 'HEAD'], fixture.env)).toBe('child');
    expect(run(child, ['show', 'HEAD:child.txt'], fixture.env)).toBe('child');
    expect(tryRun(child, ['merge-base', '--is-ancestor', parent, 'HEAD'], fixture.env)).toBeNull();
    expect(remoteTip(fixture, 'child')).toBe(result.headSha);
  });

  it('reports conflict, aborts, retains HEAD, and repeats safely', async () => {
    const fixture = await makeFixture();
    run(fixture.work, ['checkout', '-b', 'parent'], fixture.env);
    const parent = await commitFile(
      fixture.work,
      'conflict.txt',
      'parent\n',
      'parent',
      fixture.env
    );
    run(fixture.work, ['push', '-u', 'origin', 'parent'], fixture.env);

    // A collaborator can choose a valid ref name that is shell syntax.
    const childBranch = 'child-$(id)';
    const child = clone(fixture, 'conflict-child');
    run(child, ['checkout', '-b', childBranch, 'origin/parent'], fixture.env);
    await commitFile(child, 'conflict.txt', 'child\n', 'child', fixture.env);
    run(child, ['push', '-u', 'origin', childBranch], fixture.env);
    const original = head(child, fixture.env);

    run(fixture.seed, ['fetch', 'origin'], fixture.env);
    run(fixture.seed, ['checkout', 'main'], fixture.env);
    run(fixture.seed, ['merge', '--squash', 'origin/parent'], fixture.env);
    run(fixture.seed, ['commit', '-m', 'squash parent'], fixture.env);
    await commitFile(fixture.seed, 'conflict.txt', 'main\n', 'main edit', fixture.env);
    run(fixture.seed, ['push', 'origin', 'main'], fixture.env);

    const executor = createWorktreeGitExecutor({ directory: child, env: fixture.env });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await runWorktreeRestack(executor, {
        baseBranch: 'main',
        upstreamSha: parent,
      });
      expect(result.status).toBe('conflict');
      expect(result.operation).toBe('restack');
      if (result.status !== 'conflict') throw new Error('expected conflict');
      expect(result.files).toContain('conflict.txt');
      expect(result.command).toContain('git rebase --onto');
      expect(result.instruction).toContain('force-push with the lease');
      expect(result.instruction).toContain(`'HEAD:refs/heads/${childBranch}'`);
      expect(result.instruction).not.toMatch(/[^']HEAD:refs\/heads\/child-\$\(id\)/);
      expect(result.headSha).toBe(original);
      expect(head(child, fixture.env)).toBe(original);
      expect(porcelain(child, fixture.env)).toBe('');
      expect(await executor.rebaseInProgress()).toBe(false);
    }
  });

  it('returns unchanged for a same-parent restack with no own commits', async () => {
    const fixture = await makeFixture();
    run(fixture.work, ['checkout', '-b', 'parent'], fixture.env);
    const parent = await commitFile(fixture.work, 'parent.txt', 'parent\n', 'parent', fixture.env);
    run(fixture.work, ['push', '-u', 'origin', 'parent'], fixture.env);

    const child = clone(fixture, 'same-parent-child');
    run(child, ['checkout', '-b', 'child', 'origin/parent'], fixture.env);
    run(child, ['push', '-u', 'origin', 'child'], fixture.env);

    const executor = createWorktreeGitExecutor({ directory: child, env: fixture.env });
    const result = await runWorktreeRestack(executor, {
      baseBranch: 'parent',
      upstreamSha: parent,
    });

    expect(result.status).toBe('unchanged');
    expect(result.operation).toBe('restack');
    expect(result.headSha).toBe(parent);
    expect(head(child, fixture.env)).toBe(parent);
  });

  it('rolls back the local rewrite when the push is rejected', async () => {
    const fixture = await makeFixture();
    run(fixture.work, ['checkout', '-b', 'parent'], fixture.env);
    const parent = await commitFile(fixture.work, 'parent.txt', 'parent\n', 'parent', fixture.env);
    run(fixture.work, ['push', '-u', 'origin', 'parent'], fixture.env);

    const child = clone(fixture, 'rejected-child');
    run(child, ['checkout', '-b', 'child', 'origin/parent'], fixture.env);
    await commitFile(child, 'child.txt', 'child\n', 'child', fixture.env);
    run(child, ['push', '-u', 'origin', 'child'], fixture.env);
    const original = head(child, fixture.env);

    run(fixture.seed, ['checkout', 'main'], fixture.env);
    await commitFile(fixture.seed, 'main.txt', 'main\n', 'main advance', fixture.env);
    run(fixture.seed, ['push', 'origin', 'main'], fixture.env);

    const hook = path.join(fixture.remote, 'hooks', 'pre-receive');
    await writeFile(hook, '#!/bin/sh\nexit 1\n');
    await chmod(hook, 0o755);

    const executor = createWorktreeGitExecutor({ directory: child, env: fixture.env });
    let failure: unknown;
    try {
      await runWorktreeRestack(executor, { baseBranch: 'main', upstreamSha: parent });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(WorktreeGitError);
    expect(head(child, fixture.env)).toBe(original);
    expect(porcelain(child, fixture.env)).toBe('');
    expect(durable(child, 'child', fixture.env)).toBe(original);
  });

  it('rejects a stale lease after a concurrent remote push and rolls the rewrite back', async () => {
    const fixture = await makeFixture();
    run(fixture.work, ['checkout', '-b', 'parent'], fixture.env);
    const parent = await commitFile(fixture.work, 'parent.txt', 'parent\n', 'parent', fixture.env);
    run(fixture.work, ['push', '-u', 'origin', 'parent'], fixture.env);

    const child = clone(fixture, 'lease-child');
    run(child, ['checkout', '-b', 'child', 'origin/parent'], fixture.env);
    await commitFile(child, 'child.txt', 'child\n', 'child', fixture.env);
    run(child, ['push', '-u', 'origin', 'child'], fixture.env);
    const original = head(child, fixture.env);
    run(child, ['update-ref', lastKnownRemoteRef('child'), original], fixture.env);

    run(fixture.seed, ['checkout', 'main'], fixture.env);
    await commitFile(fixture.seed, 'main.txt', 'main\n', 'main advance', fixture.env);
    run(fixture.seed, ['push', 'origin', 'main'], fixture.env);

    const rival = clone(fixture, 'rival-child');
    run(rival, ['checkout', 'child'], fixture.env);

    let raced = false;
    const executor = createWorktreeGitExecutor({
      directory: child,
      env: fixture.env,
      runGit: async (args, options) => {
        if (!raced && args.includes('push')) {
          raced = true;
          const rivalCommit = await commitFile(
            rival,
            'rival.txt',
            'rival\n',
            'rival push',
            fixture.env
          );
          run(rival, ['push', 'origin', 'child'], fixture.env);
          expect(rivalCommit).toBe(remoteTip(fixture, 'child'));
        }
        return git(args, options);
      },
    });

    const result = await runWorktreeRestack(executor, {
      baseBranch: 'main',
      upstreamSha: parent,
    });

    expect(result.status).toBe('refused');
    expect(result.operation).toBe('restack');
    if (result.status !== 'refused') throw new Error('expected refused');
    expect(result.reason).toBe('lease_rejected');
    expect(result.headSha).toBe(original);
    expect(head(child, fixture.env)).toBe(original);
    expect(porcelain(child, fixture.env)).toBe('');
    expect(durable(child, 'child', fixture.env)).toBe(original);
    expect(remoteTip(fixture, 'child')).not.toBe(original);
  });
});

describe('Changes refresh remotes', () => {
  it('refreshes only the base and leaves the own remote ref unchanged', async () => {
    const fixture = await makeFixture();
    const { branch } = pushFeature(fixture);
    const previousRemote = run(fixture.work, ['rev-parse', `origin/${branch}`], fixture.env);
    const teammate = clone(fixture, 'refresh-teammate');
    run(teammate, ['checkout', branch], fixture.env);
    await commitFile(teammate, 'remote.txt', 'remote\n', 'remote', fixture.env);
    run(teammate, ['push', 'origin', branch], fixture.env);

    const executor = createWorktreeGitExecutor({ directory: fixture.work, env: fixture.env });
    const refreshed = await refreshChangesRemotes(executor, {
      baseRef: 'refs/remotes/origin/main',
    });

    expect(run(fixture.work, ['rev-parse', `origin/${branch}`], fixture.env)).toBe(previousRemote);
    expect(refreshed).not.toHaveProperty('remoteDivergence');
    expect(refreshed.baseRefFallback).toBeUndefined();
  });

  it('does not contact the remote when no base comparison is requested', async () => {
    const fixture = await makeFixture();
    const missingRemote = path.join(fixture.root, 'missing.git');
    run(fixture.work, ['remote', 'set-url', 'origin', missingRemote], fixture.env);

    const executor = createWorktreeGitExecutor({ directory: fixture.work, env: fixture.env });
    expect(await refreshChangesRemotes(executor, {})).toEqual({ request: {} });
  });

  it('falls back to the default branch when the requested base is gone', async () => {
    const fixture = await makeFixture();
    pushFeature(fixture);
    run(
      fixture.work,
      ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'],
      fixture.env
    );

    const executor = createWorktreeGitExecutor({ directory: fixture.work, env: fixture.env });
    const refreshed = await refreshChangesRemotes(executor, {
      baseRef: 'refs/remotes/origin/deleted-base',
    });

    expect(refreshed.baseRefFallback).toEqual({
      requested: 'refs/remotes/origin/deleted-base',
      used: 'refs/remotes/origin/main',
    });
    expect(refreshed.request.baseRef).toBe('refs/remotes/origin/main');
  });

  it('reports a retryable error for a network/auth fetch failure', async () => {
    const fixture = await makeFixture();
    pushFeature(fixture);
    const missingRemote = path.join(fixture.root, 'missing.git');
    run(fixture.work, ['remote', 'set-url', 'origin', missingRemote], fixture.env);

    const executor = createWorktreeGitExecutor({ directory: fixture.work, env: fixture.env });
    let failure: unknown;
    try {
      await refreshChangesRemotes(executor, { baseRef: 'refs/remotes/origin/main' });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(WorktreeGitError);
    if (!(failure instanceof WorktreeGitError)) throw new Error('expected WorktreeGitError');
    expect(failure.code).toBe('git_network_failed');
    expect(failure.retryable).toBe(true);
  });
});

describe('prepared credential environment wiring', () => {
  it('passes the prepared env, helper config and managed arguments to every git command', async () => {
    const preparedEnv: NodeJS.ProcessEnv = {
      HOME: '/tmp/kilo-worktree-home',
      PATH: process.env.PATH,
      SYSTEM_GIT_CONFIG_ENV: '1',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: '!kilo-credential-helper',
    };
    const calls: Array<{ args: string[]; options: Parameters<typeof git>[1] }> = [];
    const executor = createWorktreeGitExecutor({
      directory: '/tmp/kilo-worktree',
      env: preparedEnv,
      configArgs: ['-c', 'http.followRedirects=false'],
      runGit: async (args, options) => {
        calls.push({ args, options });
        return {
          exitCode: 0,
          stdout: '',
          stderr: '',
        };
      },
    });

    await executor.currentBranch();
    await executor.exec(['fetch', 'origin', 'feature']);
    await executor.exec(['rebase', '--onto', 'a', 'b']);

    expect(calls.length).toBe(3);
    for (const call of calls) {
      expect(call.options?.inheritEnv).toBe(false);
      expect(call.options?.env).toEqual(preparedEnv);
      expect(call.options?.cwd).toBe('/tmp/kilo-worktree');
      expect(call.options?.env?.GIT_CONFIG_KEY_0).toBe('credential.helper');
      expect(call.args).toContain('http.followRedirects=false');
    }
  });
});

describe('Sync effective base preservation', () => {
  async function stackedFixture(): Promise<{
    fixture: Fixture;
    parentTip: string;
    childTip: string;
    child: string;
  }> {
    const fixture = await makeFixture();
    run(fixture.work, ['checkout', '-b', 'parent'], fixture.env);
    await commitFile(fixture.work, 'shared.txt', 'one\n', 'A1', fixture.env);
    const parentTip = await commitFile(fixture.work, 'shared.txt', 'two\n', 'A2', fixture.env);
    run(fixture.work, ['push', '-u', 'origin', 'parent'], fixture.env);

    const child = clone(fixture, 'child');
    run(child, ['checkout', '-b', 'child', 'origin/parent'], fixture.env);
    const childTip = await commitFile(child, 'child.txt', 'child\n', 'C', fixture.env);
    run(child, ['push', '-u', 'origin', 'child'], fixture.env);
    return { fixture, parentTip, childTip, child };
  }

  it('preserves the recorded parent boundary when a squash-merged parent is deleted, then restacks only the child commit', async () => {
    const { fixture, parentTip, child } = await stackedFixture();
    run(fixture.seed, ['fetch', 'origin'], fixture.env);
    run(fixture.seed, ['checkout', 'main'], fixture.env);
    run(fixture.seed, ['merge', '--squash', 'origin/parent'], fixture.env);
    run(fixture.seed, ['commit', '-m', 'squash parent'], fixture.env);
    run(fixture.seed, ['push', 'origin', 'main'], fixture.env);
    const squash = head(fixture.seed, fixture.env);
    run(fixture.seed, ['push', 'origin', '--delete', 'parent'], fixture.env);

    const executor = createWorktreeGitExecutor({ directory: child, env: fixture.env });
    const synced = await runWorktreeSync(executor, {
      baseBranch: 'main',
      upstreamSha: parentTip,
    });

    expect(synced.status).toBe('unchanged');
    expect(synced.baseBranch).toBeNull();
    expect(synced.baseSha).toBeNull();

    const restacked = await runWorktreeRestack(executor, {
      baseBranch: 'main',
      upstreamSha: parentTip,
    });

    expect(restacked.status).toBe('changed');
    expect(restacked.baseBranch).toBe('main');
    expect(restacked.baseSha).toBe(squash);
    if (restacked.status !== 'changed') throw new Error('expected changed');
    expect(run(child, ['rev-parse', 'HEAD^'], fixture.env)).toBe(squash);
    expect(run(child, ['rev-list', '--count', `${squash}..HEAD`], fixture.env)).toBe('1');
    expect(run(child, ['log', '-1', '--format=%s'], fixture.env)).toBe('C');
    expect(
      tryRun(child, ['merge-base', '--is-ancestor', parentTip, 'HEAD'], fixture.env)
    ).toBeNull();
    expect(remoteTip(fixture, 'child')).toBe(restacked.headSha);
  });

  it('adopts the new base when Sync accepts an own-remote history rewrite', async () => {
    const { fixture, parentTip, childTip, child } = await stackedFixture();
    run(child, ['update-ref', lastKnownRemoteRef('child'), childTip], fixture.env);
    run(fixture.seed, ['checkout', 'main'], fixture.env);
    await commitFile(fixture.seed, 'main.txt', 'main\n', 'M1', fixture.env);
    run(fixture.seed, ['push', 'origin', 'main'], fixture.env);
    const mainTip = head(fixture.seed, fixture.env);

    const rewriter = clone(fixture, 'rewriter');
    run(rewriter, ['fetch', 'origin'], fixture.env);
    run(rewriter, ['checkout', '-B', 'rewrite', 'origin/main'], fixture.env);
    run(rewriter, ['checkout', 'origin/child', '--', 'child.txt'], fixture.env);
    run(rewriter, ['add', 'child.txt'], fixture.env);
    run(rewriter, ['commit', '-m', 'C rewritten'], fixture.env);
    run(rewriter, ['push', '--force', 'origin', 'HEAD:child'], fixture.env);
    const rewrittenTip = head(rewriter, fixture.env);

    const executor = createWorktreeGitExecutor({ directory: child, env: fixture.env });
    const synced = await runWorktreeSync(executor, {
      baseBranch: 'main',
      upstreamSha: parentTip,
    });

    expect(synced.status).toBe('changed');
    expect(synced.headSha).toBe(rewrittenTip);
    expect(synced.baseBranch).toBe('main');
    expect(synced.baseSha).toBe(mainTip);
  });

  it('does not regress the recorded base when a teammate only advanced the own remote', async () => {
    const { fixture, parentTip, childTip, child } = await stackedFixture();
    run(child, ['update-ref', lastKnownRemoteRef('child'), childTip], fixture.env);
    const teammate = clone(fixture, 'teammate-advance');
    run(teammate, ['checkout', 'child'], fixture.env);
    await commitFile(teammate, 'teammate.txt', 'teammate\n', 'T', fixture.env);
    run(teammate, ['push', 'origin', 'child'], fixture.env);
    const advanced = remoteTip(fixture, 'child');

    const executor = createWorktreeGitExecutor({ directory: child, env: fixture.env });
    const synced = await runWorktreeSync(executor, {
      baseBranch: 'main',
      upstreamSha: parentTip,
    });

    expect(synced.status).toBe('changed');
    expect(synced.headSha).toBe(advanced);
    expect(synced.baseBranch).toBeNull();
    expect(synced.baseSha).toBeNull();
  });

  it('advances an ordinary same-base Sync', async () => {
    const { fixture, parentTip, child } = await stackedFixture();
    const executor = createWorktreeGitExecutor({ directory: child, env: fixture.env });
    const synced = await runWorktreeSync(executor, {
      baseBranch: 'parent',
      upstreamSha: parentTip,
    });

    expect(synced.status).toBe('unchanged');
    expect(synced.baseBranch).toBe('parent');
    expect(synced.baseSha).toBe(parentTip);
  });
});
