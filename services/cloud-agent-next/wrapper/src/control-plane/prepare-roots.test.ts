import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'bun:test';
import {
  CONTROL_PLANE_TIMERS,
  type ControlPlaneTimers,
} from '../../../src/shared/control-plane-timers.js';
import {
  controlPlaneWrapperFrameSchema,
  type ControlPlaneRouteSpec,
  type ControlPlaneWrapperFrame,
} from '../../../src/shared/control-plane-protocol.js';
import type { WrapperKiloClient } from '../kilo-api.js';
import type { ExecResult, ProcessOptions } from '../utils.js';
import { createPreparationManager, type PrepareRuntimePort } from './prepare.js';
import type { WorkspaceStamp } from './workspace-stamp.js';

/**
 * Preparation of a route that has several git roots (plan "Wrapper: one
 * workspace model"): one clone and checkout for each root, one setup at the cwd,
 * one stamp for each root.
 */

type RootRecoveryResult = { applied: number; skipped: number; total: number; skippedDiffs: [] };

const CWD = '/workspace';
const API = '/workspace/api';
const WEB = '/workspace/web';
const API_URL = 'https://github.com/acme/api.git';
const WEB_URL = 'https://github.com/acme/web.git';
const FOREIGN: WorkspaceStamp = { allocationId: 'alloc-builder', commit: 'built' };

function rootSpec(overrides: Partial<ControlPlaneRouteSpec> = {}): ControlPlaneRouteSpec {
  return {
    sessionId: 'ses_00000000000000000000000000',
    kiloSessionId: 'ses_11111111111111111111111111',
    attemptId: 'attempt-1',
    directory: CWD,
    env: {},
    git: { url: API_URL, token: 'alias-github', platform: 'github' },
    branch: 'kilo/generated',
    branchMode: 'working',
    setupCommands: ['npm install'],
    roots: [
      {
        directory: API,
        repoFullName: 'acme/api',
        git: { url: API_URL, platform: 'github' },
        branch: 'kilo/generated',
        branchMode: 'working',
      },
      {
        directory: WEB,
        repoFullName: 'acme/web',
        git: { url: WEB_URL, platform: 'github' },
        branch: 'feature/web',
      },
    ],
    kilo: {
      scopeId: 'scope-1',
      token: 'kilo-token-1',
      targets: {
        backendBaseUrl: 'https://backend.test',
        providerBaseUrl: 'https://provider.test',
        sessionIngestBaseUrl: 'https://ingest.test',
      },
    },
    ...overrides,
  };
}

/** Waits `delayMs`, or until `signal` aborts; no wait when undefined. */
async function delay(delayMs: number | undefined, signal: AbortSignal | undefined): Promise<void> {
  if (delayMs === undefined) return;
  await new Promise<void>(resolve => {
    const timer = setTimeout(resolve, Math.min(delayMs, 5_000));
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

type GitCall = { args: string[]; cwd: string | undefined };

/** A preparation manager over a fake filesystem that keeps one stamp and one repository flag per directory. */
function rootsHarness(
  options: {
    repos?: string[];
    stamps?: Record<string, WorkspaceStamp>;
    failClone?: (url: string) => ExecResult | undefined;
    failAdopt?: (cwd: string | undefined) => boolean;
    failCheckout?: (cwd: string | undefined) => ExecResult | undefined;
    /** Milliseconds a clone of the url takes; `Infinity` hangs until aborted. */
    cloneDelayMs?: (url: string) => number | undefined;
    /** Milliseconds a fetch in the directory takes; `Infinity` hangs until aborted. */
    fetchDelayMs?: (cwd: string | undefined) => number | undefined;
    timers?: ControlPlaneTimers;
    recoverWorktree?: (directory: string, files: string[]) => Promise<RootRecoveryResult>;
  } = {}
) {
  const frames: ControlPlaneWrapperFrame[] = [];
  const logs: string[] = [];
  const gitCalls: GitCall[] = [];
  const setups: Array<{ command: string; directory: string }> = [];
  const emptied: string[] = [];
  const repos = new Set(options.repos ?? []);
  const stamps = new Map(Object.entries(options.stamps ?? {}));
  const restoreOptions_: Array<Record<string, unknown>> = [];
  const runtime: PrepareRuntimePort = {
    ensure: async () =>
      ({ serverUrl: 'http://127.0.0.1:1', ensureSession: async () => undefined }) as never,
    installCredentials: async () => undefined,
    isUnavailable: () => false,
    getLiveClient: () => undefined,
    remove: () => undefined,
    release: () => undefined,
  };
  const manager = createPreparationManager({
    timers: options.timers ?? CONTROL_PLANE_TIMERS,
    emit: frame => frames.push(frame),
    log: message => logs.push(message),
    runtimes: runtime,
    inheritedEnv: {},
    homeRoots: { directory: '/tmp/roots-test/home', legacy: '/tmp/roots-test/legacy' },
    allocationId: 'alloc-current',
    hasGit: async directory => repos.has(directory),
    readStamp: async directory => stamps.get(directory) ?? null,
    writeStamp: async (directory, stamp) => {
      stamps.set(directory, stamp);
    },
    emptyDirectory: async directory => {
      emptied.push(directory);
      repos.delete(directory);
      stamps.delete(directory);
    },
    mkdir: async () => undefined,
    configureGitAuthor: async () => undefined,
    runGit: async (args: string[], gitOptions?: ProcessOptions) => {
      gitCalls.push({ args, cwd: gitOptions?.cwd });
      if (args.includes('clone')) {
        await delay(options.cloneDelayMs?.(args.at(-2) ?? ''), gitOptions?.signal);
        const failure = options.failClone?.(args.at(-2) ?? '');
        if (failure) return failure;
        repos.add(args.at(-1) ?? '');
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'rev-parse') {
        return {
          stdout: `commit-${path.basename(gitOptions?.cwd ?? '')}\n`,
          stderr: '',
          exitCode: 0,
        };
      }
      if (args[0] === 'fetch')
        await delay(options.fetchDelayMs?.(gitOptions?.cwd), gitOptions?.signal);
      if (args[0] === 'fetch' && options.failAdopt?.(gitOptions?.cwd)) {
        return { stdout: '', stderr: 'fatal: repository not found', exitCode: 128 };
      }
      if (args[0] === 'checkout') {
        const failed = options.failCheckout?.(gitOptions?.cwd);
        if (failed) return failed;
      }
      if (args[0] === 'show-ref') return { stdout: '', stderr: '', exitCode: 1 };
      return { stdout: '', stderr: '', exitCode: 0 };
    },
    runSetup: async (command, directory) => {
      setups.push({ command, directory });
      return { stdout: '', stderr: '', exitCode: 0 };
    },
    restore: (async (
      _id: string,
      _directory: string,
      _file: undefined,
      restoreOptions: unknown
    ) => {
      restoreOptions_.push(restoreOptions as Record<string, unknown>);
      return { ok: false, code: 404, error: 'not found', step: 'download' };
    }) as never,
    ...(options.recoverWorktree
      ? {
          recoverWorktree: ((directory: string, recovery: { files: Array<{ path: string }> }) =>
            options.recoverWorktree!(
              directory,
              recovery.files.map(file => file.path)
            )) as never,
        }
      : {}),
    seedRegistration: async () => undefined,
    sessionExists: async () => !options.recoverWorktree,
    sleep: async () => undefined,
  });
  const callsAt = (cwd: string, command: string) =>
    gitCalls.filter(call => call.cwd === cwd && call.args[0] === command);
  const clones = () =>
    gitCalls
      .filter(call => call.args.includes('clone'))
      .map(call => ({ url: call.args.at(-2), directory: call.args.at(-1) }));
  return {
    manager,
    frames,
    logs,
    gitCalls,
    setups,
    emptied,
    repos,
    stamps,
    callsAt,
    clones,
    restoreOptions: restoreOptions_,
  };
}

function failure(frames: ControlPlaneWrapperFrame[]) {
  return frames.find(frame => frame.type === 'session.failed');
}

/** The progress frames of a step, in order, as `[step, detail]`. */
function progressDetails(frames: ControlPlaneWrapperFrame[], step: string) {
  return frames.flatMap(frame =>
    frame.type === 'session.progress' && frame.step === step ? [frame.detail ?? null] : []
  );
}

/** A control alias the wrapper classifies as GitHub-purpose, which a managed clone requires. */
const GITHUB_ALIAS = `kcp1.${Buffer.from('sandbox-1').toString('base64url')}.github.${'a'.repeat(64)}`;
const GITLAB_ALIAS = `kcp1.${Buffer.from('sandbox-1').toString('base64url')}.gitlab.${'b'.repeat(64)}`;
const MANAGED_GITHUB_OPTION = 'http.https://github.com/.proactiveAuth=basic';

describe('preparing a route with several git roots', () => {
  it('clones every root with its own url and branch, sets up once at the cwd, and stamps each root', async () => {
    const harness = rootsHarness();
    const spec = rootSpec();

    await harness.manager.prepare(spec);

    expect(harness.clones()).toEqual([
      { url: API_URL, directory: API },
      { url: WEB_URL, directory: WEB },
    ]);
    // The generated branch is created where the remote has none; a requested one must exist.
    expect(harness.callsAt(API, 'checkout').map(call => call.args)).toContainEqual([
      'checkout',
      '--progress',
      '-b',
      'kilo/generated',
    ]);
    expect(harness.callsAt(WEB, 'checkout').map(call => call.args)).toContainEqual([
      'checkout',
      '--progress',
      '-B',
      'feature/web',
      'origin/feature/web',
    ]);
    expect(harness.setups).toEqual([{ command: 'npm install', directory: CWD }]);
    expect([...harness.stamps]).toEqual([
      [API, { allocationId: 'alloc-current', commit: 'commit-api' }],
      [WEB, { allocationId: 'alloc-current', commit: 'commit-web' }],
    ]);
    expect(harness.stamps.has(CWD)).toBe(false);
    expect(harness.frames.at(-1)).toEqual({
      type: 'session.ready',
      sessionId: spec.sessionId,
      workspace: 'cloned',
    });
  });

  it('does not clone or set up again when every root has a matching stamp', async () => {
    const harness = rootsHarness();
    await harness.manager.prepare(rootSpec());
    const second = rootsHarness({ repos: [API, WEB], stamps: Object.fromEntries(harness.stamps) });

    await second.manager.prepare(rootSpec());

    expect(second.clones()).toEqual([]);
    expect(second.setups).toEqual([]);
    // Only the origin check runs, as it does for every route.
    expect(second.gitCalls.map(call => call.args.slice(0, 2).join(' '))).toEqual([
      'remote get-url',
      'remote get-url',
    ]);
    expect(second.frames.at(-1)).toMatchObject({ type: 'session.ready', workspace: 'same' });
  });

  it('prepares again, setup included, when one root has no matching stamp', async () => {
    const harness = rootsHarness({
      repos: [API, WEB],
      stamps: { [API]: { allocationId: 'alloc-current', commit: 'c' } },
    });

    await harness.manager.prepare(rootSpec());

    // The stamped root is left alone; the unstamped one is checked out again.
    expect(harness.clones()).toEqual([]);
    expect(harness.callsAt(API, 'checkout')).toEqual([]);
    expect(harness.callsAt(WEB, 'checkout')).not.toEqual([]);
    expect(harness.setups).toEqual([{ command: 'npm install', directory: CWD }]);
    expect(harness.stamps.get(WEB)).toEqual({
      allocationId: 'alloc-current',
      commit: 'commit-web',
    });
    expect(harness.frames.at(-1)).toMatchObject({ type: 'session.ready', workspace: 'cloned' });
  });

  describe('saved worktree changes', () => {
    const saved = {
      files: [
        { path: 'web/src/a.ts', status: 'modified' as const, patch: 'web patch' },
        { path: 'api/b.ts', status: 'modified' as const, patch: 'api patch' },
      ],
    };

    it('restores each root with its own paths, then sends ingest diffs only where nothing was restored', async () => {
      const calls: Array<[string, string[]]> = [];
      const harness = rootsHarness({
        recoverWorktree: async (directory, files) => {
          calls.push([directory, files]);
          return { applied: directory === API ? 0 : 1, skipped: 0, total: 1, skippedDiffs: [] };
        },
      });

      await harness.manager.prepare(rootSpec({ worktreeRecovery: saved }));

      expect(calls).toEqual([
        [API, ['b.ts']],
        [WEB, ['src/a.ts']],
      ]);
      // Only the root whose changes were restored is kept from older ingest diffs.
      expect(harness.restoreOptions[0]).toMatchObject({
        restoreFiles: true,
        roots: { directories: [API, WEB], recovered: [WEB] },
      });
    });

    it('leaves ingest restoration out when every root was restored', async () => {
      const harness = rootsHarness({
        recoverWorktree: async () => ({ applied: 1, skipped: 0, total: 1, skippedDiffs: [] }),
      });

      await harness.manager.prepare(rootSpec({ worktreeRecovery: saved }));

      expect(harness.restoreOptions[0]).toMatchObject({
        restoreFiles: false,
        roots: { directories: [API, WEB], recovered: [API, WEB] },
      });
      expect(harness.frames.at(-1)).toMatchObject({ type: 'session.ready' });
    });

    it('keeps the roots restored before a failure out of ingest restoration', async () => {
      const harness = rootsHarness({
        recoverWorktree: async directory => {
          if (directory === WEB) throw new Error('boom');
          return { applied: 1, skipped: 0, total: 1, skippedDiffs: [] };
        },
      });

      await harness.manager.prepare(rootSpec({ worktreeRecovery: saved }));

      expect(harness.restoreOptions[0]).toMatchObject({
        restoreFiles: true,
        roots: { directories: [API, WEB], recovered: [API] },
      });
      expect(harness.frames.at(-1)).toMatchObject({ type: 'session.ready' });
    });

    it('restores the roots after a failing root, so ingest touches only the root that failed', async () => {
      const calls: string[] = [];
      const harness = rootsHarness({
        recoverWorktree: async directory => {
          calls.push(directory);
          if (directory === API) throw new Error('boom');
          return { applied: 1, skipped: 0, total: 1, skippedDiffs: [] };
        },
      });

      await harness.manager.prepare(rootSpec({ worktreeRecovery: saved }));

      expect(calls).toEqual([API, WEB]);
      expect(harness.restoreOptions[0]).toMatchObject({
        restoreFiles: true,
        roots: { directories: [API, WEB], recovered: [WEB] },
      });
    });
  });

  it('stops before setup when a clone fails, and names the repository', async () => {
    const harness = rootsHarness({
      failClone: url =>
        url === WEB_URL
          ? { stdout: '', stderr: 'fatal: repository not found', exitCode: 128 }
          : undefined,
    });

    await harness.manager.prepare(rootSpec());

    expect(harness.setups).toEqual([]);
    expect(harness.stamps.size).toBe(0);
    expect(failure(harness.frames)).toMatchObject({
      reason: 'workspace_setup_failed',
      step: 'clone',
    });
    expect(
      harness.logs.some(line => line.includes('prepare failed') && line.includes('acme/web'))
    ).toBe(true);
    expect(harness.logs.join('\n')).not.toContain('acme/api:');
  });

  it('adopts each foreign root once and never empties the cwd', async () => {
    const harness = rootsHarness({
      repos: [API, WEB],
      stamps: { [API]: FOREIGN, [WEB]: FOREIGN },
    });

    await harness.manager.prepare(rootSpec());

    for (const directory of [API, WEB]) {
      expect(harness.callsAt(directory, 'fetch')).toHaveLength(1);
      expect(harness.callsAt(directory, 'remote').map(call => call.args)).toContainEqual([
        'remote',
        'set-url',
        'origin',
        directory === API ? API_URL : WEB_URL,
      ]);
    }
    expect(harness.clones()).toEqual([]);
    expect(harness.emptied).toEqual([]);
    expect(harness.setups).toEqual([{ command: 'npm install', directory: CWD }]);
    expect(harness.frames.at(-1)).toMatchObject({ type: 'session.ready', workspace: 'adopted' });
  });

  it('empties and clones only the root whose adoption failed', async () => {
    const harness = rootsHarness({
      repos: [API, WEB],
      stamps: { [API]: FOREIGN, [WEB]: FOREIGN },
      failAdopt: cwd => cwd === WEB,
    });

    await harness.manager.prepare(rootSpec());

    expect(harness.emptied).toEqual([WEB]);
    expect(harness.clones()).toEqual([{ url: WEB_URL, directory: WEB }]);
    expect(harness.emptied).not.toContain(CWD);
    expect(harness.frames.at(-1)).toMatchObject({ type: 'session.ready', workspace: 'cloned' });
  });

  it('normalizes the origin of every root', async () => {
    const harness = rootsHarness();

    await harness.manager.prepare(rootSpec());

    for (const directory of [API, WEB]) {
      expect(
        harness.callsAt(directory, 'remote').filter(call => call.args[1] === 'get-url')
      ).toHaveLength(1);
    }
  });

  it('gives each root the alias of its own host: the launch alias, or the grant entry for another host', async () => {
    const gitlab = 'https://gitlab.com/group/docs.git';
    const gitlabRoot = {
      directory: '/workspace/docs',
      repoFullName: 'group/docs',
      git: { url: gitlab, platform: 'gitlab' as const },
      branch: 'kilo/generated',
      branchMode: 'working' as const,
    };
    const spec = rootSpec({
      git: { url: gitlab, token: GITLAB_ALIAS, platform: 'gitlab' },
      roots: [gitlabRoot, ...(rootSpec().roots ?? [])],
    });
    const credentials = (
      gitCredentials: Array<{ url: string; token: string; platform: 'github' }>
    ) => ({
      sessionId: spec.sessionId,
      git: { token: GITLAB_ALIAS, platform: 'gitlab' as const },
      gitCredentials,
      kilo: { token: 'kilo-token' },
    });
    const managedClones = (harness: ReturnType<typeof rootsHarness>) =>
      harness.gitCalls
        .filter(call => call.args.includes('clone'))
        .map(call => ({
          url: call.args.at(-2),
          managed: call.args.includes(MANAGED_GITHUB_OPTION),
        }));

    const granted = rootsHarness();
    await granted.manager.prepare(
      spec,
      credentials([{ url: API_URL, token: GITHUB_ALIAS, platform: 'github' }])
    );
    // Both GitHub members take the grant's GitHub alias; the GitLab launch root never does.
    expect(managedClones(granted)).toEqual([
      { url: gitlab, managed: false },
      { url: API_URL, managed: true },
      { url: WEB_URL, managed: true },
    ]);

    const ungranted = rootsHarness();
    await ungranted.manager.prepare(spec, credentials([]));
    // Without a grant entry for github.com a member gets no alias, and not the GitLab one.
    expect(managedClones(ungranted)).toEqual([
      { url: gitlab, managed: false },
      { url: API_URL, managed: false },
      { url: WEB_URL, managed: false },
    ]);
    for (const call of [...granted.gitCalls, ...ungranted.gitCalls]) {
      expect(call.args.join(' ')).not.toContain('kcp1.');
    }
  });

  it('gives all roots one clone budget, so a slow second clone times out within it', async () => {
    const cloneMs = 600;
    const harness = rootsHarness({
      timers: { ...CONTROL_PLANE_TIMERS, wrapper: { ...CONTROL_PLANE_TIMERS.wrapper, cloneMs } },
      // The first repository takes most of the budget; the second never ends.
      cloneDelayMs: url => (url === API_URL ? 500 : Number.POSITIVE_INFINITY),
    });

    const startedAt = Date.now();
    await harness.manager.prepare(rootSpec());
    const elapsedMs = Date.now() - startedAt;

    expect(failure(harness.frames)).toMatchObject({
      reason: 'workspace_setup_failed',
      step: 'clone',
      subtype: 'git_clone_timeout',
    });
    // A budget of its own for the second root would end at about 1100 ms.
    expect(elapsedMs).toBeLessThan(cloneMs + 250);
    expect(harness.setups).toEqual([]);
  });

  it('gives all adopted roots one restore budget, then clones the root that ran out of it', async () => {
    const restoreMs = 600;
    const harness = rootsHarness({
      repos: [API, WEB],
      stamps: { [API]: FOREIGN, [WEB]: FOREIGN },
      timers: { ...CONTROL_PLANE_TIMERS, wrapper: { ...CONTROL_PLANE_TIMERS.wrapper, restoreMs } },
      // The first adoption takes most of the budget; the second never ends.
      fetchDelayMs: cwd => (cwd === API ? 500 : Number.POSITIVE_INFINITY),
    });

    const startedAt = Date.now();
    await harness.manager.prepare(rootSpec());
    const elapsedMs = Date.now() - startedAt;

    expect(harness.emptied).toEqual([WEB]);
    expect(harness.clones()).toEqual([{ url: WEB_URL, directory: WEB }]);
    expect(harness.frames.at(-1)).toMatchObject({ type: 'session.ready', workspace: 'cloned' });
    // A budget of its own for the second root would end at about 1100 ms.
    expect(elapsedMs).toBeLessThan(restoreMs + 250);
  });

  it('names the repository in the progress of a failing checkout, and a V1 route names none', async () => {
    const harness = rootsHarness({
      failCheckout: cwd =>
        cwd === WEB
          ? { stdout: '', stderr: "fatal: 'origin/nope' is not a commit", exitCode: 128 }
          : undefined,
    });

    await harness.manager.prepare(rootSpec());

    expect(failure(harness.frames)).toMatchObject({ step: 'checkout' });
    const lastCheckout = progressDetails(harness.frames, 'checkout').at(-1);
    expect(lastCheckout).toContain('acme/web');
    expect(progressDetails(harness.frames, 'checkout')).toContain('acme/api');
    expect(harness.setups).toEqual([]);

    const { roots: _roots, ...legacy } = rootSpec();
    const v1 = rootsHarness();
    await v1.manager.prepare({ ...legacy, directory: '/workspace/app' });
    expect(progressDetails(v1.frames, 'checkout')).toEqual([null]);
  });

  it('names the repository in the restore progress of an adopted root', async () => {
    const harness = rootsHarness({
      repos: [API, WEB],
      stamps: { [API]: FOREIGN, [WEB]: FOREIGN },
    });

    await harness.manager.prepare(rootSpec());

    expect(progressDetails(harness.frames, 'restore')).toEqual(['acme/api', 'acme/web']);
  });

  it('does not clone a finished root again when a retry follows a failed clone of another', async () => {
    let webFails = true;
    const first = rootsHarness({
      failClone: url =>
        url === WEB_URL && webFails
          ? { stdout: '', stderr: 'fatal: unable to access', exitCode: 128 }
          : undefined,
    });
    await first.manager.prepare(rootSpec());
    webFails = false;
    expect(first.clones().map(clone => clone.directory)).toContain(API);
    expect(first.stamps.size).toBe(0);

    const retry = rootsHarness({
      repos: [...first.repos],
      stamps: Object.fromEntries(first.stamps),
    });
    await retry.manager.prepare(rootSpec());

    expect(retry.clones()).toEqual([{ url: WEB_URL, directory: WEB }]);
    expect(retry.setups).toEqual([{ command: 'npm install', directory: CWD }]);
    expect([...retry.stamps.keys()]).toEqual([API, WEB]);
    expect(retry.frames.at(-1)).toMatchObject({ type: 'session.ready', workspace: 'cloned' });
  });
});

describe('preparing a route with one git root', () => {
  it('keeps the frame of a V1 route readable and prepares it at its directory', async () => {
    const { roots: _roots, ...legacy } = rootSpec();
    const spec: ControlPlaneRouteSpec = { ...legacy, directory: '/workspace/app' };
    expect(
      controlPlaneWrapperFrameSchema.safeParse({ type: 'session.prepare', spec }).success
    ).toBe(true);
    const harness = rootsHarness();

    await harness.manager.prepare(spec);

    expect(harness.clones()).toEqual([{ url: API_URL, directory: '/workspace/app' }]);
    expect(harness.setups).toEqual([{ command: 'npm install', directory: '/workspace/app' }]);
    expect([...harness.stamps.keys()]).toEqual(['/workspace/app']);
  });

  it('clones a one-repository V2 route at its repository directory, which is also the cwd', async () => {
    const spec = rootSpec({
      directory: API,
      roots: [
        {
          directory: API,
          repoFullName: 'acme/api',
          git: { url: API_URL, platform: 'github' },
          branch: 'kilo/generated',
          branchMode: 'working',
        },
      ],
    });
    const harness = rootsHarness();

    await harness.manager.prepare(spec);

    expect(harness.clones()).toEqual([{ url: API_URL, directory: API }]);
    expect(harness.setups).toEqual([{ command: 'npm install', directory: API }]);
    expect([...harness.stamps.keys()]).toEqual([API]);
  });
});

/** Two real repositories on disk, prepared by the real git, setup runner and stamp files. */
describe('preparing real repositories in two roots', () => {
  function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@example.com',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@example.com',
      },
    }).trim();
  }

  async function remote(root: string, name: string, branches: string[]): Promise<string> {
    const bare = path.join(root, 'remotes', `${name}.git`);
    const work = path.join(root, 'seed', name);
    await fs.mkdir(work, { recursive: true });
    git(work, 'init', '--quiet', '--initial-branch=main');
    await fs.writeFile(path.join(work, 'README.md'), name);
    git(work, 'add', '.');
    git(work, 'commit', '--quiet', '-m', 'init');
    for (const branch of branches) git(work, 'branch', branch);
    await fs.mkdir(path.dirname(bare), { recursive: true });
    git(root, 'clone', '--quiet', '--bare', work, bare);
    return `file://${bare}`;
  }

  function realManager(
    base: string,
    emit: (frame: ControlPlaneWrapperFrame) => void = () => undefined
  ) {
    return createPreparationManager({
      timers: CONTROL_PLANE_TIMERS,
      emit,
      runtimes: {
        ensure: async () =>
          ({
            serverUrl: 'http://127.0.0.1:1',
            ensureSession: async () => undefined,
          }) as unknown as WrapperKiloClient,
        installCredentials: async () => undefined,
        isUnavailable: () => false,
        getLiveClient: () => undefined,
        remove: () => undefined,
        release: () => undefined,
      },
      inheritedEnv: process.env,
      homeRoots: { directory: path.join(base, 'home'), legacy: path.join(base, 'legacy') },
      allocationId: 'alloc-current',
      seedRegistration: async () => undefined,
      sessionExists: async () => true,
      sleep: async () => undefined,
    });
  }

  it('checks out each root on its branch, runs setup once at the cwd, and restarts without setup', async () => {
    const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'prepare-roots-')));
    try {
      const apiUrl = await remote(base, 'api', []);
      const webUrl = await remote(base, 'web', ['feature/web']);
      const cwd = path.join(base, 'workspace');
      const apiDir = path.join(cwd, 'api');
      const webDir = path.join(cwd, 'web');
      const marker = path.join(cwd, 'setup-runs.txt');
      const spec = rootSpec({
        directory: cwd,
        git: { url: apiUrl, platform: 'github' },
        setupCommands: [`pwd >> '${marker}'`],
        roots: [
          {
            directory: apiDir,
            repoFullName: 'acme/api',
            git: { url: apiUrl, platform: 'github' },
            branch: 'kilo/generated',
            branchMode: 'working',
          },
          {
            directory: webDir,
            repoFullName: 'acme/web',
            git: { url: webUrl, platform: 'github' },
            branch: 'feature/web',
          },
        ],
      });
      const manager = () => realManager(base);

      await manager().prepare(spec);

      expect(git(apiDir, 'branch', '--show-current')).toBe('kilo/generated');
      expect(git(webDir, 'branch', '--show-current')).toBe('feature/web');
      expect(git(webDir, 'rev-parse', '--abbrev-ref', '@{upstream}')).toBe('origin/feature/web');
      expect(await fs.readFile(marker, 'utf8')).toBe(`${cwd}\n`);
      for (const directory of [apiDir, webDir]) {
        const stamp = JSON.parse(
          await fs.readFile(path.join(directory, '.git', 'kilo-workspace.json'), 'utf8')
        ) as WorkspaceStamp;
        expect(stamp.allocationId).toBe('alloc-current');
        expect(stamp.commit).toBe(git(directory, 'rev-parse', 'HEAD'));
      }
      expect(await fs.readdir(cwd).then(names => names.sort())).toEqual([
        'api',
        'setup-runs.txt',
        'web',
      ]);

      // A wrapper restart finds both stamps and runs no setup.
      await manager().prepare(spec);
      expect(await fs.readFile(marker, 'utf8')).toBe(`${cwd}\n`);

      // One missing stamp prepares the workspace again, with setup.
      await fs.rm(path.join(webDir, '.git', 'kilo-workspace.json'));
      await manager().prepare(spec);
      expect(await fs.readFile(marker, 'utf8')).toBe(`${cwd}\n${cwd}\n`);
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  });

  it('fails at checkout, naming the repository, when a requested branch is missing', async () => {
    const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'prepare-roots-')));
    try {
      const apiUrl = await remote(base, 'api', []);
      const webUrl = await remote(base, 'web', []);
      const cwd = path.join(base, 'workspace');
      const marker = path.join(cwd, 'setup-runs.txt');
      const spec = rootSpec({
        directory: cwd,
        git: { url: apiUrl, platform: 'github' },
        setupCommands: [`pwd >> '${marker}'`],
        roots: [
          {
            directory: path.join(cwd, 'api'),
            repoFullName: 'acme/api',
            git: { url: apiUrl, platform: 'github' },
            branch: 'kilo/generated',
            branchMode: 'working',
          },
          {
            directory: path.join(cwd, 'web'),
            repoFullName: 'acme/web',
            git: { url: webUrl, platform: 'github' },
            branch: 'nope/branch',
          },
        ],
      });
      const frames: ControlPlaneWrapperFrame[] = [];

      await realManager(base, frame => frames.push(frame)).prepare(spec);

      expect(failure(frames)).toMatchObject({ reason: 'workspace_setup_failed', step: 'checkout' });
      expect(progressDetails(frames, 'checkout').at(-1)).toContain('acme/web');
      const setupRan = await fs.access(marker).then(
        () => true,
        () => false
      );
      expect(setupRan).toBe(false);
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  });
});
