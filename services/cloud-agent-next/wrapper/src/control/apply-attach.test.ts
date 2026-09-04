import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applySessionAttach, type ApplyAttachDeps } from './apply-attach';
import { KILO_CONTROL_REQUEST_TIMEOUT_MS } from './sandbox-control-runtime';
import { runProcess, withTimeoutAndAbort } from '../utils';
import type { WrapperKiloClient } from '../kilo-api';
import type { PreparingEventDataV2 } from '../../../src/shared/protocol.js';
import { CONTROL_RUNTIME_RESERVED_ENV_VARS } from '../../../src/shared/runtime-environment.js';
import { sessionPreparingPayloadSchema } from '../../../src/shared/sandbox-control-protocol';
import {
  buildWorktreeKiloEnvironment,
  createWorktreeKiloRuntimes,
  WorktreeKiloRuntimeError,
  type WorktreeKiloAuth,
  type WorktreeKiloRuntime,
  type WorktreeKiloRuntimes,
} from './worktree-runtime';
import {
  rememberAttachedRoot,
  rememberChildSession,
  resetSessionDirectoryState,
  rootForSession,
} from './session-directories';
import { fenceDirectoryOperations, resetDirectoryOperationState } from './worktree-operations';

const session = {
  sessionId: 'workspace_1',
  kiloSessionId: 'kilo_1',
  directory: '/workspace/a',
};

const kilo: WorktreeKiloAuth = {
  scopeId: 'worktree_a',
  token: 'guest-kilo-credential',
  targets: {
    backendBaseUrl: 'https://backend.example.test',
    providerBaseUrl: 'https://provider.example.test',
    sessionIngestBaseUrl: 'https://ingest.example.test',
  },
};

const siblingSession = { ...session, sessionId: 'workspace_2', kiloSessionId: 'kilo_2' };

let homeRoot: string;
const registries: WorktreeKiloRuntimes[] = [];

function isolatedKiloRuntimes(): WorktreeKiloRuntimes {
  const runtimes = createWorktreeKiloRuntimes({
    homeRoot: path.join(homeRoot, 'homes'),
    inheritedEnv: {},
    onUnexpectedClose: () => {
      throw new Error('Unexpected Kilo feed closure');
    },
    startServer: async () => {
      const server = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        fetch(request) {
          const url = new URL(request.url);
          if (url.pathname === '/global/event') {
            return new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(
                    new TextEncoder().encode(
                      'data: {"payload":{"type":"server.connected","properties":{}}}\n\n'
                    )
                  );
                },
              }),
              { headers: { 'Content-Type': 'text/event-stream' } }
            );
          }
          return Response.json({ id: url.pathname.split('/').at(-1) });
        },
      });
      return {
        url: server.url.toString(),
        close: () => {
          void server.stop(true);
        },
      };
    },
  });
  registries.push(runtimes);
  return runtimes;
}

function fakeKiloRuntimes(overrides: Partial<WrapperKiloClient> = {}): WorktreeKiloRuntimes {
  const kiloClient = {
    getSession: async (id: string) => ({ id }),
    ensureSession: async () => undefined,
    ...overrides,
  } as WrapperKiloClient;
  const runtimes = new Map<string, WorktreeKiloRuntime>();
  const key = (identity: typeof session) =>
    `${identity.sessionId}\0${identity.kiloSessionId}\0${identity.directory}`;
  return {
    attach(identity, auth, environment, _canRefreshCredentials) {
      const { directory } = identity;
      let runtime = runtimes.get(key(identity));
      if (!runtime) {
        runtime = {
          identity: { ...identity },
          directory,
          scopeId: auth.scopeId,
          env: buildWorktreeKiloEnvironment(
            directory,
            fs.mkdtempSync(path.join(homeRoot, 'worktree-')),
            auth,
            environment,
            {}
          ),
          kiloClient,
          signal: new AbortController().signal,
        };
        runtimes.set(key(identity), runtime);
      }
      return {
        ready: Promise.resolve(runtime),
        signal: runtime.signal,
        commit: () => {},
        release: () => {},
      };
    },
    detach: () => true,
    deleteDirectory: async directory => {
      for (const [key, runtime] of runtimes) {
        if (runtime.directory === directory) runtimes.delete(key);
      }
    },
    get: identity => runtimes.get(key(identity)),
    getAll: directory => [...runtimes.values()].filter(runtime => runtime.directory === directory),
    isCurrent: runtime => runtimes.get(key(runtime.identity)) === runtime,
    isHealthy: () => true,
    shutdown: () => {},
  };
}

beforeEach(() => {
  resetSessionDirectoryState();
  resetDirectoryOperationState();
  homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-attach-test-'));
});

afterEach(() => {
  for (const registry of registries) registry.shutdown();
  registries.length = 0;
  fs.rmSync(homeRoot, { recursive: true, force: true });
});

const noFs = {
  hasBootstrapMarker: async () => false,
  writeBootstrapMarker: async () => undefined,
};

describe('applySessionAttach', () => {
  describe('working branches', () => {
    let repository: string;
    let directory: string;
    let deps: ApplyAttachDeps;
    const payload = { kilo, git: { url: 'https://github.com/acme/demo.git' } };
    const runGit = (args: string[], cwd: string) =>
      runProcess('git', args, {
        cwd,
        env: { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
      });
    const currentBranch = async () =>
      (await runGit(['branch', '--show-current'], directory)).stdout.trim();

    beforeEach(async () => {
      repository = path.join(homeRoot, 'repository');
      directory = path.join(homeRoot, 'checkout');
      fs.mkdirSync(repository);
      expect((await runGit(['init', '--initial-branch=main'], repository)).exitCode).toBe(0);
      expect(
        (
          await runGit(
            [
              '-c',
              'user.name=Test',
              '-c',
              'user.email=test@example.com',
              'commit',
              '--allow-empty',
              '-m',
              'Initial commit',
            ],
            repository
          )
        ).exitCode
      ).toBe(0);
      expect((await runGit(['branch', 'feature/existing'], repository)).exitCode).toBe(0);
      deps = {
        kiloRuntimes: fakeKiloRuntimes(),
        sessionExists: async () => true,
        runGit: (args, cwd, signal) =>
          runProcess('git', args[0] === 'clone' ? ['clone', repository, args[2]] : args, {
            cwd,
            signal,
            env: { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
          }),
      };
    });

    it('creates a stable working branch before setup when no branch was requested', async () => {
      const setupBranches: string[] = [];
      const result = await applySessionAttach(
        { ...session, directory },
        { ...payload, setupCommands: ['prepare'] },
        {
          ...deps,
          runSetup: async () => {
            setupBranches.push(await currentBranch());
            return { stdout: '', stderr: '', exitCode: 0 };
          },
        }
      );
      expect(result).toEqual({ ok: true, result: { attached: true } });
      expect(await currentBranch()).toBe('session/worktree_a');
      expect(setupBranches).toEqual(['session/worktree_a']);
    });

    it.each(['main', 'feature/existing'])(
      'honors the explicitly requested branch %s',
      async branch => {
        const result = await applySessionAttach(
          { ...session, directory },
          { ...payload, branch },
          deps
        );
        expect(result).toEqual({ ok: true, result: { attached: true } });
        expect(await currentBranch()).toBe(branch);
      }
    );

    it('fails preparation rather than falling back to main for a missing requested branch', async () => {
      let setupRan = false;
      const result = await applySessionAttach(
        { ...session, directory },
        { ...payload, branch: 'missing', setupCommands: ['prepare'] },
        {
          ...deps,
          runSetup: async () => {
            setupRan = true;
            return { stdout: '', stderr: '', exitCode: 0 };
          },
        }
      );
      expect(result).toEqual({
        ok: false,
        error: { code: 'not_ready', message: 'git checkout failed', retryable: true },
      });
      expect(setupRan).toBe(false);
    });

    it('preserves generated-branch commits when retrying failed setup', async () => {
      let setupRuns = 0;
      let commit = '';
      const retryDeps: ApplyAttachDeps = {
        ...deps,
        runSetup: async () => {
          setupRuns += 1;
          if (setupRuns === 1) {
            expect(
              (await runGit(['commit', '--allow-empty', '-m', 'Setup work'], directory)).exitCode
            ).toBe(0);
            commit = (await runGit(['rev-parse', 'HEAD'], directory)).stdout.trim();
          }
          return { stdout: '', stderr: '', exitCode: setupRuns === 1 ? 1 : 0 };
        },
      };
      const attach = () =>
        applySessionAttach(
          { ...session, directory },
          { ...payload, setupCommands: ['prepare'] },
          retryDeps
        );
      expect((await attach()).ok).toBe(false);
      expect((await attach()).ok).toBe(true);
      expect(await currentBranch()).toBe('session/worktree_a');
      expect((await runGit(['rev-parse', 'HEAD'], directory)).stdout.trim()).toBe(commit);
    });

    it('does not switch a warm sibling away from a user-selected branch or discard edits', async () => {
      expect((await applySessionAttach({ ...session, directory }, payload, deps)).ok).toBe(true);
      expect((await runGit(['checkout', '-b', 'user-selected'], directory)).exitCode).toBe(0);
      fs.writeFileSync(path.join(directory, 'work.txt'), 'shared work');
      expect((await applySessionAttach({ ...siblingSession, directory }, payload, deps)).ok).toBe(
        true
      );
      expect(await currentBranch()).toBe('user-selected');
      expect(fs.readFileSync(path.join(directory, 'work.txt'), 'utf8')).toBe('shared work');
    });

    it('restores pushed working-branch commits when a sibling bootstraps a replacement checkout', async () => {
      expect((await applySessionAttach({ ...session, directory }, payload, deps)).ok).toBe(true);
      fs.writeFileSync(path.join(directory, 'saved.txt'), 'committed shared work');
      expect((await runGit(['add', 'saved.txt'], directory)).exitCode).toBe(0);
      expect((await runGit(['commit', '-m', 'Save shared work'], directory)).exitCode).toBe(0);
      expect(
        (await runGit(['push', '-u', 'origin', 'session/worktree_a'], directory)).exitCode
      ).toBe(0);
      const commit = (await runGit(['rev-parse', 'HEAD'], directory)).stdout.trim();

      directory = path.join(homeRoot, 'replacement');
      expect((await applySessionAttach({ ...siblingSession, directory }, payload, deps)).ok).toBe(
        true
      );
      expect(await currentBranch()).toBe('session/worktree_a');
      expect((await runGit(['rev-parse', 'HEAD'], directory)).stdout.trim()).toBe(commit);
      expect(
        (
          await runGit(
            ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
            directory
          )
        ).stdout.trim()
      ).toBe('origin/session/worktree_a');
      expect(fs.readFileSync(path.join(directory, 'saved.txt'), 'utf8')).toBe(
        'committed shared work'
      );
    });

    it('uses the same working branch when a sibling bootstraps a replacement checkout', async () => {
      expect((await applySessionAttach({ ...session, directory }, payload, deps)).ok).toBe(true);
      const branch = await currentBranch();
      directory = path.join(homeRoot, 'replacement');
      expect((await applySessionAttach({ ...siblingSession, directory }, payload, deps)).ok).toBe(
        true
      );
      expect(await currentBranch()).toBe('session/worktree_a');
      expect(await currentBranch()).toBe(branch);
    });
  });

  it('reuses setup-only workspaces without writing bootstrap state into their content', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'control-bootstrap-'));
    const directory = path.join(root, 'workspace');
    let setupRuns = 0;
    const deps: ApplyAttachDeps = {
      kiloRuntimes: fakeKiloRuntimes(),
      runSetup: async () => {
        setupRuns += 1;
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      sessionExists: async () => true,
    };
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        expect(
          await applySessionAttach(
            { ...session, directory },
            { kilo, setupCommands: ['true'] },
            deps
          )
        ).toEqual({ ok: true, result: { attached: true } });
      }
      expect(setupRuns).toBe(1);
      expect(fs.readdirSync(directory)).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('clones and checks out a non-default branch without mutating process.env', async () => {
    const gitCalls: string[][] = [];
    const mkdirCalls: string[] = [];
    const envBefore = process.env.KILOCODE_TOKEN;
    const result = await applySessionAttach(
      session,
      {
        kilo,
        directory: '/workspace/a',
        branch: 'feature/non-default',
        git: { url: 'https://github.com/acme/demo.git', token: 'secret', platform: 'github' },
        env: { KILOCODE_TOKEN: 'cap_1' },
      },
      {
        kiloRuntimes: fakeKiloRuntimes(),
        ...noFs,
        sessionExists: async () => true,
        mkdir: async directory => {
          mkdirCalls.push(directory);
        },
        hasGit: async () => false,
        runGit: async args => {
          gitCalls.push(args);
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      }
    );
    expect(result).toEqual({ ok: true, result: { attached: true } });
    expect(mkdirCalls).toEqual(['/workspace/a']);
    expect(gitCalls[0]?.[0]).toBe('clone');
    expect(gitCalls[0]?.includes('--branch')).toBe(false);
    expect(gitCalls[1]).toEqual([
      'checkout',
      '-B',
      'feature/non-default',
      'origin/feature/non-default',
    ]);
    expect(gitCalls[0]?.some(arg => arg.includes('secret'))).toBe(true);
    expect(process.env.KILOCODE_TOKEN).toBe(envBefore);
  });

  it('preserves generic repository authentication and checks out only the requested upstream branch', async () => {
    const gitCalls: string[][] = [];
    const repositoryUrl = 'https://git.example.com/acme/demo.git';
    const fakeGitToken = 'fake-git-token';
    const authenticatedUrl = new URL(repositoryUrl);
    authenticatedUrl.username = 'x-access-token';
    authenticatedUrl.password = fakeGitToken;
    const result = await applySessionAttach(
      session,
      {
        kilo,
        branch: 'topic/shared-worktree',
        git: { url: repositoryUrl, token: fakeGitToken },
      },
      {
        kiloRuntimes: fakeKiloRuntimes(),
        ...noFs,
        sessionExists: async () => true,
        mkdir: async () => {},
        hasGit: async () => false,
        runGit: async args => {
          gitCalls.push(args);
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      }
    );
    expect(result).toEqual({ ok: true, result: { attached: true } });
    expect(gitCalls).toEqual([
      ['clone', authenticatedUrl.href, session.directory],
      ['checkout', '-B', 'topic/shared-worktree', 'origin/topic/shared-worktree'],
      ['config', 'user.name', 'Kilo Code Cloud'],
      ['config', 'user.email', 'agent@kilocode.ai'],
    ]);
  });

  it('skips clone when the directory already has git metadata', async () => {
    const gitCalls: string[][] = [];
    const result = await applySessionAttach(
      session,
      { kilo, git: { url: 'https://github.com/acme/demo.git' } },
      {
        kiloRuntimes: fakeKiloRuntimes(),
        ...noFs,
        sessionExists: async () => true,
        mkdir: async () => undefined,
        hasGit: async () => true,
        runGit: async args => {
          gitCalls.push(args);
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      }
    );
    expect(result.ok).toBe(true);
    expect(gitCalls).toEqual([
      ['show-ref', '--verify', '--quiet', 'refs/heads/session/worktree_a'],
      ['checkout', 'session/worktree_a'],
      ['config', 'user.name', 'Kilo Code Cloud'],
      ['config', 'user.email', 'agent@kilocode.ai'],
    ]);
  });

  it('checks out the requested branch when the directory already has git metadata', async () => {
    const gitCalls: Array<{ args: string[]; cwd?: string }> = [];
    const result = await applySessionAttach(
      session,
      { kilo, branch: 'feature/retry', git: { url: 'https://github.com/acme/demo.git' } },
      {
        kiloRuntimes: fakeKiloRuntimes(),
        ...noFs,
        sessionExists: async () => true,
        mkdir: async () => undefined,
        hasGit: async () => true,
        runGit: async (args, cwd) => {
          gitCalls.push({ args, cwd });
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      }
    );

    expect(result).toEqual({ ok: true, result: { attached: true } });
    expect(gitCalls).toEqual([
      { args: ['checkout', '-B', 'feature/retry', 'origin/feature/retry'], cwd: '/workspace/a' },
      { args: ['config', 'user.name', 'Kilo Code Cloud'], cwd: '/workspace/a' },
      { args: ['config', 'user.email', 'agent@kilocode.ai'], cwd: '/workspace/a' },
    ]);
  });

  it('retries branch checkout after cloning succeeds but the initial checkout fails', async () => {
    const gitCalls: string[][] = [];
    const setupCalls: string[] = [];
    const events: PreparingEventDataV2[] = [];
    let gitExists = false;
    let bootstrapComplete = false;
    let markerWrites = 0;
    let checkoutAttempts = 0;
    const payload = {
      kilo,
      branch: 'feature/retry',
      git: { url: 'https://github.com/acme/demo.git' },
      setupCommands: ['pnpm install'],
      preparation: { attemptId: 'att_1', triggerMessageId: 'msg_1' },
    };
    const deps: ApplyAttachDeps = {
      kiloRuntimes: fakeKiloRuntimes(),
      sessionExists: async () => true,
      mkdir: async () => undefined,
      hasGit: async () => gitExists,
      hasBootstrapMarker: async () => bootstrapComplete,
      writeBootstrapMarker: async () => {
        markerWrites += 1;
        bootstrapComplete = true;
      },
      runGit: async (args: string[]) => {
        gitCalls.push(args);
        if (args[0] === 'clone') {
          gitExists = true;
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (args[0] !== 'checkout') return { stdout: '', stderr: '', exitCode: 0 };
        checkoutAttempts += 1;
        return {
          stdout: '',
          stderr: checkoutAttempts === 1 ? 'checkout failed' : '',
          exitCode: checkoutAttempts === 1 ? 1 : 0,
        };
      },
      runSetup: async (command: string) => {
        setupCalls.push(command);
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      emitPreparing: (event: PreparingEventDataV2) => {
        events.push(event);
      },
    };

    const failed = await applySessionAttach(session, payload, deps);

    expect(failed).toEqual({
      ok: false,
      error: { code: 'not_ready', message: 'git checkout failed', retryable: true },
    });
    expect(gitExists).toBe(true);
    expect(setupCalls).toEqual([]);
    expect(markerWrites).toBe(0);

    const retried = await applySessionAttach(session, payload, deps);

    expect(retried).toEqual({ ok: true, result: { attached: true } });
    expect(gitCalls).toEqual([
      ['clone', 'https://github.com/acme/demo.git', '/workspace/a'],
      ['checkout', '-B', 'feature/retry', 'origin/feature/retry'],
      ['checkout', '-B', 'feature/retry', 'origin/feature/retry'],
      ['config', 'user.name', 'Kilo Code Cloud'],
      ['config', 'user.email', 'agent@kilocode.ai'],
    ]);
    expect(setupCalls).toEqual(['pnpm install']);
    expect(markerWrites).toBe(1);
    expect(events.filter(event => event.step === 'cloning').map(event => event.action)).toEqual([
      'step_started',
      'step_progress',
      'step_failed',
      'step_started',
      'step_completed',
    ]);
  });

  it('skips clone, branch checkout, and setup when the bootstrap marker is present', async () => {
    const gitCalls: string[][] = [];
    const setupCalls: string[] = [];
    const result = await applySessionAttach(
      session,
      {
        kilo,
        git: { url: 'https://github.com/acme/demo.git' },
        setupCommands: ['pnpm install'],
        branch: 'feature/shared-worktree',
      },
      {
        kiloRuntimes: fakeKiloRuntimes(),
        sessionExists: async () => true,
        hasBootstrapMarker: async () => true,
        writeBootstrapMarker: async () => undefined,
        mkdir: async () => undefined,
        hasGit: async () => false,
        runGit: async args => {
          gitCalls.push(args);
          return { stdout: '', stderr: '', exitCode: 0 };
        },
        runSetup: async command => {
          setupCalls.push(command);
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      }
    );
    expect(result.ok).toBe(true);
    expect(gitCalls).toEqual([]);
    expect(setupCalls).toEqual([]);
  });

  it.each([undefined, 'main'])(
    'serializes sibling cold clone/setup but allows independent Kilo restores (branch: %s)',
    async branch => {
      const cloneStarted = Promise.withResolvers<void>();
      const releaseClone = Promise.withResolvers<void>();
      const setupStarted = Promise.withResolvers<void>();
      const releaseSetup = Promise.withResolvers<void>();
      const bothRestoring = Promise.withResolvers<void>();
      const releaseRestore = Promise.withResolvers<void>();
      let gitExists = false;
      let bootstrapComplete = false;
      let markerWrites = 0;
      const gitOperations: string[] = [];
      const setupCommands: string[] = [];
      const restoredRoots: string[] = [];
      const payload = {
        kilo,
        git: { url: 'https://github.com/acme/demo.git' },
        branch,
        setupCommands: ['prepare'],
      };
      const deps: ApplyAttachDeps = {
        kiloRuntimes: fakeKiloRuntimes(),
        mkdir: async () => {},
        hasGit: async () => gitExists,
        hasBootstrapMarker: async () => bootstrapComplete,
        writeBootstrapMarker: async () => {
          markerWrites += 1;
          bootstrapComplete = true;
        },
        runGit: async args => {
          gitOperations.push(args[0]);
          if (args[0] === 'clone') {
            cloneStarted.resolve();
            await releaseClone.promise;
            gitExists = true;
          }
          return { stdout: '', stderr: '', exitCode: 0 };
        },
        runSetup: async command => {
          setupCommands.push(command);
          setupStarted.resolve();
          await releaseSetup.promise;
          return { stdout: '', stderr: '', exitCode: 0 };
        },
        sessionExists: async () => false,
        restoreSession: async id => {
          restoredRoots.push(id);
          if (restoredRoots.length === 2) bothRestoring.resolve();
          await releaseRestore.promise;
          return {
            ok: true,
            downloaded: true,
            imported: true,
            diffs: { applied: 0, skipped: 0, total: 0 },
          };
        },
      };
      const attaches = [applySessionAttach(session, payload, deps)];
      try {
        await cloneStarted.promise;
        attaches.push(
          applySessionAttach(
            { ...session, sessionId: 'workspace_2', kiloSessionId: 'kilo_2' },
            payload,
            deps
          )
        );
        await Bun.sleep(0);
        expect(gitOperations).toEqual(['clone']);
        releaseClone.resolve();
        await setupStarted.promise;
        await Bun.sleep(0);
        expect(gitOperations).toEqual([
          'clone',
          ...(branch ? [] : ['show-ref']),
          'checkout',
          'config',
          'config',
        ]);
        expect(setupCommands).toEqual(['prepare']);
        releaseSetup.resolve();
        await withTimeoutAndAbort(bothRestoring.promise, {
          timeoutMs: 1_000,
          timeoutMessage: 'Sibling restore was serialized with workspace preparation',
          abortMessage: 'Sibling restore cancelled',
        });
        releaseRestore.resolve();
        expect(await Promise.all(attaches)).toEqual([
          { ok: true, result: { attached: true } },
          { ok: true, result: { attached: true } },
        ]);
        expect(markerWrites).toBe(1);
        expect(restoredRoots.sort()).toEqual(['kilo_1', 'kilo_2']);
      } finally {
        releaseClone.resolve();
        releaseSetup.resolve();
        releaseRestore.resolve();
        await Promise.allSettled(attaches);
      }
    }
  );

  it('releases failed cold setup so a waiting sibling can retry and warm attaches skip it', async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let attempts = 0;
    let bootstrapComplete = false;
    let markerWrites = 0;
    const payload = { kilo, setupCommands: ['prepare'] };
    const deps: ApplyAttachDeps = {
      kiloRuntimes: fakeKiloRuntimes(),
      sessionExists: async () => true,
      mkdir: async () => {},
      hasBootstrapMarker: async () => bootstrapComplete,
      writeBootstrapMarker: async () => {
        markerWrites += 1;
        bootstrapComplete = true;
      },
      runSetup: async () => {
        const attempt = ++attempts;
        if (attempt === 1) {
          started.resolve();
          await release.promise;
        }
        return { stdout: '', stderr: '', exitCode: attempt === 1 ? 1 : 0 };
      },
    };
    const attaches = [applySessionAttach(session, payload, deps)];
    try {
      await started.promise;
      attaches.push(
        applySessionAttach(
          { ...session, sessionId: 'workspace_2', kiloSessionId: 'kilo_2' },
          payload,
          deps
        )
      );
      await Bun.sleep(0);
      expect(attempts).toBe(1);
      release.resolve();
      expect(await Promise.all(attaches)).toEqual([
        {
          ok: false,
          error: { code: 'not_ready', message: 'Setup command 1 failed', retryable: true },
        },
        { ok: true, result: { attached: true } },
      ]);
      expect(await applySessionAttach(session, payload, deps)).toEqual({
        ok: true,
        result: { attached: true },
      });
      expect(attempts).toBe(2);
      expect(markerWrites).toBe(1);
    } finally {
      release.resolve();
      await Promise.allSettled(attaches);
    }
  });

  it('does not block another worktree while one directory is running cold setup', async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const prepared: string[] = [];
    const deps: ApplyAttachDeps = {
      kiloRuntimes: fakeKiloRuntimes(),
      ...noFs,
      sessionExists: async () => true,
      mkdir: async () => {},
      runSetup: async (_command, directory) => {
        if (directory === session.directory) {
          started.resolve();
          await release.promise;
        }
        prepared.push(directory);
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    };
    const attaches = [applySessionAttach(session, { kilo, setupCommands: ['prepare'] }, deps)];
    try {
      await started.promise;
      const other = applySessionAttach(
        {
          sessionId: 'workspace_other',
          kiloSessionId: 'kilo_other',
          directory: '/workspace/other',
        },
        { kilo: { ...kilo, scopeId: 'worktree_other' }, setupCommands: ['prepare'] },
        deps
      );
      attaches.push(other);
      expect(
        await withTimeoutAndAbort(other, {
          timeoutMs: 1_000,
          timeoutMessage: 'Other worktree was blocked by cold setup',
          abortMessage: 'Other worktree setup cancelled',
        })
      ).toEqual({ ok: true, result: { attached: true } });
      expect(prepared).toEqual(['/workspace/other']);
    } finally {
      release.resolve();
      await Promise.allSettled(attaches);
    }
  });

  it('waits for directory preparation before attaching a sibling without workspace setup', async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const probed: string[] = [];
    let bootstrapped = false;
    const deps: ApplyAttachDeps = {
      kiloRuntimes: fakeKiloRuntimes(),
      mkdir: async () => {},
      hasBootstrapMarker: async () => bootstrapped,
      writeBootstrapMarker: async () => {
        bootstrapped = true;
      },
      runSetup: async () => {
        started.resolve();
        await release.promise;
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      sessionExists: async id => {
        probed.push(id);
        return true;
      },
    };
    const first = applySessionAttach(session, { kilo, setupCommands: ['prepare'] }, deps);
    await started.promise;
    const sibling = applySessionAttach(siblingSession, { kilo }, deps);
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(probed).toEqual([]);
      release.resolve();
      expect(await Promise.all([first, sibling])).toEqual([
        { ok: true, result: { attached: true } },
        { ok: true, result: { attached: true } },
      ]);
      expect(probed.sort()).toEqual([session.kiloSessionId, siblingSession.kiloSessionId]);
      expect(bootstrapped).toBe(true);
    } finally {
      release.resolve();
      await Promise.allSettled([first, sibling]);
    }
  });

  it('cancels a queued attach promptly without removing the active directory preparation barrier', async () => {
    const started = Promise.withResolvers<AbortSignal>();
    const queued = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const firstAbort = new AbortController();
    const siblingAbort = new AbortController();
    const commands: string[] = [];
    let markerWrites = 0;
    let firstSettled = false;
    const deps: ApplyAttachDeps = {
      kiloRuntimes: fakeKiloRuntimes(),
      ...noFs,
      mkdir: async () => {},
      sessionExists: async () => true,
      writeBootstrapMarker: async () => {
        markerWrites++;
      },
      emitPreparing: event => {
        if (event.action === 'attempt_started' && event.attemptId === 'sibling') queued.resolve();
      },
      runSetup: async (command, _directory, _env, _output, signal) => {
        commands.push(command);
        if (command === 'first') {
          if (!signal) throw new Error('Missing attach signal');
          started.resolve(signal);
          await release.promise;
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    };
    const first = applySessionAttach(
      session,
      { kilo, setupCommands: ['first'] },
      { ...deps, signal: firstAbort.signal }
    ).then(result => {
      firstSettled = true;
      return result;
    });
    const signal = await started.promise;
    const sibling = applySessionAttach(
      siblingSession,
      {
        kilo,
        setupCommands: ['sibling'],
        preparation: { attemptId: 'sibling', triggerMessageId: 'sibling' },
      },
      { ...deps, signal: siblingAbort.signal }
    );
    const attaches = [first, sibling];
    try {
      await queued.promise;
      siblingAbort.abort();
      expect(
        await withTimeoutAndAbort(sibling, {
          timeoutMs: 1_000,
          timeoutMessage: 'Queued attach waited for active preparation',
          abortMessage: 'Test cancelled',
        })
      ).toMatchObject({ ok: false });
      expect(signal.aborted).toBe(false);
      const next = applySessionAttach(
        { ...siblingSession, sessionId: 'workspace_3', kiloSessionId: 'kilo_3' },
        { kilo, setupCommands: ['next'] },
        deps
      );
      attaches.push(next);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(commands).toEqual(['first']);
      firstAbort.abort();
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(signal.aborted).toBe(true);
      expect(firstSettled).toBe(false);
      expect(commands).toEqual(['first']);
      release.resolve();
      expect(await first).toMatchObject({ ok: false });
      expect(await next).toEqual({ ok: true, result: { attached: true } });
      expect(commands).toEqual(['first', 'next']);
      expect(markerWrites).toBe(1);
    } finally {
      release.resolve();
      await Promise.allSettled(attaches);
    }
  });

  it('waits for abort-ignoring preparation before deletion after promptly cancelling a queued attach', async () => {
    const started = Promise.withResolvers<AbortSignal>();
    const queued = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const activeAbort = new AbortController();
    const queuedAbort = new AbortController();
    const waitingQueued = Promise.withResolvers<void>();
    const directory = path.join(homeRoot, 'deleting-worktree');
    const activeSession = { ...session, directory };
    const queuedSession = { ...siblingSession, directory };
    const otherSession = {
      sessionId: 'workspace_other',
      kiloSessionId: 'kilo_other',
      directory: path.join(homeRoot, 'other-worktree'),
    };
    const commands: string[] = [];
    const markers: string[] = [];
    const cleanup: string[] = [];
    let activeSettled = false;
    const deps: ApplyAttachDeps = {
      kiloRuntimes: fakeKiloRuntimes(),
      ...noFs,
      mkdir: async cwd => {
        fs.mkdirSync(cwd, { recursive: true });
      },
      sessionExists: async () => true,
      writeBootstrapMarker: async cwd => {
        markers.push(cwd);
      },
      emitPreparing: event => {
        if (event.action !== 'attempt_started') return;
        if (event.attemptId === 'queued') queued.resolve();
        if (event.attemptId === 'waiting') waitingQueued.resolve();
      },
      runSetup: async (command, cwd, _env, _output, signal) => {
        commands.push(command);
        if (command === 'active') {
          if (!signal) throw new Error('Missing preparation signal');
          started.resolve(signal);
          await release.promise;
          fs.writeFileSync(path.join(cwd, 'late-preparation'), 'finished');
          cleanup.push('preparation-finished');
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    };
    const active = applySessionAttach(
      activeSession,
      { kilo, setupCommands: ['active'] },
      { ...deps, signal: activeAbort.signal }
    ).then(result => {
      activeSettled = true;
      return result;
    });
    const signal = await started.promise;
    const sibling = applySessionAttach(
      queuedSession,
      {
        kilo,
        setupCommands: ['cancelled-queued'],
        preparation: { attemptId: 'queued', triggerMessageId: 'queued' },
      },
      { ...deps, signal: queuedAbort.signal }
    );
    let deletion: Promise<void> | undefined;
    let waiting: ReturnType<typeof applySessionAttach> | undefined;
    try {
      await queued.promise;
      queuedAbort.abort();
      expect(
        await withTimeoutAndAbort(sibling, {
          timeoutMs: 1_000,
          timeoutMessage: 'Queued cancellation waited for active preparation',
          abortMessage: 'Test cancelled',
        })
      ).toMatchObject({ ok: false });
      expect(signal.aborted).toBe(false);
      waiting = applySessionAttach(
        { ...activeSession, sessionId: 'workspace_waiting', kiloSessionId: 'kilo_waiting' },
        {
          kilo,
          setupCommands: ['waiting'],
          preparation: { attemptId: 'waiting', triggerMessageId: 'waiting' },
        },
        deps
      );
      await waitingQueued.promise;
      activeAbort.abort();
      expect(signal.aborted).toBe(true);
      deletion = fenceDirectoryOperations(directory).then(() => {
        cleanup.push('deletion-started');
        fs.rmSync(directory, { recursive: true, force: true });
      });
      expect(
        await withTimeoutAndAbort(
          applySessionAttach(
            otherSession,
            {
              kilo: { ...kilo, scopeId: 'other-worktree' },
              setupCommands: ['other'],
            },
            deps
          ),
          {
            timeoutMs: 1_000,
            timeoutMessage: 'Other worktree preparation was blocked',
            abortMessage: 'Test cancelled',
          }
        )
      ).toEqual({ ok: true, result: { attached: true } });
      await withTimeoutAndAbort(fenceDirectoryOperations(otherSession.directory), {
        timeoutMs: 1_000,
        timeoutMessage: 'Other directory fence waited for unrelated preparation',
        abortMessage: 'Test cancelled',
      });
      expect(activeSettled).toBe(false);
      expect(cleanup).toEqual([]);
      expect(fs.existsSync(directory)).toBe(true);
      expect(commands).toEqual(['active', 'other']);
      expect(
        await applySessionAttach(queuedSession, { kilo, setupCommands: ['after-fence'] }, deps)
      ).toMatchObject({ ok: false });
      release.resolve();
      expect(await active).toMatchObject({ ok: false });
      expect(await waiting).toMatchObject({ ok: false });
      await deletion;
      expect(cleanup).toEqual(['preparation-finished', 'deletion-started']);
      expect(fs.existsSync(directory)).toBe(false);
      expect(commands).toEqual(['active', 'other']);
      expect(markers).toEqual([otherSession.directory]);
    } finally {
      release.resolve();
      await Promise.allSettled([active, sibling, waiting, deletion]);
    }
  });

  it('runs setup commands and emits preparing steps', async () => {
    const setupCalls: Array<{ command: string; env?: Record<string, string> }> = [];
    const events: PreparingEventDataV2[] = [];
    const result = await applySessionAttach(
      session,
      {
        kilo,
        git: { url: 'https://github.com/acme/demo.git' },
        setupCommands: ['pnpm install'],
        env: { FOO: 'bar' },
        preparation: { attemptId: 'att_1', triggerMessageId: 'msg_1' },
      },
      {
        kiloRuntimes: fakeKiloRuntimes(),
        ...noFs,
        sessionExists: async () => true,
        mkdir: async () => undefined,
        hasGit: async () => false,
        runGit: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
        runSetup: async (command, _directory, env) => {
          setupCalls.push(env ? { command, env } : { command });
          return { stdout: '', stderr: '', exitCode: 0 };
        },
        emitPreparing: event => {
          events.push(event);
        },
      }
    );
    expect(result.ok).toBe(true);
    expect(setupCalls).toMatchObject([
      { command: 'pnpm install', env: { FOO: 'bar', KILOCODE_TOKEN: kilo.token } },
    ]);
    expect(events[0]).toMatchObject({
      action: 'attempt_started',
      attemptId: 'att_1',
      triggerMessageId: 'msg_1',
    });
    expect(events.some(event => event.action === 'step_started' && event.step === 'cloning')).toBe(
      true
    );
    expect(
      events.some(
        event =>
          event.action === 'step_started' &&
          event.step === 'setup_commands' &&
          'command' in event &&
          event.command === 'pnpm install'
      )
    ).toBe(true);
  });

  it('redacts injected auth/config tokens and split setup output before emitting any preparation fields', async () => {
    const env = {
      KILO_AUTH_CONTENT: JSON.stringify({ kilo: { type: 'api', key: 'fake-auth-sentinel-123' } }),
      KILO_CONFIG_CONTENT: JSON.stringify({
        provider: { kilo: { options: { apiKey: 'fake-config-sentinel-456' } } },
      }),
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        provider: {
          kilo: { options: { headers: { Authorization: 'Bearer fake-header-sentinel-789' } } },
        },
      }),
    };
    const events: PreparingEventDataV2[] = [];
    const dump = `${Object.entries(env)
      .map(([name, value]) => `${name}=${value}`)
      .join('\n')}\nextracted: fake-config-sentinel-456\ninstalled packages\n`;
    const result = await applySessionAttach(
      session,
      {
        kilo,
        env,
        setupCommands: ['env; printf fake-config-sentinel-456'],
        preparation: { attemptId: 'attempt_1', triggerMessageId: 'msg_1' },
      },
      {
        ...noFs,
        kiloRuntimes: fakeKiloRuntimes(),
        sessionExists: async () => true,
        mkdir: async () => {},
        emitPreparing: event => events.push(event),
        runSetup: async (_command, _directory, _env, onOutput) => {
          for (let offset = 0; offset < dump.length; offset += 7) {
            onOutput?.('stdout', dump.slice(offset, offset + 7));
            if (offset === 0) onOutput?.('stderr', 'warning fake-auth-');
          }
          onOutput?.('stderr', 'sentinel-123\n');
          return { stdout: dump, stderr: '', exitCode: 0 };
        },
      }
    );
    expect(result).toMatchObject({ ok: true });
    const serialized = JSON.stringify(events);
    for (const token of [
      'fake-auth-sentinel-123',
      'fake-config-sentinel-456',
      'fake-header-sentinel-789',
    ])
      expect(serialized).not.toContain(token);
    expect(serialized).toContain('[REDACTED]');
    expect(serialized).toContain('installed packages');
    expect(events.every(event => sessionPreparingPayloadSchema.safeParse(event).success)).toBe(
      true
    );
  });

  it('fails attach when a setup command fails', async () => {
    const result = await applySessionAttach(
      session,
      { kilo, setupCommands: ['false'] },
      {
        kiloRuntimes: fakeKiloRuntimes(),
        ...noFs,
        sessionExists: async () => true,
        mkdir: async () => undefined,
        runSetup: async () => ({ stdout: '', stderr: 'nope', exitCode: 1 }),
      }
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('not_ready');
      expect(result.error.message).toContain('Setup command 1 failed');
    }
  });

  it('attaches when Kilo does not yet have the minted session', async () => {
    const ensured: string[] = [];
    const result = await applySessionAttach(
      session,
      { kilo },
      {
        sessionExists: async () => false,
        kiloRuntimes: fakeKiloRuntimes({
          ensureSession: async (sessionId, directory) => {
            ensured.push(`${sessionId}:${directory}`);
          },
        }),
        restoreSession: async () => ({
          ok: false,
          error: 'snapshot not found (404)',
          code: 404,
          step: 'download',
        }),
        ...noFs,
      }
    );
    expect(result).toEqual({ ok: true, result: { attached: true } });
    expect(ensured).toEqual(['kilo_1:/workspace/a']);
  });

  it('imports snapshot when Kilo is missing the session', async () => {
    let ensured = false;
    let restoredId: string | undefined;
    const result = await applySessionAttach(
      session,
      { kilo },
      {
        kiloRuntimes: fakeKiloRuntimes({
          ensureSession: async () => {
            ensured = true;
          },
        }),
        sessionExists: async () => false,
        restoreSession: async kiloSessionId => {
          restoredId = kiloSessionId;
          return {
            ok: true,
            downloaded: true,
            imported: true,
            diffs: { applied: 0, skipped: 0, total: 0 },
          };
        },
        ...noFs,
      }
    );
    expect(result).toEqual({ ok: true, result: { attached: true } });
    expect(restoredId).toBe(session.kiloSessionId);
    expect(ensured).toBe(false);
  });

  it('creates an empty shell when snapshot is 404', async () => {
    const ensured: Array<[string, string]> = [];
    const result = await applySessionAttach(
      session,
      { kilo },
      {
        kiloRuntimes: fakeKiloRuntimes({
          ensureSession: async (sessionId, directory) => {
            ensured.push([sessionId, directory]);
          },
        }),
        sessionExists: async () => false,
        restoreSession: async () => ({
          ok: false,
          error: 'snapshot not found (404)',
          code: 404,
          step: 'download',
        }),
        ...noFs,
      }
    );
    expect(result).toEqual({ ok: true, result: { attached: true } });
    expect(ensured).toEqual([[session.kiloSessionId, session.directory]]);
  });

  it('creates an empty shell for an explicitly identified empty session export', async () => {
    const ensured: Array<[string, string]> = [];
    const result = await applySessionAttach(
      session,
      { kilo },
      {
        kiloRuntimes: fakeKiloRuntimes({
          ensureSession: async (sessionId, directory) => {
            ensured.push([sessionId, directory]);
          },
        }),
        sessionExists: async () => false,
        restoreSession: async () => ({
          ok: false,
          error:
            'snapshot missing info.id (42 bytes); session-ingest may have returned an error body',
          code: null,
          step: 'download',
          emptySnapshot: true,
        }),
        ...noFs,
      }
    );

    expect(result).toEqual({ ok: true, result: { attached: true } });
    expect(ensured).toEqual([[session.kiloSessionId, session.directory]]);
  });

  it('fails attach when snapshot metadata is missing without an empty-export marker', async () => {
    let ensured = false;
    const result = await applySessionAttach(
      session,
      { kilo },
      {
        kiloRuntimes: fakeKiloRuntimes({
          ensureSession: async () => {
            ensured = true;
          },
        }),
        sessionExists: async () => false,
        restoreSession: async () => ({
          ok: false,
          error:
            'snapshot missing info.id (42 bytes); session-ingest may have returned an error body',
          code: null,
          step: 'download',
        }),
        ...noFs,
      }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not_ready');
    expect(ensured).toBe(false);
  });

  it('fails attach when restore fails with a non-404', async () => {
    let ensured = false;
    const result = await applySessionAttach(
      session,
      { kilo },
      {
        kiloRuntimes: fakeKiloRuntimes({
          ensureSession: async () => {
            ensured = true;
          },
        }),
        sessionExists: async () => false,
        restoreSession: async () => ({
          ok: false,
          error: 'download failed',
          code: 502,
          step: 'download',
        }),
        ...noFs,
      }
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not_ready');
    expect(ensured).toBe(false);
  });

  it('does not restore when Kilo already has the session', async () => {
    let restored = false;
    let ensured = false;
    const result = await applySessionAttach(
      session,
      { kilo },
      {
        kiloRuntimes: fakeKiloRuntimes({
          ensureSession: async () => {
            ensured = true;
          },
        }),
        sessionExists: async () => true,
        restoreSession: async () => {
          restored = true;
          return {
            ok: true,
            downloaded: true,
            imported: true,
            diffs: { applied: 0, skipped: 0, total: 0 },
          };
        },
        ...noFs,
      }
    );
    expect(result).toEqual({ ok: true, result: { attached: true } });
    expect(restored).toBe(false);
    expect(ensured).toBe(false);
  });

  it.each([true, false])(
    'seeds the authoritative root before session lookup (exists=%s)',
    async exists => {
      const runtimes = fakeKiloRuntimes();
      const snapshotIdentity = 'snapshot_other';
      const steps: string[] = [];
      const assertRegistration = () => {
        const runtime = runtimes.get(session);
        if (!runtime) throw new Error('Expected worktree runtime');
        const storage = path.join(runtime.env.XDG_DATA_HOME, 'kilo', 'storage', 'session_share');
        expect(
          JSON.parse(fs.readFileSync(path.join(storage, `${session.kiloSessionId}.json`), 'utf8'))
        ).toEqual({
          id: session.kiloSessionId,
          ingestPath: `/api/session/${session.kiloSessionId}/ingest`,
        });
        expect(fs.existsSync(path.join(storage, `${snapshotIdentity}.json`))).toBe(false);
      };
      const result = await applySessionAttach(
        session,
        { kilo, snapshotIdentity },
        {
          ...noFs,
          kiloRuntimes: runtimes,
          sessionExists: async id => {
            expect(id).toBe(snapshotIdentity);
            assertRegistration();
            steps.push('probe');
            return exists;
          },
          restoreSession: async id => {
            expect(id).toBe(snapshotIdentity);
            assertRegistration();
            steps.push('restore');
            return {
              ok: true,
              downloaded: true,
              imported: true,
              diffs: { applied: 0, skipped: 0, total: 0 },
            };
          },
        }
      );
      expect(result).toEqual({ ok: true, result: { attached: true } });
      expect(steps).toEqual(exists ? ['probe'] : ['probe', 'restore']);
    }
  );

  it('routes sibling restore events to the pending root before committing its attachment', async () => {
    const directory = path.join(homeRoot, 'shared');
    const first = { ...session, directory };
    const sibling = { ...siblingSession, directory };
    const runtimes = isolatedKiloRuntimes();
    expect(
      await applySessionAttach(first, { kilo }, { ...noFs, kiloRuntimes: runtimes })
    ).toMatchObject({ ok: true });
    const observed: Array<string | undefined> = [];
    const result = await applySessionAttach(
      sibling,
      { kilo },
      {
        ...noFs,
        kiloRuntimes: runtimes,
        sessionExists: async () => false,
        restoreSession: async (id, directory) => {
          observed.push(rootForSession(id, directory));
          rememberChildSession({ childId: 'child_sibling', parentId: id, directory });
          return {
            ok: true,
            downloaded: true,
            imported: true,
            diffs: { applied: 0, skipped: 0, total: 0 },
          };
        },
      }
    );
    expect(result).toMatchObject({ ok: true });
    expect(observed).toEqual([sibling.kiloSessionId]);
    expect(rootForSession('child_sibling')).toBe(sibling.kiloSessionId);
    expect(rootForSession(first.kiloSessionId)).toBe(first.kiloSessionId);
    expect(rootForSession(sibling.kiloSessionId)).toBe(sibling.kiloSessionId);
  });

  it('retires a failed sibling attachment without removing a committed sibling or its runtime', async () => {
    const directory = path.join(homeRoot, 'shared');
    const first = { ...session, directory };
    const sibling = { ...siblingSession, directory };
    const runtimes = isolatedKiloRuntimes();
    const deps = { ...noFs, kiloRuntimes: runtimes };
    expect(await applySessionAttach(first, { kilo }, deps)).toMatchObject({ ok: true });
    const runtime = runtimes.get(first);
    const failed = await applySessionAttach(
      sibling,
      { kilo },
      {
        ...deps,
        sessionExists: async () => false,
        restoreSession: async () => ({
          ok: false,
          error: 'download failed',
          code: 502,
          step: 'download',
        }),
      }
    );
    expect(failed).toMatchObject({ ok: false });
    expect(rootForSession(sibling.kiloSessionId)).toBeUndefined();
    expect(rootForSession(first.kiloSessionId)).toBe(first.kiloSessionId);
    expect(runtimes.get(first)).toBe(runtime);
    expect(runtime?.signal.aborted).toBe(false);
    expect(runtimes.detach(sibling)).toBe(false);
    expect(await applySessionAttach(sibling, { kilo }, deps)).toMatchObject({ ok: true });
  });

  it('preserves a committed root and its children when reattachment restoration fails', async () => {
    const identity = { ...session, directory: path.join(homeRoot, 'shared') };
    const runtimes = isolatedKiloRuntimes();
    const deps = { ...noFs, kiloRuntimes: runtimes };
    expect(await applySessionAttach(identity, { kilo }, deps)).toMatchObject({ ok: true });
    rememberChildSession({ childId: 'child_existing', parentId: identity.kiloSessionId });
    const runtime = runtimes.get(identity);
    expect(
      await applySessionAttach(
        identity,
        { kilo },
        {
          ...deps,
          sessionExists: async () => false,
          restoreSession: async () => ({
            ok: false,
            error: 'download failed',
            code: 502,
            step: 'download',
          }),
        }
      )
    ).toMatchObject({ ok: false });
    expect(rootForSession(identity.kiloSessionId)).toBe(identity.kiloSessionId);
    expect(rootForSession('child_existing')).toBe(identity.kiloSessionId);
    expect(runtimes.get(identity)).toBe(runtime);
    expect(runtime?.signal.aborted).toBe(false);
  });

  it('retires a cancelled pending root without coupling a sibling identity to its grant', async () => {
    const directory = path.join(homeRoot, 'shared');
    const identity = { ...session, directory };
    const sibling = { ...siblingSession, directory };
    const runtimes = isolatedKiloRuntimes();
    const restoring = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const controller = new AbortController();
    const grant = { ...kilo, targets: { ...kilo.targets } };
    const attaching = applySessionAttach(
      identity,
      { kilo: grant, runtimeIsolation: 'per-session' },
      {
        ...noFs,
        kiloRuntimes: runtimes,
        signal: controller.signal,
        sessionExists: async () => false,
        restoreSession: async () => {
          restoring.resolve();
          await release.promise;
          return {
            ok: true,
            downloaded: true,
            imported: true,
            diffs: { applied: 0, skipped: 0, total: 0 },
          };
        },
      }
    );
    try {
      await restoring.promise;
      const runtime = runtimes.get(identity);
      grant.token = 'mutated-guest';
      grant.targets.sessionIngestBaseUrl = 'https://other.example.test';
      const deps = { ...noFs, kiloRuntimes: runtimes };
      expect(
        await applySessionAttach(sibling, { kilo: grant, runtimeIsolation: 'per-session' }, deps)
      ).toMatchObject({ ok: true });
      const siblingRuntime = runtimes.get(sibling);
      expect(siblingRuntime).toBeDefined();
      expect(siblingRuntime).not.toBe(runtime);
      const storage = path.join(
        runtime?.env.XDG_DATA_HOME ?? '',
        'kilo',
        'storage',
        'session_share'
      );
      for (const id of [identity.kiloSessionId]) {
        expect(JSON.parse(fs.readFileSync(path.join(storage, `${id}.json`), 'utf8'))).toEqual({
          id,
          ingestPath: `/api/session/${id}/ingest`,
        });
      }
      controller.abort();
      release.resolve();
      expect(await attaching).toMatchObject({ ok: false });
      expect(runtimes.detach(identity)).toBe(false);
      expect(rootForSession(identity.kiloSessionId)).toBeUndefined();
      expect(rootForSession(sibling.kiloSessionId)).toBe(sibling.kiloSessionId);
      expect(runtimes.get(sibling)).toBe(siblingRuntime);
      expect(siblingRuntime?.env.KILOCODE_TOKEN).toBe('mutated-guest');
      expect(siblingRuntime?.env.KILO_SESSION_INGEST_URL).toBe('https://other.example.test');
      expect(siblingRuntime?.signal.aborted).toBe(false);
      expect(runtimes.detach(sibling)).toBe(true);
      expect(siblingRuntime?.signal.aborted).toBe(true);
    } finally {
      release.resolve();
      await attaching;
    }
  });

  it('uses snapshotIdentity when present', async () => {
    const ids: string[] = [];
    const result = await applySessionAttach(
      session,
      { kilo, snapshotIdentity: 'ses_other' },
      {
        kiloRuntimes: fakeKiloRuntimes(),
        sessionExists: async kiloSessionId => {
          ids.push(kiloSessionId);
          return false;
        },
        restoreSession: async kiloSessionId => {
          ids.push(kiloSessionId);
          return {
            ok: true,
            downloaded: true,
            imported: true,
            diffs: { applied: 0, skipped: 0, total: 0 },
          };
        },
        ...noFs,
      }
    );
    expect(result).toEqual({ ok: true, result: { attached: true } });
    expect(ids).toEqual(['ses_other', 'ses_other']);
  });

  it('bounds a genuinely hanging session probe without restoring or creating an empty session', async () => {
    const timers = spyOn(globalThis, 'setTimeout');
    const probing = Promise.withResolvers<void>();
    let probeSignal: AbortSignal | undefined;
    let restored = false;
    let ensured = false;
    try {
      const attaching = applySessionAttach(
        session,
        { kilo },
        {
          ...noFs,
          kiloRuntimes: fakeKiloRuntimes({
            ensureSession: async () => {
              ensured = true;
            },
          }),
          sessionExists: (_id, directory, signal) => {
            expect(directory).toBe(session.directory);
            probeSignal = signal;
            probing.resolve();
            return new Promise<boolean>(() => {});
          },
          restoreSession: async () => {
            restored = true;
            return { ok: false, step: 'download', code: 404, error: 'not found' };
          },
        }
      );
      await probing.promise;
      const deadline = timers.mock.calls.find(
        ([, ms]) => ms === KILO_CONTROL_REQUEST_TIMEOUT_MS
      )?.[0];
      if (typeof deadline !== 'function') throw new Error('missing bounded session probe deadline');
      deadline();
      expect(await attaching).toMatchObject({ ok: false, error: { code: 'not_ready' } });
      expect(probeSignal?.aborted).toBe(true);
      expect(restored).toBe(false);
      expect(ensured).toBe(false);
    } finally {
      timers.mockRestore();
    }
  });

  it('does not turn HTTP 500 from the directory-scoped session probe into a restore attempt', async () => {
    const requests: string[] = [];
    const runtimes = fakeKiloRuntimes();
    // Pre-attach to create the runtime so defaultSessionExists can find kiloClient.serverUrl
    runtimes.attach(session, kilo, {});
    const runtime = runtimes.get(session);
    if (!runtime) throw new Error('Expected runtime');
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        requests.push(request.url);
        return new Response('failure', { status: 500 });
      },
    });
    let restored = false;
    try {
      const result = await applySessionAttach(
        session,
        { kilo },
        {
          ...noFs,
          kiloRuntimes: fakeKiloRuntimes({
            serverUrl: server.url.toString(),
          } as Partial<WrapperKiloClient>),
          restoreSession: async () => {
            restored = true;
            return { ok: false, step: 'download', code: 404, error: 'not found' };
          },
        }
      );
      expect(result).toMatchObject({ ok: false });
      expect(restored).toBe(false);
      const request = new URL(requests[0] ?? '');
      expect(request.pathname).toBe('/session/kilo_1');
      expect(request.searchParams.get('directory')).toBe(session.directory);
    } finally {
      await server.stop(true);
    }
  });

  it('cancels a restore subprocess at its phase barrier and never starts session creation', async () => {
    const controller = new AbortController();
    const importing = Promise.withResolvers<void>();
    let quiesced = false;
    let ensured = false;
    let restoreSignal: AbortSignal | undefined;
    const attaching = applySessionAttach(
      session,
      { kilo },
      {
        ...noFs,
        signal: controller.signal,
        kiloRuntimes: fakeKiloRuntimes({
          ensureSession: async () => {
            ensured = true;
          },
        }),
        sessionExists: async () => false,
        restoreSession: async (_id, _directory, _file, options) => {
          restoreSignal = options?.signal;
          expect(restoreSignal).toBeInstanceOf(AbortSignal);
          expect(restoreSignal?.aborted).toBe(false);
          await runProcess(
            process.execPath,
            ['-e', 'process.stdout.write("importing"); setInterval(() => {}, 1000)'],
            {
              signal: options?.signal,
              onOutput: (_stream, output) => {
                if (output.includes('importing')) importing.resolve();
              },
            }
          );
          quiesced = true;
          return { ok: false, step: 'download', code: 404, error: 'not found' };
        },
      }
    );
    await importing.promise;
    controller.abort();
    expect(restoreSignal?.aborted).toBe(true);
    expect(await attaching).toMatchObject({ ok: false });
    expect(quiesced).toBe(true);
    expect(ensured).toBe(false);
  });

  it('cancels clone before checkout, setup, or a bootstrap marker can run', async () => {
    const controller = new AbortController();
    const cloning = Promise.withResolvers<void>();
    const calls: string[] = [];
    let quiesced = false;
    let cloneSignal: AbortSignal | undefined;
    const attaching = applySessionAttach(
      session,
      {
        kilo,
        git: { url: 'https://github.com/acme/demo.git' },
        branch: 'branch',
        setupCommands: ['setup'],
      },
      {
        kiloRuntimes: fakeKiloRuntimes(),
        signal: controller.signal,
        hasBootstrapMarker: async () => false,
        hasGit: async () => false,
        mkdir: async () => {},
        writeBootstrapMarker: async () => {
          calls.push('marker');
        },
        runSetup: async () => {
          calls.push('setup');
          return { exitCode: 0, stdout: '', stderr: '' };
        },
        runGit: async (args, _cwd, signal) => {
          calls.push(args[0] ?? '');
          cloneSignal = signal;
          expect(cloneSignal).toBeInstanceOf(AbortSignal);
          expect(cloneSignal?.aborted).toBe(false);
          const result = await runProcess(
            process.execPath,
            ['-e', 'process.stdout.write("cloning"); setInterval(() => {}, 1000)'],
            {
              signal,
              onOutput: (_stream, output) => {
                if (output.includes('cloning')) cloning.resolve();
              },
            }
          );
          quiesced = true;
          return result;
        },
      }
    );
    await cloning.promise;
    controller.abort();
    expect(cloneSignal?.aborted).toBe(true);
    expect(await attaching).toMatchObject({ ok: false });
    expect(quiesced).toBe(true);
    expect(calls).toEqual(['clone']);
  });

  it('returns protocol_error for invalid payload', async () => {
    const result = await applySessionAttach(
      session,
      { kilo, git: { url: 1 } },
      { kiloRuntimes: fakeKiloRuntimes(), ...noFs }
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('protocol_error');
  });

  it('requires an explicit auth context before any credential-bearing work', async () => {
    const sideEffects: string[] = [];
    const runtimes = fakeKiloRuntimes();
    const result = await applySessionAttach(
      session,
      {
        env: { KILOCODE_TOKEN: 'actual-managed-token' },
        git: { url: 'https://github.com/acme/demo.git' },
        setupCommands: ['pnpm install'],
      },
      {
        kiloRuntimes: {
          ...runtimes,
          attach: (...args) => {
            sideEffects.push('runtime');
            return runtimes.attach(...args);
          },
        },
        hasBootstrapMarker: async () => {
          sideEffects.push('filesystem');
          return false;
        },
        runSetup: async () => {
          sideEffects.push('setup');
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      }
    );

    expect(result).toEqual({
      ok: false,
      error: { code: 'protocol_error', message: 'Kilo auth context is required', retryable: false },
    });
    expect(sideEffects).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('actual-managed-token');
  });

  it('starts the worktree runtime before setup and restores with that exact environment', async () => {
    const steps: string[] = [];
    const runtimes = fakeKiloRuntimes();
    const environment = { FOO: 'bar', KILOCODE_TOKEN: 'actual-managed-token' };
    const attachment = runtimes.attach(session, kilo, environment);
    const runtime = await attachment.ready;
    let setupSignal: AbortSignal | undefined;
    const result = await applySessionAttach(
      session,
      { kilo, env: environment, setupCommands: ['prepare'] },
      {
        ...noFs,
        kiloRuntimes: {
          ...runtimes,
          attach: (identity, auth, env) => {
            expect(identity).toEqual(session);
            expect(auth).toEqual(kilo);
            expect(env).toEqual(environment);
            steps.push('runtime');
            return attachment;
          },
        },
        mkdir: async () => {
          steps.push('mkdir');
        },
        runSetup: async (_command, directory, env, _onOutput, signal) => {
          expect(directory).toBe(session.directory);
          expect(env).toBe(runtime.env);
          setupSignal = signal;
          expect(signal).toBeInstanceOf(AbortSignal);
          expect(signal?.aborted).toBe(false);
          steps.push('setup');
          return { stdout: '', stderr: '', exitCode: 0 };
        },
        sessionExists: async () => false,
        restoreSession: async (id, directory, _file, options) => {
          expect(id).toBe(session.kiloSessionId);
          expect(directory).toBe(session.directory);
          expect(options?.env).toBe(runtime.env);
          expect(options?.signal).toBe(setupSignal);
          steps.push('restore');
          return {
            ok: true,
            downloaded: true,
            imported: true,
            diffs: { applied: 0, skipped: 0, total: 0 },
          };
        },
      }
    );

    expect(result).toEqual({ ok: true, result: { attached: true } });
    expect(steps).toEqual(['runtime', 'mkdir', 'setup', 'restore']);
  });

  it('runs real setup with Bitbucket metadata and opaque auth without inheriting control credentials', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-setup-test-'));
    const runtimes = fakeKiloRuntimes();
    const saved = {
      KILOCODE_TOKEN: process.env.KILOCODE_TOKEN,
      SANDBOX_CONTROL_CREDENTIAL: process.env.SANDBOX_CONTROL_CREDENTIAL,
      WRAPPER_ONLY_SETUP_VALUE: process.env.WRAPPER_ONLY_SETUP_VALUE,
    };
    try {
      process.env.KILOCODE_TOKEN = 'actual-managed-token';
      process.env.SANDBOX_CONTROL_CREDENTIAL = 'actual-control-credential';
      process.env.WRAPPER_ONLY_SETUP_VALUE = 'wrapper-only-value';
      const result = await applySessionAttach(
        { ...session, directory },
        {
          kilo,
          env: {
            PATH: process.env.PATH ?? '',
            KILOCODE_TOKEN: 'actual-attachment-token',
            BITBUCKET_TOKEN: 'opaque-bitbucket-token',
            KILO_BITBUCKET_WORKSPACE_SLUG: 'acme-workspace',
            KILO_BITBUCKET_REPOSITORY_SLUG: 'widgets',
            KILO_BITBUCKET_WORKSPACE_UUID: '{33333333-3333-4333-8333-333333333333}',
            KILO_BITBUCKET_REPOSITORY_UUID: '{11111111-1111-4111-8111-111111111111}',
          },
          setupCommands: [
            'printf "%s\\n" "$HOME" "$KILOCODE_TOKEN" "${SANDBOX_CONTROL_CREDENTIAL-absent}" "${WRAPPER_ONLY_SETUP_VALUE-absent}" "$BITBUCKET_TOKEN" "$KILO_BITBUCKET_WORKSPACE_SLUG" "$KILO_BITBUCKET_REPOSITORY_SLUG" "$KILO_BITBUCKET_WORKSPACE_UUID" "$KILO_BITBUCKET_REPOSITORY_UUID" > setup-env.txt',
          ],
        },
        { ...noFs, kiloRuntimes: runtimes, sessionExists: async () => true }
      );
      expect(result).toEqual({ ok: true, result: { attached: true } });
      const home = runtimes.get({ ...session, directory })?.env.HOME;
      expect(home).toStartWith(homeRoot);
      expect(fs.readFileSync(path.join(directory, 'setup-env.txt'), 'utf8')).toBe(
        `${home}\n${kilo.token}\nabsent\nabsent\nopaque-bitbucket-token\nacme-workspace\nwidgets\n{33333333-3333-4333-8333-333333333333}\n{11111111-1111-4111-8111-111111111111}\n`
      );
      expect(process.env.KILOCODE_TOKEN).toBe('actual-managed-token');
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('fails closed on runtime identity conflicts before workspace preparation', async () => {
    let prepared = false;
    const result = await applySessionAttach(
      session,
      { kilo, setupCommands: ['prepare'] },
      {
        kiloRuntimes: {
          ...fakeKiloRuntimes(),
          attach: () => {
            throw new WorktreeKiloRuntimeError(
              'unauthorized',
              'Kilo worktree auth context mismatch',
              false
            );
          },
        },
        hasBootstrapMarker: async () => {
          prepared = true;
          return false;
        },
      }
    );

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'unauthorized',
        message: 'Kilo worktree auth context mismatch',
        retryable: false,
      },
    });
    expect(prepared).toBe(false);
  });

  it('rejects directory overrides and rebinding an existing root to another worktree', async () => {
    const deps: ApplyAttachDeps = { kiloRuntimes: fakeKiloRuntimes(), ...noFs };
    expect(
      await applySessionAttach(session, { kilo, directory: '/workspace/other' }, deps)
    ).toEqual({
      ok: false,
      error: { code: 'protocol_error', message: 'Attachment directory mismatch', retryable: false },
    });
    rememberAttachedRoot(session.kiloSessionId, '/workspace/other');
    expect(await applySessionAttach(session, { kilo }, deps)).toEqual({
      ok: false,
      error: { code: 'unauthorized', message: 'Session directory mismatch', retryable: false },
    });
  });

  for (const key of CONTROL_RUNTIME_RESERVED_ENV_VARS) {
    it(`rejects ${key} before preparation, filesystem, or subprocess side effects`, async () => {
      const sideEffects: string[] = [];
      const sensitiveValue = 'must-not-appear-in-error';
      const result = await applySessionAttach(
        session,
        {
          env: { [key]: sensitiveValue },
          git: { url: 'https://github.com/acme/demo.git' },
          setupCommands: ['pnpm install'],
          preparation: { attemptId: 'att_1', triggerMessageId: 'msg_1' },
        },
        {
          kiloRuntimes: fakeKiloRuntimes(),
          hasBootstrapMarker: async () => {
            sideEffects.push('bootstrap');
            return false;
          },
          mkdir: async () => {
            sideEffects.push('mkdir');
          },
          runGit: async () => {
            sideEffects.push('git');
            return { stdout: '', stderr: '', exitCode: 0 };
          },
          runSetup: async () => {
            sideEffects.push('setup');
            return { stdout: '', stderr: '', exitCode: 0 };
          },
          emitPreparing: () => {
            sideEffects.push('preparing');
          },
        }
      );

      expect(result).toEqual({
        ok: false,
        error: {
          code: 'protocol_error',
          message: 'Reserved control runtime environment variable',
          retryable: false,
        },
      });
      expect(sideEffects).toEqual([]);
      expect(JSON.stringify(result)).not.toContain(sensitiveValue);
    });
  }
});
