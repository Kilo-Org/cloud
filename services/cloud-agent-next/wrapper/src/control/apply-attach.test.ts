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
  WorktreeKiloRuntimeError,
  type WorktreeKiloAuth,
  type WorktreeKiloRuntime,
  type WorktreeKiloRuntimes,
} from './worktree-runtime';
import { rememberAttachedRoot, resetSessionDirectoryState } from './session-directories';

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

let homeRoot: string;

function fakeKiloRuntimes(overrides: Partial<WrapperKiloClient> = {}): WorktreeKiloRuntimes {
  const kiloClient = {
    getSession: async (id: string) => ({ id }),
    ensureSession: async () => undefined,
    ...overrides,
  } as WrapperKiloClient;
  const runtimes = new Map<string, WorktreeKiloRuntime>();
  return {
    attach(identity, auth, environment) {
      const { directory } = identity;
      let runtime = runtimes.get(directory);
      if (!runtime) {
        runtime = {
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
        runtimes.set(directory, runtime);
      }
      return {
        ready: Promise.resolve(runtime),
        signal: runtime.signal,
        commit: () => {},
        release: () => {},
      };
    },
    detach: () => true,
    get: directory => runtimes.get(directory),
    isHealthy: () => true,
    shutdown: () => {},
  };
}

beforeEach(() => {
  resetSessionDirectoryState();
  homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-attach-test-'));
});

afterEach(() => {
  fs.rmSync(homeRoot, { recursive: true, force: true });
});

const noFs = {
  hasBootstrapMarker: async () => false,
  writeBootstrapMarker: async () => undefined,
};

describe('applySessionAttach', () => {
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

  it('skips clone and setup when the bootstrap marker is present', async () => {
    const gitCalls: string[][] = [];
    const setupCalls: string[] = [];
    const result = await applySessionAttach(
      session,
      {
        kilo,
        git: { url: 'https://github.com/acme/demo.git' },
        setupCommands: ['pnpm install'],
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

  it('serializes sibling cold clone/setup but allows their Kilo restores to run independently', async () => {
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
      branch: 'main',
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
      expect(gitOperations).toEqual(['clone', 'checkout', 'config', 'config']);
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
  });

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
        const runtime = runtimes.get(session.directory);
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
    const runtime = runtimes.get(session.directory);
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
      const home = runtimes.get(directory)?.env.HOME;
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
