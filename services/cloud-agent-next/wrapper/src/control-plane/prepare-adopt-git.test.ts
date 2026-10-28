import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
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
import { readWorkspaceStamp, writeWorkspaceStamp } from './workspace-stamp.js';
import { directoryHome } from './workspace-home.js';
import { profileConfigPath } from './runtime-profile.js';
import { gitCredentialRecordPath } from '../control/git-credentials.js';
import { restoreSession } from '../restore-session.js';

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
  const restores: Array<{ restoreFiles?: boolean }> = [];
  const runtimeEnvs: Record<string, string>[] = [];
  let setupCalls = 0;
  let recoveryCalls = 0;
  let sessionQueries = 0;
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
    sessionExists: async () => {
      sessionQueries++;
      return true;
    },
    restore: async (_id, _directory, _file, options) => {
      restores.push({ restoreFiles: options?.restoreFiles });
      return {
        ok: true,
        downloaded: true,
        imported: true,
        diffs: { applied: 0, skipped: 0, total: 0 },
      };
    },
    runSetup: async () => {
      setupCalls++;
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    recoverWorktree: async () => {
      recoveryCalls++;
      return { applied: 0, skipped: 0, total: 0, skippedDiffs: [] };
    },
    sleep: async () => undefined,
    ...overrides,
  });
  return {
    prepared,
    frames,
    gitCalls,
    restores,
    runtimeEnvs,
    setupCalls: () => setupCalls,
    recoveryCalls: () => recoveryCalls,
    sessionQueries: () => sessionQueries,
  };
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
      session: { sessionId: 'ses_b', kiloSessionId: 'kilo_a' },
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

  it('preserves local branches, commits, index, dirty, untracked, ignored and home files while refreshing config and history', async () => {
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
    expect(
      await fs.access(profileConfigPath(home)).then(
        () => true,
        () => false
      )
    ).toBe(false);
    expect(git(directory, 'remote', 'get-url', 'origin')).toBe('https://github.com/acme/repo.git');
    expect(restored.runtimeEnvs[0]?.CURRENT_CONFIG).toBe('refreshed');
    expect(await fs.readFile(gitCredentialRecordPath(home), 'utf8')).toContain(
      'password=current-git-token\n'
    );
    expect(restored.restores).toEqual([{ restoreFiles: false }]);
    expect(restored.sessionQueries()).toBe(0);
    expect(restored.setupCalls()).toBe(0);
    expect(restored.recoveryCalls()).toBe(0);
    expect(
      restored.gitCalls.some(args => ['clone', 'fetch', 'checkout', 'branch'].includes(args[0]!))
    ).toBe(false);
    expect(await readWorkspaceStamp(directory)).toEqual({
      allocationId: 'alloc-restored',
      commit: head,
      session: {
        sessionId: restoredSpec.sessionId,
        kiloSessionId: restoredSpec.kiloSessionId,
        snapshotSourceAllocationId: 'alloc-source',
      },
    });

    const restarted = manager('alloc-restored');
    await restarted.prepared.prepare(restoredSpec);
    expect(ready(restarted.frames)).toMatchObject({ workspace: 'same' });
    expect(restarted.restores).toEqual([]);
    expect(git(directory, 'show-ref', '--heads')).toBe(refs);
  });

  it.each(['missing', 'corrupt', 'allocation', 'session', 'kilo', 'legacy', 'repository'])(
    'fails closed for %s provenance without clone, setup, runtime or deleting recovered files',
    async mismatch => {
      await manager('alloc-source').prepared.prepare(spec());
      const stamp = await readWorkspaceStamp(directory);
      expect(stamp).not.toBeNull();
      if (!stamp?.session) throw new Error('Missing source stamp');
      await fs.writeFile(path.join(directory, 'recovered.txt'), 'keep me');
      if (mismatch === 'missing') await fs.rm(path.join(directory, '.git', 'kilo-workspace.json'));
      else if (mismatch === 'corrupt')
        await fs.writeFile(path.join(directory, '.git', 'kilo-workspace.json'), 'invalid');
      else if (mismatch === 'repository') await fs.rm(path.join(directory, '.git', 'HEAD'));
      else
        await writeWorkspaceStamp(directory, true, {
          ...stamp,
          allocationId: mismatch === 'allocation' ? 'other-allocation' : stamp.allocationId,
          session:
            mismatch === 'legacy'
              ? undefined
              : {
                  sessionId: mismatch === 'session' ? 'other-session' : stamp.session.sessionId,
                  kiloSessionId: mismatch === 'kilo' ? 'other-kilo' : stamp.session.kiloSessionId,
                },
        });
      const restored = manager('alloc-restored');

      await restored.prepared.prepare(spec({ sessionSnapshot: provenance }));

      expect(restored.frames.at(-1)).toMatchObject({
        type: 'session.failed',
        reason: 'workspace_setup_failed',
        step: 'restore',
      });
      expect(restored.gitCalls).toEqual([]);
      expect(restored.runtimeEnvs).toEqual([]);
      expect(restored.setupCalls()).toBe(0);
      expect(await fs.readFile(path.join(directory, 'recovered.txt'), 'utf8')).toBe('keep me');
    }
  );

  it('does not stamp a failed history import as current and retries authoritative import after restart', async () => {
    await manager('alloc-source').prepared.prepare(spec());
    const failed = manager('alloc-restored', {
      restore: async () => ({ ok: false, error: 'unavailable', code: 503, step: 'download' }),
    });
    await failed.prepared.prepare(spec({ sessionSnapshot: provenance }));
    expect(failed.frames.at(-1)).toMatchObject({ type: 'session.failed', step: 'kilo_session' });
    expect(await readWorkspaceStamp(directory)).toMatchObject({
      allocationId: 'alloc-source',
    });
    const restarted = manager('alloc-restored');
    await restarted.prepared.prepare(spec({ sessionSnapshot: provenance }));
    expect(ready(restarted.frames)).toBeDefined();
    expect(restarted.restores).toEqual([{ restoreFiles: false }]);
  });

  it('imports newer ingest history over a stale local session without applying older ingest file diffs', async () => {
    await manager('alloc-source').prepared.prepare(spec());
    const home = directoryHome(directory, path.join(root, 'homes'));
    const historyFile = path.join(home, 'history.json');
    await fs.writeFile(historyFile, JSON.stringify({ messages: ['stale local history'] }));
    await fs.writeFile(path.join(directory, 'README'), 'current disk bytes');
    const bin = path.join(root, 'bin');
    await fs.mkdir(bin);
    await fs.writeFile(path.join(bin, 'kilo'), '#!/bin/sh\ncp "$2" "$HOME/history.json"\n', {
      mode: 0o755,
    });
    const history = {
      info: { id: spec().kiloSessionId },
      messages: [{ info: { id: 'new-message' }, parts: [{ text: 'newer ingest history' }] }],
      sessionDiff: [{ file: 'README', status: 'modified', after: 'older ingest bytes' }],
    };
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(history), { status: 200 })
    );
    try {
      const restored = manager('alloc-restored', {
        restore: (id, cwd, file, options) =>
          restoreSession(id, cwd, file, {
            ...options,
            env: { ...options?.env, PATH: `${bin}:${process.env.PATH}` },
          }),
      });
      await restored.prepared.prepare(spec({ sessionSnapshot: provenance }));
      expect(ready(restored.frames)).toBeDefined();
      expect(restored.sessionQueries()).toBe(0);
      expect(JSON.parse(await fs.readFile(historyFile, 'utf8'))).toEqual(history);
      expect(await fs.readFile(path.join(directory, 'README'), 'utf8')).toBe('current disk bytes');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('stamps and preserves a session with no repository or setup commands', async () => {
    const bareSpec = spec({ git: undefined });
    await manager('alloc-source').prepared.prepare(bareSpec);
    await fs.writeFile(path.join(directory, 'disk-state'), 'preserved');
    const restored = manager('alloc-restored');
    await restored.prepared.prepare({ ...bareSpec, sessionSnapshot: provenance });
    expect(ready(restored.frames)).toMatchObject({ workspace: 'adopted' });
    expect(await fs.readFile(path.join(directory, 'disk-state'), 'utf8')).toBe('preserved');
    expect(restored.restores).toEqual([{ restoreFiles: false }]);
    expect(restored.gitCalls).toEqual([['rev-parse', 'HEAD']]);
    const restoredStamp = {
      allocationId: 'alloc-restored',
      commit: '',
      workspacePrepared: false as const,
      session: {
        sessionId: bareSpec.sessionId,
        kiloSessionId: bareSpec.kiloSessionId,
        snapshotSourceAllocationId: 'alloc-source',
      },
    };
    expect(await readWorkspaceStamp(directory)).toEqual(restoredStamp);
    const restarted = manager('alloc-restored');
    await restarted.prepared.prepare({ ...bareSpec, sessionSnapshot: provenance });
    expect(ready(restarted.frames)).toMatchObject({ workspace: 'same' });
    expect(restarted.restores).toEqual([]);
    expect(await readWorkspaceStamp(directory)).toEqual(restoredStamp);
    expect(await fs.readFile(path.join(directory, 'disk-state'), 'utf8')).toBe('preserved');
    await manager('alloc-restored').prepared.prepare(bareSpec);
    expect(await readWorkspaceStamp(directory)).toEqual(restoredStamp);
    const nextRestart = manager('alloc-restored');
    await nextRestart.prepared.prepare({ ...bareSpec, sessionSnapshot: provenance });
    expect(ready(nextRestart.frames)).toMatchObject({ workspace: 'same' });
    const nextRestore = manager('alloc-next');
    await nextRestore.prepared.prepare({
      ...bareSpec,
      sessionSnapshot: { sourceAllocationId: 'alloc-restored' },
    });
    expect(ready(nextRestore.frames)).toMatchObject({ workspace: 'adopted' });
    expect(nextRestore.restores).toEqual([{ restoreFiles: false }]);
    expect(await fs.readFile(path.join(directory, 'disk-state'), 'utf8')).toBe('preserved');
    const normalSetup = manager('alloc-next');
    await normalSetup.prepared.prepare({ ...bareSpec, setupCommands: ['normal setup'] });
    expect(ready(normalSetup.frames)).toBeDefined();
    expect(normalSetup.setupCalls()).toBe(1);
    expect((await readWorkspaceStamp(directory))?.workspacePrepared).toBeUndefined();
  });

  it('restores a bare session after git init without losing local commits, untracked or home files', async () => {
    const bareSpec = spec({ git: undefined });
    await manager('alloc-source').prepared.prepare(bareSpec);
    git(directory, 'init', '-q', '-b', 'local-work');
    await fs.writeFile(path.join(directory, 'local.txt'), 'local commit\n');
    git(directory, 'add', 'local.txt');
    git(directory, 'commit', '-q', '-m', 'local only');
    await fs.writeFile(path.join(directory, 'untracked.txt'), 'untracked\n');
    const home = directoryHome(directory, path.join(root, 'homes'));
    await fs.writeFile(path.join(home, 'user-state'), 'home state\n');
    const head = git(directory, 'rev-parse', 'HEAD');
    const status = git(directory, 'status', '--porcelain=v1', '--untracked-files=all');
    const restored = manager('alloc-restored');

    await restored.prepared.prepare({ ...bareSpec, sessionSnapshot: provenance });

    expect(ready(restored.frames)).toMatchObject({ workspace: 'adopted' });
    expect(git(directory, 'branch', '--show-current')).toBe('local-work');
    expect(git(directory, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(directory, 'status', '--porcelain=v1', '--untracked-files=all')).toBe(status);
    expect(await fs.readFile(path.join(directory, 'untracked.txt'), 'utf8')).toBe('untracked\n');
    expect(await fs.readFile(path.join(home, 'user-state'), 'utf8')).toBe('home state\n');
    expect(restored.restores).toEqual([{ restoreFiles: false }]);
    expect(restored.setupCalls()).toBe(0);
    expect(await readWorkspaceStamp(directory)).toMatchObject({
      allocationId: 'alloc-restored',
      commit: head,
      session: {
        sessionId: bareSpec.sessionId,
        kiloSessionId: bareSpec.kiloSessionId,
        snapshotSourceAllocationId: 'alloc-source',
      },
    });
    const restarted = manager('alloc-restored');
    await restarted.prepared.prepare({ ...bareSpec, sessionSnapshot: provenance });
    expect(ready(restarted.frames)).toMatchObject({ workspace: 'same' });
    expect(restarted.restores).toEqual([]);
    expect(git(directory, 'rev-parse', 'HEAD')).toBe(head);
  });

  it.each(['corrupt', 'allocation', 'session', 'kilo'])(
    'rejects a %s repository stamp instead of trusting a valid bare-session sidecar',
    async mismatch => {
      const bareSpec = spec({ git: undefined });
      await manager('alloc-source').prepared.prepare(bareSpec);
      const stamp = await readWorkspaceStamp(directory);
      if (!stamp?.session) throw new Error('Missing bare source stamp');
      git(directory, 'init', '-q', '-b', 'local-work');
      await fs.writeFile(path.join(directory, 'untracked.txt'), 'preserve me');
      if (mismatch === 'corrupt')
        await fs.writeFile(path.join(directory, '.git', 'kilo-workspace.json'), 'invalid');
      else
        await writeWorkspaceStamp(directory, true, {
          ...stamp,
          allocationId: mismatch === 'allocation' ? 'other-allocation' : stamp.allocationId,
          session: {
            sessionId: mismatch === 'session' ? 'other-session' : stamp.session.sessionId,
            kiloSessionId: mismatch === 'kilo' ? 'other-kilo' : stamp.session.kiloSessionId,
          },
        });
      const restored = manager('alloc-restored');

      await restored.prepared.prepare({ ...bareSpec, sessionSnapshot: provenance });

      expect(restored.frames.at(-1)).toMatchObject({
        type: 'session.failed',
        reason: 'workspace_setup_failed',
        step: 'restore',
      });
      expect(restored.gitCalls).toEqual([]);
      expect(restored.runtimeEnvs).toEqual([]);
      expect(await fs.readFile(path.join(directory, 'untracked.txt'), 'utf8')).toBe('preserve me');
    }
  );

  it('keeps environment adoption and setup replay when provenance is unset', async () => {
    await manager('alloc-source').prepared.prepare(spec());
    git(directory, 'branch', 'local-only');
    const restored = manager('alloc-restored');
    await restored.prepared.prepare(spec({ setupCommands: ['normal setup'] }));
    expect(ready(restored.frames)).toMatchObject({ workspace: 'adopted' });
    expect(git(directory, 'branch', '--format=%(refname:short)')).not.toContain('local-only');
    expect(restored.setupCalls()).toBe(1);
    expect(restored.restores).toEqual([]);
    expect(restored.gitCalls.some(args => args[0] === 'fetch')).toBe(true);
  });
});
