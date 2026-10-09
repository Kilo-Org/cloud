import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { profileConfigPath } from './runtime-profile.js';
import { describe, expect, it, spyOn } from 'bun:test';
import {
  CONTROL_PLANE_TIMERS,
  type ControlPlaneTimers,
} from '../../../src/shared/control-plane-timers.js';
import type {
  ControlPlaneRouteSpec,
  ControlPlaneSessionCredentialsPayload,
  ControlPlaneWrapperFrame,
} from '../../../src/shared/control-plane-protocol.js';
import { controlPlaneWrapperFrameSchema } from '../../../src/shared/control-plane-protocol.js';
import type { ControlDiagnosticFields } from '../../../src/shared/control-diagnostics.js';
import type { WrapperKiloClient } from '../kilo-api.js';
import type { ExecResult, ProcessOptions, ProcessOutputStream } from '../utils.js';
import * as processUtils from '../utils.js';
import { createPreparationManager, type PrepareRuntimePort } from './prepare.js';
import {
  SNAPSHOT_MAX_GENERATION,
  SNAPSHOT_REFRESH_AFTER_MS,
  type WorkspaceStamp,
} from './workspace-stamp.js';

const NOW = 1_800_000_000_000;
import { KiloWorktreeMcpMismatchError } from './kilo-runtime.js';
import type { restoreWorktreeRecovery } from './worktree-recovery.js';
import { restoreSession } from '../restore-session.js';

describe('replacement workspace local recovery', () => {
  const recovery = {
    files: [{ path: 'lost.txt', status: 'added' as const, patch: 'saved patch' }],
  };

  it('recovers a new clone with no ingest diffs before reporting ready', async () => {
    let calls = 0;
    const harness = createHarness(FAST_TIMERS, {
      recoverWorktree: async (_directory, saved) => {
        expect(saved).toEqual(recovery);
        expect(harness.frames.some(frame => frame.type === 'session.ready')).toBe(false);
        calls++;
        return { applied: 1, skipped: 0, total: 1, skippedDiffs: [] };
      },
    });
    harness.setSessionExists(false);
    await harness.manager.prepare(
      routeSpec({ git: { url: 'https://github.com/acme/repo.git' }, worktreeRecovery: recovery })
    );
    expect(calls).toBe(1);
    expect(harness.frames.some(frame => frame.type === 'session.ready')).toBe(true);
  });

  it.each(['surviving', 'ingest', 'existing_session'])(
    'restores local patches for replacement workspaces with %s state only',
    async kind => {
      let calls = 0;
      const harness = createHarness(FAST_TIMERS, {
        hasGit: kind === 'surviving',
        recoverWorktree: async () => {
          calls++;
          return { applied: 1, skipped: 0, total: 1, skippedDiffs: [] };
        },
      });
      harness.setSessionExists(kind === 'existing_session');
      if (kind === 'ingest')
        harness.setRestore(async () => ({
          ok: true,
          downloaded: true,
          imported: true,
          diffs: { applied: 1, skipped: 0, total: 1 },
        }));
      await harness.manager.prepare(
        routeSpec({ git: { url: 'https://github.com/acme/repo.git' }, worktreeRecovery: recovery })
      );
      expect(calls).toBe(kind === 'surviving' ? 0 : 1);
      if (kind === 'ingest') expect(harness.restoreOptions()[0]?.restoreFiles).toBe(false);
      if (kind === 'surviving') expect(harness.restoreOptions()[0]?.restoreFiles).toBe(true);
      expect(harness.frames.some(frame => frame.type === 'session.ready')).toBe(true);
    }
  );

  it('imports nonempty ingest history but recovers the newer local file before snapshot upload', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prepare-local-precedence-'));
    const directory = path.join(root, 'workspace');
    const imported = path.join(root, 'imported.json');
    const bin = path.join(root, 'bin');
    const snapshot = {
      info: { id: routeSpec().kiloSessionId, version: '2' },
      messages: [],
      sessionDiff: [{ file: 'lost.txt', status: 'modified', after: 'older ingest\n' }],
    };
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(snapshot), { status: 200 })
    );
    try {
      await fs.mkdir(directory);
      await fs.mkdir(bin);
      expect(Bun.spawnSync(['git', 'init', directory]).exitCode).toBe(0);
      await fs.writeFile(path.join(directory, 'lost.txt'), 'base\n');
      await fs.writeFile(path.join(bin, 'kilo'), `#!/bin/sh\ncp "$2" "${imported}"\n`, {
        mode: 0o755,
      });
      const newer = {
        files: [
          {
            path: 'lost.txt',
            status: 'modified' as const,
            patch:
              'diff --git a/lost.txt b/lost.txt\n--- a/lost.txt\n+++ b/lost.txt\n@@ -1 +1 @@\n-base\n+newer local\n',
          },
        ],
      };
      const harness = createHarness(FAST_TIMERS, {
        capture: true,
        beforeCapture: async () => {
          expect(await fs.readFile(path.join(directory, 'lost.txt'), 'utf8')).toBe('newer local\n');
          expect(harness.ensureCalls()).toBe(0);
        },
      });
      harness.setSessionExists(false);
      harness.setRestore(async () =>
        restoreSession(routeSpec().kiloSessionId, directory, undefined, {
          restoreFiles: harness.restoreOptions()[0]?.restoreFiles !== false,
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            KILO_SESSION_INGEST_URL: 'https://ingest.test',
            KILOCODE_TOKEN: 'test-token',
          },
        })
      );
      await harness.manager.prepare(
        routeSpec({
          directory,
          git: { url: 'https://github.com/acme/repo.git' },
          capture: true,
          worktreeRecovery: newer,
        })
      );
      expect(await fs.readFile(path.join(directory, 'lost.txt'), 'utf8')).toBe('newer local\n');
      expect(harness.captureRequests).toHaveLength(1);
      expect(JSON.parse(await fs.readFile(imported, 'utf8')).sessionDiff).toEqual(
        snapshot.sessionDiff
      );
      expect(harness.frames.some(frame => frame.type === 'session.ready')).toBe(true);
    } finally {
      fetchSpy.mockRestore();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('does not fail preparation when local recovery fails', async () => {
    const harness = createHarness(FAST_TIMERS, {
      recoverWorktree: async () => {
        throw new Error('conflicting patch');
      },
    });
    harness.setSessionExists(false);
    await harness.manager.prepare(
      routeSpec({ git: { url: 'https://github.com/acme/repo.git' }, worktreeRecovery: recovery })
    );
    expect(harness.frames.some(frame => frame.type === 'session.ready')).toBe(true);
    expect(harness.logs.some(line => line.includes('failed; continuing'))).toBe(true);
  });

  it('reports skipped files without failing session readiness', async () => {
    const harness = createHarness(FAST_TIMERS, {
      recoverWorktree: async () => ({
        applied: 0,
        skipped: 1,
        total: 1,
        skippedDiffs: [{ file: 'lost.txt', reason: 'patch_apply_failed' }],
      }),
    });
    harness.setSessionExists(false);
    await harness.manager.prepare(
      routeSpec({ git: { url: 'https://github.com/acme/repo.git' }, worktreeRecovery: recovery })
    );
    expect(
      harness.logs.some(line => line.includes('restore incomplete') && line.includes('lost.txt'))
    ).toBe(true);
    expect(
      harness.frames.some(
        frame => frame.type === 'session.progress' && frame.detail?.includes('incomplete')
      )
    ).toBe(true);
    expect(harness.frames.some(frame => frame.type === 'session.ready')).toBe(true);
    expect(harness.frames.some(frame => frame.type === 'session.failed')).toBe(false);
  });
});

function timers(overrides: Partial<ControlPlaneTimers['wrapper']> = {}): ControlPlaneTimers {
  return {
    ...CONTROL_PLANE_TIMERS,
    wrapper: { ...CONTROL_PLANE_TIMERS.wrapper, ...overrides },
  };
}

const FAST_TIMERS = timers({ cloneMs: 2_000, kiloRuntimeStartMs: 2_000, kiloSessionMs: 2_000 });
const TIMEOUT_TIMERS = timers({ cloneMs: 30, kiloRuntimeStartMs: 30, kiloSessionMs: 30 });

function result(exitCode: number, stderr = ''): ExecResult {
  return { stdout: '', stderr, exitCode };
}

function routeSpec(overrides: Partial<ControlPlaneRouteSpec> = {}): ControlPlaneRouteSpec {
  return {
    sessionId: 'ses_00000000000000000000000000',
    kiloSessionId: 'ses_11111111111111111111111111',
    attemptId: 'attempt-1',
    directory: '/tmp/prepare-test-worktree',
    env: {},
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

type EnsureInput = { key: string; directory: string; env: Record<string, string> };

type Harness = {
  manager: ReturnType<typeof createPreparationManager>;
  frames: ControlPlaneWrapperFrame[];
  logs: string[];
  nativeDiagnostics: Array<{ event: string; fields: ControlDiagnosticFields }>;
  gitCalls: string[][];
  authorCalls: Array<{ name: string; email: string } | undefined>;
  ensureCalls: () => number;
  ensureInputs: EnsureInput[];
  installCalls: Array<{ key: string; env: Record<string, string> }>;
  releaseCalls: string[];
  removeCalls: string[];
  ensureSessionCalls: () => number;
  cloneParallelism: () => number;
  setClone: (value: ExecResult | (() => Promise<ExecResult>)) => void;
  setGit: (
    value: (args: string[], options?: ProcessOptions) => ExecResult | Promise<ExecResult>
  ) => void;
  setSessionExists: (value: boolean) => void;
  setSessionExistsHung: (value: boolean) => void;
  setRestore: (value: () => Promise<unknown>) => void;
  restoreCalls: () => number;
  restoreOptions: () => Array<Record<string, unknown> | undefined>;
  setEnsureRejects: (value: boolean) => void;
  setEnsureError: (value: unknown) => void;
  setEnsureHung: (value: boolean) => void;
  setUnavailable: (key: string, value: boolean) => void;
  setStamp: (value: WorkspaceStamp | null) => void;
  stamp: () => WorkspaceStamp | null;
  setHasGit: (value: boolean) => void;
  emptyCalls: string[];
  clearedHomes: string[];
  truncations: () => number;
  captureRequests: Array<{ sessionId: string; commit: string | undefined; timeoutMs: number }>;
  setCaptureResult: (value: boolean | 'throw') => void;
  setSetupResult: (value: ExecResult) => void;
  setSetupOutput: (
    value: (onOutput: (stream: ProcessOutputStream, output: string) => void) => void
  ) => void;
};

function createHarness(
  activeTimers: ControlPlaneTimers = FAST_TIMERS,
  options: {
    hasGit?: boolean;
    capture?: boolean;
    beforeEnsure?: () => Promise<void>;
    homeRoot?: string;
    beforeInstall?: () => Promise<void>;
    recoverWorktree?: typeof restoreWorktreeRecovery;
    beforeCapture?: () => Promise<void>;
  } = {}
): Harness {
  const frames: ControlPlaneWrapperFrame[] = [];
  const logs: string[] = [];
  const nativeDiagnostics: Array<{ event: string; fields: ControlDiagnosticFields }> = [];
  const gitCalls: string[][] = [];
  const authorCalls: Array<{ name: string; email: string } | undefined> = [];
  const ensureInputs: EnsureInput[] = [];
  const installCalls: Array<{ key: string; env: Record<string, string> }> = [];
  const releaseCalls: string[] = [];
  const removeCalls: string[] = [];
  let clone: ExecResult | (() => Promise<ExecResult>) = result(0);
  let customGit:
    | ((args: string[], options?: ProcessOptions) => ExecResult | Promise<ExecResult>)
    | undefined;
  let sessionExists = true;
  let sessionExistsHung = false;
  let restore = async (): Promise<unknown> => ({
    ok: false,
    code: 404,
    error: 'not found',
    step: 'download',
  });
  const restoreArgs: Array<Record<string, unknown> | undefined> = [];
  let ensureRejects = false;
  let ensureError: unknown;
  let ensureHung = false;
  let ensureCalls = 0;
  let ensureSessionCalls = 0;
  let setupResult = result(0);
  let setupOutput:
    | ((onOutput: (stream: ProcessOutputStream, output: string) => void) => void)
    | undefined;
  let stamp: WorkspaceStamp | null = null;
  let hasGitState = options.hasGit ?? false;
  const emptyCalls: string[] = [];
  const clearedHomes: string[] = [];
  let truncations = 0;
  const captureRequests: Harness['captureRequests'] = [];
  let captureResult: boolean | 'throw' = true;
  const unavailableKeys = new Set<string>();
  let activeClones = 0;
  let maxActiveClones = 0;

  const runtimes: PrepareRuntimePort = {
    ensure: async input => {
      ensureCalls += 1;
      ensureInputs.push({ key: input.key, directory: input.directory, env: input.env });
      await options.beforeEnsure?.();
      if (ensureHung) return new Promise<WrapperKiloClient>(() => undefined);
      if (ensureError !== undefined) throw ensureError;
      if (ensureRejects) throw new Error('kilo server failed to start');
      return {
        serverUrl: 'http://127.0.0.1:1',
        ensureSession: async () => {
          ensureSessionCalls += 1;
        },
      } as unknown as WrapperKiloClient;
    },
    installCredentials: async (key, env) => {
      installCalls.push({ key, env });
      await options.beforeInstall?.();
    },
    isUnavailable: key => unavailableKeys.has(key),
    remove: key => {
      removeCalls.push(key);
    },
    release: key => {
      releaseCalls.push(key);
    },
  };

  const manager = createPreparationManager({
    timers: activeTimers,
    emit: frame => frames.push(frame),
    log: message => logs.push(message),
    onNativeDiagnostic: (event, fields) => nativeDiagnostics.push({ event, fields }),
    runtimes,
    inheritedEnv: {},
    homeRoot: options.homeRoot ?? '/tmp/prepare-test-homes',
    allocationId: 'alloc-current',
    now: () => NOW,
    ...(options.capture
      ? {
          capture: {
            request: async (sessionId: string, commit: string | undefined, timeoutMs: number) => {
              await options.beforeCapture?.();
              captureRequests.push({ sessionId, commit, timeoutMs });
              if (captureResult === 'throw') throw new Error('capture channel failed');
              return captureResult;
            },
          },
        }
      : {}),
    hasGit: async () => hasGitState,
    readStamp: async () => stamp,
    writeStamp: async (_directory, value) => {
      stamp = value;
    },
    emptyDirectory: async directory => {
      emptyCalls.push(directory);
      hasGitState = false;
      stamp = null;
    },
    clearStaleHomes: async (_root, keep) => {
      clearedHomes.push(keep);
    },
    truncateLog: async () => {
      truncations += 1;
    },
    mkdir: async () => undefined,
    configureGitAuthor: async (_directory, _runGit, author) => {
      authorCalls.push(author);
    },
    runGit: async (args, options) => {
      gitCalls.push(args);
      if (customGit) return customGit(args, options);
      if (args[0] === 'clone') {
        hasGitState = true;
        activeClones += 1;
        maxActiveClones = Math.max(maxActiveClones, activeClones);
        try {
          return typeof clone === 'function' ? await clone() : clone;
        } finally {
          activeClones -= 1;
        }
      }
      return result(0);
    },
    runSetup: async (_command, _directory, _env, onOutput) => {
      setupOutput?.(onOutput ?? (() => undefined));
      return setupResult;
    },
    restore: (async (...args: unknown[]) => {
      restoreArgs.push(args[3] as Record<string, unknown> | undefined);
      return restore();
    }) as never,
    seedRegistration: async () => undefined,
    recoverWorktree: options.recoverWorktree,
    sessionExists: async () => {
      if (sessionExistsHung) return new Promise<boolean>(() => undefined);
      return sessionExists;
    },
    sleep: async () => undefined,
  });

  return {
    manager,
    frames,
    logs,
    nativeDiagnostics,
    gitCalls,
    authorCalls,
    ensureCalls: () => ensureCalls,
    ensureInputs,
    installCalls,
    releaseCalls,
    removeCalls,
    ensureSessionCalls: () => ensureSessionCalls,
    cloneParallelism: () => maxActiveClones,
    setClone: value => {
      clone = value;
    },
    setGit: value => {
      customGit = value;
    },
    setSessionExists: value => {
      sessionExists = value;
      sessionExistsHung = false;
    },
    setSessionExistsHung: value => {
      sessionExistsHung = value;
    },
    setRestore: value => {
      restore = value;
    },
    restoreCalls: () => restoreArgs.length,
    restoreOptions: () => restoreArgs,
    setEnsureRejects: value => {
      ensureRejects = value;
    },
    setEnsureError: value => {
      ensureError = value;
    },
    setEnsureHung: value => {
      ensureHung = value;
    },
    setUnavailable: (key, value) => {
      if (value) unavailableKeys.add(key);
      else unavailableKeys.delete(key);
    },
    setStamp: value => {
      stamp = value;
    },
    stamp: () => stamp,
    setHasGit: value => {
      hasGitState = value;
    },
    emptyCalls,
    clearedHomes,
    truncations: () => truncations,
    captureRequests,
    setCaptureResult: value => {
      captureResult = value;
    },
    setSetupResult: value => {
      setupResult = value;
    },
    setSetupOutput: value => {
      setupOutput = value;
    },
  };
}

function progressSteps(frames: ControlPlaneWrapperFrame[]): string[] {
  return frames
    .filter(
      (frame): frame is Extract<ControlPlaneWrapperFrame, { type: 'session.progress' }> =>
        frame.type === 'session.progress'
    )
    .map(frame => frame.step);
}

function lastFrame(frames: ControlPlaneWrapperFrame[]): ControlPlaneWrapperFrame | undefined {
  return frames.at(-1);
}

describe('createPreparationManager', () => {
  it('starts a fresh preparation requested before the released owner finishes', async () => {
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const harness = createHarness(FAST_TIMERS, {
      beforeEnsure: async () => {
        entered.resolve();
        await resume.promise;
      },
    });
    const spec = routeSpec({ runtimeIsolation: 'per-session' });
    const running = harness.manager.prepare(spec);
    await entered.promise;
    harness.manager.release(spec.sessionId);
    const next = harness.manager.prepare({ ...spec, attemptId: 'attempt-2' });
    resume.resolve();
    await Promise.all([running, next]);
    expect(harness.ensureCalls()).toBe(2);
    expect(harness.releaseCalls).toEqual([spec.sessionId]);
    expect(harness.manager.isPrepared(spec.sessionId)).toBe(true);
    expect(harness.frames.filter(frame => frame.type === 'session.ready')).toEqual([
      { type: 'session.ready', sessionId: spec.sessionId },
    ]);
  });

  it('can release a fresh preparation waiting for the previous owner to finish', async () => {
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const harness = createHarness(FAST_TIMERS, {
      beforeEnsure: async () => {
        entered.resolve();
        await resume.promise;
      },
    });
    const spec = routeSpec({ runtimeIsolation: 'per-session' });
    const running = harness.manager.prepare(spec);
    await entered.promise;
    harness.manager.release(spec.sessionId);
    const next = harness.manager.prepare({ ...spec, attemptId: 'attempt-2' });
    harness.manager.release(spec.sessionId);
    resume.resolve();
    await Promise.all([running, next]);
    expect(harness.ensureCalls()).toBe(1);
    expect(harness.manager.isPrepared(spec.sessionId)).toBe(false);
    expect(harness.manager.isPreparing()).toBe(false);
    expect(harness.frames.some(frame => frame.type === 'session.ready')).toBe(false);
  });

  it('invalidates an in-flight runtime preparation without releasing a shared sibling runtime', async () => {
    for (const runtimeIsolation of ['per-session', undefined] as const) {
      const entered = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const harness = createHarness(FAST_TIMERS, {
        beforeEnsure: async () => {
          entered.resolve();
          await resume.promise;
        },
      });
      const spec = routeSpec({ runtimeIsolation });
      const running = harness.manager.prepare(spec);
      await entered.promise;
      harness.manager.release(spec.sessionId);
      resume.resolve();
      await running;
      expect(harness.manager.isPrepared(spec.sessionId)).toBe(false);
      expect(
        harness.frames.some(
          frame => frame.type === 'session.ready' || frame.type === 'session.failed'
        )
      ).toBe(false);
      expect(harness.releaseCalls).toEqual(
        runtimeIsolation === 'per-session' ? [spec.sessionId] : []
      );
      expect(harness.removeCalls).toEqual([]);
      await harness.manager.prepare(spec);
      expect(harness.manager.isPrepared(spec.sessionId)).toBe(true);
    }
  });

  it('materializes MCP servers into the runtime env and redacts them from setup output', async () => {
    const secret = 'mcp-secret-header-value';
    const harness = createHarness();
    harness.setSetupOutput(onOutput => onOutput('stdout', `leaked ${secret}\n`));
    const spec = routeSpec({
      runtimeIsolation: 'per-session',
      setupCommands: ['echo hi'],
      mcp: {
        github: {
          type: 'remote',
          url: 'https://mcp.example.com/github',
          headers: { 'X-Neutral-Header': secret },
        },
      },
    });

    await harness.manager.prepare(spec);

    const runtimeEnv = harness.ensureInputs[0]?.env;
    expect(runtimeEnv).toBeDefined();
    const config = JSON.parse(runtimeEnv!.KILO_CONFIG_CONTENT ?? '{}') as {
      mcp?: Record<string, unknown>;
    };
    expect(config.mcp).toEqual(spec.mcp);
    // The materialized header value is a live secret: setup output must not leak it.
    expect(JSON.stringify(harness.frames)).not.toContain(secret);
    const setupOutput = harness.frames.find(
      frame =>
        frame.type === 'session.events' &&
        frame.events.some(event => event.type === 'session.setup.output')
    );
    expect(setupOutput).toBeDefined();
  });

  it('fails a per-session route without retrying when the warm runtime MCP config drifted', async () => {
    const harness = createHarness();
    harness.setEnsureError(new KiloWorktreeMcpMismatchError());
    const spec = routeSpec({ runtimeIsolation: 'per-session' });

    await harness.manager.prepare(spec);

    expect(harness.ensureCalls()).toBe(1);
    expect(harness.manager.isPrepared(spec.sessionId)).toBe(false);
    const failed = harness.frames.find(frame => frame.type === 'session.failed');
    expect(failed).toBeDefined();
  });

  it('suppresses failed and runtime retries after release during a rejected startup', async () => {
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const harness = createHarness(FAST_TIMERS, {
      beforeEnsure: async () => {
        entered.resolve();
        await resume.promise;
        throw new Error('startup failed');
      },
    });
    const spec = routeSpec({ runtimeIsolation: 'per-session' });
    const running = harness.manager.prepare(spec);
    await entered.promise;
    harness.manager.release(spec.sessionId);
    resume.resolve();
    await running;
    expect(harness.ensureCalls()).toBe(1);
    expect(harness.removeCalls).toEqual([]);
    expect(harness.releaseCalls).toEqual([spec.sessionId]);
    expect(
      harness.frames.some(
        frame => frame.type === 'session.failed' || frame.type === 'session.ready'
      )
    ).toBe(false);
  });

  it('suppresses ready after release while warm re-prepare awaits credential installation', async () => {
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const harness = createHarness(FAST_TIMERS, {
      beforeInstall: async () => {
        entered.resolve();
        await resume.promise;
      },
    });
    const spec = routeSpec({ runtimeIsolation: 'per-session' });
    await harness.manager.prepare(spec);
    harness.frames.length = 0;
    const running = harness.manager.prepare(spec, {
      sessionId: spec.sessionId,
      kilo: { token: 'fresh' },
    });
    await entered.promise;
    harness.manager.release(spec.sessionId);
    resume.resolve();
    await running;
    expect(harness.frames).toEqual([]);
    expect(harness.manager.isPrepared(spec.sessionId)).toBe(false);
    expect(harness.releaseCalls).toEqual([spec.sessionId]);
  });

  it('does not start a runtime after release during workspace preparation', async () => {
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<ExecResult>();
    const harness = createHarness();
    harness.setClone(async () => {
      entered.resolve();
      return resume.promise;
    });
    const spec = routeSpec({
      git: { url: 'https://git.test/repo', token: 'git-token', platform: 'github' },
    });
    const running = harness.manager.prepare(spec);
    await entered.promise;
    harness.manager.release(spec.sessionId);
    resume.resolve(result(0));
    await running;
    expect(harness.ensureCalls()).toBe(0);
    expect(harness.manager.isPrepared(spec.sessionId)).toBe(false);
    expect(
      harness.frames.some(
        frame => frame.type === 'session.ready' || frame.type === 'session.failed'
      )
    ).toBe(false);
  });
  it('runs clone, checkout, runtime and session, emits progress then ready, and is idempotent', async () => {
    const harness = createHarness();
    const spec = routeSpec({ git: { url: 'https://github.com/acme/repo.git', token: 'git-1' } });

    await harness.manager.prepare(spec);

    expect(progressSteps(harness.frames)).toEqual([
      'clone',
      'checkout',
      'kilo_runtime',
      'kilo_session',
    ]);
    expect(lastFrame(harness.frames)).toEqual({
      type: 'session.ready',
      sessionId: spec.sessionId,
      workspace: 'cloned',
    });
    expect(harness.gitCalls.some(args => args[0] === 'clone')).toBe(true);
    expect(harness.gitCalls.some(args => args[0] === 'checkout')).toBe(true);
    expect(harness.manager.isPrepared(spec.sessionId)).toBe(true);

    const before = harness.frames.length;
    await harness.manager.prepare(spec);
    expect(harness.frames.length).toBe(before + 1);
    expect(lastFrame(harness.frames)).toEqual({
      type: 'session.ready',
      sessionId: spec.sessionId,
      workspace: 'same',
    });
    expect(harness.ensureCalls()).toBe(1);
  });

  it('accepts a managed GitHub author in the frame and configures it after checkout', async () => {
    const harness = createHarness();
    const author = { name: 'Managed GitHub Author', email: 'author@example.com' };
    const spec = routeSpec({
      git: {
        url: 'https://github.com/acme/repo.git',
        token: 'managed-alias',
        platform: 'github',
        author,
      },
    });
    const frame = controlPlaneWrapperFrameSchema.parse({ type: 'session.prepare', spec });
    if (frame.type !== 'session.prepare') throw new Error('Wrong frame type');
    await harness.manager.prepare(frame.spec);
    expect(harness.gitCalls).toContainEqual([
      'clone',
      '--progress',
      expect.any(String),
      spec.directory,
    ]);
    expect(lastFrame(harness.frames)).toEqual({
      type: 'session.ready',
      sessionId: spec.sessionId,
      workspace: 'cloned',
    });
    expect(harness.gitCalls.some(args => args[0] === 'checkout')).toBe(true);
    expect(harness.authorCalls).toEqual([author]);
  });

  it('reports live clone progress and clone retries as step details', async () => {
    const harness = createHarness();
    let clones = 0;
    harness.setGit((args, options) => {
      if (args[0] !== 'clone') return result(0);
      clones += 1;
      if (clones === 1) return result(128, 'fatal: unable to access: Could not resolve host');
      options?.onOutput?.('stderr', 'Receiving objects:  45% (450/1000)\r');
      return result(0);
    });
    const spec = routeSpec({ git: { url: 'https://github.com/acme/repo.git', token: 'git-1' } });

    await harness.manager.prepare(spec);

    const details = harness.frames.flatMap(frame =>
      frame.type === 'session.progress' && frame.detail !== undefined
        ? [{ step: frame.step, detail: frame.detail }]
        : []
    );
    expect(details).toEqual([
      { step: 'clone', detail: 'Retrying clone (attempt 2 of 3)' },
      { step: 'clone', detail: 'Cloning repository... Receiving objects: 45%' },
    ]);
    for (const frame of harness.frames) controlPlaneWrapperFrameSchema.parse(frame);
    expect(lastFrame(harness.frames)).toEqual({
      type: 'session.ready',
      sessionId: spec.sessionId,
      workspace: 'cloned',
    });
  });

  it('fails the clone step with the classified git subtype', async () => {
    const harness = createHarness();
    harness.setClone(
      result(128, 'fatal: Authentication failed for https://github.com/acme/repo.git')
    );
    const spec = routeSpec({ git: { url: 'https://github.com/acme/repo.git' } });

    await harness.manager.prepare(spec);

    expect(lastFrame(harness.frames)).toMatchObject({
      type: 'session.failed',
      sessionId: spec.sessionId,
      reason: 'workspace_setup_failed',
      step: 'clone',
      subtype: 'git_authentication_failed',
    });
    expect(harness.manager.isPrepared(spec.sessionId)).toBe(false);
  });

  it('logs bounded git failure provenance on the failure line without changing the frame or retries', async () => {
    const harness = createHarness();
    harness.setClone(
      result(
        128,
        "fatal: unable to access 'https://github.com/acme/repo.git/': The requested URL returned error: 429"
      )
    );
    const spec = routeSpec({
      git: { url: 'https://github.com/acme/repo.git', token: 'managed-alias', platform: 'github' },
    });

    await harness.manager.prepare(spec);

    const failureLog = harness.logs.find(line => line.includes('control-plane prepare failed'));
    expect(failureLog).toContain('matcher=git_rate_limited http=429 operation=clone route=managed');
    expect(failureLog).not.toContain('github.com');
    // Classification, retry count and the wire frame are unchanged.
    expect(harness.gitCalls.filter(args => args[0] === 'clone')).toHaveLength(3);
    expect(lastFrame(harness.frames)).toEqual({
      type: 'session.failed',
      sessionId: spec.sessionId,
      reason: 'workspace_setup_failed',
      step: 'clone',
      subtype: 'git_rate_limited',
    });
  });

  it('fails clone on timeout with the git_clone_timeout subtype', async () => {
    const harness = createHarness(TIMEOUT_TIMERS);
    harness.setClone(() => new Promise<ExecResult>(() => undefined));
    const spec = routeSpec({ git: { url: 'https://github.com/acme/repo.git' } });

    await harness.manager.prepare(spec);

    expect(lastFrame(harness.frames)).toMatchObject({
      type: 'session.failed',
      step: 'clone',
      subtype: 'git_clone_timeout',
    });
  });

  it('checks out a working branch that has no origin ref instead of forcing origin/<branch>', async () => {
    // A real repo: the branch does not exist locally and has no origin ref, so
    // `checkout -B <b> origin/<b>` fails while `checkout -b <b>` succeeds.
    const harness = createHarness();
    harness.setGit(args => {
      if (args[0] === 'show-ref') return result(1);
      if (args[0] === 'checkout' && args.includes('-B')) {
        return result(128, 'fatal: invalid reference: origin/session/scope-1');
      }
      return result(0);
    });
    const spec = routeSpec({
      git: { url: 'https://github.com/acme/repo.git' },
      branch: 'session/scope-1',
      branchMode: 'working',
    });

    await harness.manager.prepare(spec);

    expect(harness.gitCalls).toContainEqual(['checkout', '--progress', '-b', 'session/scope-1']);
    expect(lastFrame(harness.frames)).toEqual({
      type: 'session.ready',
      sessionId: spec.sessionId,
      workspace: 'cloned',
    });
    expect(harness.gitCalls).not.toContainEqual([
      'checkout',
      '--progress',
      '-B',
      'session/scope-1',
      'origin/session/scope-1',
    ]);
  });

  it('tracks a working branch that exists on origin', async () => {
    const harness = createHarness();
    harness.setGit(args => {
      if (args[0] === 'show-ref' && args[3]?.startsWith('refs/heads/')) return result(1);
      if (args[0] === 'show-ref' && args[3]?.startsWith('refs/remotes/')) return result(0);
      return result(0);
    });
    const spec = routeSpec({
      git: { url: 'https://github.com/acme/repo.git' },
      branch: 'feature',
      branchMode: 'working',
    });

    await harness.manager.prepare(spec);

    expect(harness.gitCalls).toContainEqual([
      'checkout',
      '--progress',
      '-b',
      'feature',
      '--track',
      'origin/feature',
    ]);
  });

  it('fetches a synthetic review ref through the review-ref path', async () => {
    const harness = createHarness();
    const spec = routeSpec({
      git: { url: 'https://github.com/acme/repo.git' },
      branch: 'refs/pull/12/head',
    });

    await harness.manager.prepare(spec);

    expect(
      harness.gitCalls.some(args => args[0] === 'fetch' && args[3] === 'refs/pull/12/head')
    ).toBe(true);
  });

  it('reports a checkout failure with the checkout step, not clone', async () => {
    const harness = createHarness();
    harness.setGit(args =>
      args[0] === 'checkout' ? result(128, 'fatal: checkout failed') : result(0)
    );
    const spec = routeSpec({
      git: { url: 'https://github.com/acme/repo.git' },
      branch: 'main',
    });

    await harness.manager.prepare(spec);

    expect(lastFrame(harness.frames)).toMatchObject({ type: 'session.failed', step: 'checkout' });
    const checkoutLine = harness.nativeDiagnostics.find(
      entry =>
        entry.event === 'wrapper.lifecycle' &&
        entry.fields.phase === 'prepare_failed' &&
        entry.fields.preparationStep === 'checkout'
    );
    expect(checkoutLine).toBeDefined();
    expect(checkoutLine?.fields).not.toHaveProperty('detail');
    expect(harness.nativeDiagnostics.some(entry => entry.fields.phase === 'session_ready')).toBe(
      false
    );
  });

  it('reports a Kilo session timeout with the kilo_import_timeout subtype', async () => {
    const harness = createHarness(TIMEOUT_TIMERS);
    harness.setSessionExistsHung(true);
    const spec = routeSpec();

    await harness.manager.prepare(spec);

    expect(lastFrame(harness.frames)).toMatchObject({
      type: 'session.failed',
      step: 'kilo_session',
      subtype: 'kilo_import_timeout',
    });
    // The native owner line carries the closed step and subtype, never the error text.
    expect(harness.nativeDiagnostics).toContainEqual({
      event: 'wrapper.lifecycle',
      fields: {
        phase: 'prepare_failed',
        preparationStep: 'kilo_session',
        subtype: 'kilo_import_timeout',
      },
    });
  });

  it('projects one session_ready line per ready emit, with the session id and no directory', async () => {
    const harness = createHarness();
    const spec = routeSpec();
    await harness.manager.prepare(spec);
    const first = harness.nativeDiagnostics.filter(
      entry => entry.event === 'wrapper.lifecycle' && entry.fields.phase === 'session_ready'
    );
    expect(first).toEqual([
      { event: 'wrapper.lifecycle', fields: { phase: 'session_ready', sessionId: spec.sessionId } },
    ]);
    expect(JSON.stringify(first[0]?.fields)).not.toContain(spec.directory);

    // A re-prepare ready is a new line, not a latched one.
    await harness.manager.prepare({ ...spec, attemptId: 'attempt-2' });
    const ready = harness.nativeDiagnostics.filter(entry => entry.fields.phase === 'session_ready');
    expect(ready).toHaveLength(2);
    expect(harness.nativeDiagnostics.some(entry => entry.fields.phase === 'prepare_failed')).toBe(
      false
    );
  });

  it('reports preparingCount and sessionCount from the owner maps', async () => {
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const harness = createHarness(FAST_TIMERS, {
      beforeEnsure: async () => {
        entered.resolve();
        await resume.promise;
      },
    });
    const spec = routeSpec();
    expect(harness.manager.preparingCount()).toBe(0);
    expect(harness.manager.sessionCount()).toBe(0);

    const running = harness.manager.prepare(spec);
    await entered.promise;
    expect(harness.manager.isPreparing()).toBe(true);
    expect(harness.manager.preparingCount()).toBe(1);
    expect(harness.manager.sessionCount()).toBe(0);

    resume.resolve();
    await running;
    expect(harness.manager.isPreparing()).toBe(false);
    expect(harness.manager.preparingCount()).toBe(0);
    // An idle prepared session still counts.
    expect(harness.manager.isPrepared(spec.sessionId)).toBe(true);
    expect(harness.manager.sessionCount()).toBe(1);

    harness.manager.release(spec.sessionId);
    expect(harness.manager.sessionCount()).toBe(0);
  });

  it('does not publish silent setup command bodies containing inline credentials', async () => {
    const harness = createHarness();
    await harness.manager.prepare(
      routeSpec({
        setupCommands: [
          "npm config set //registry.npmjs.org/:_authToken 'inline-token-canary'",
          'curl -u user:inline-password-canary https://example.com',
        ],
      })
    );

    const started = harness.frames.flatMap(frame =>
      frame.type === 'session.events'
        ? frame.events.filter(event => event.type === 'session.setup.started')
        : []
    );
    expect(started.map(event => event.properties)).toEqual([
      { command: 1, commandCount: 2 },
      { command: 2, commandCount: 2 },
    ]);
    expect(JSON.stringify(harness.frames)).not.toContain('inline-token-canary');
    expect(JSON.stringify(harness.frames)).not.toContain('inline-password-canary');
    expect(lastFrame(harness.frames)).toMatchObject({ type: 'session.ready' });
  });

  it('fails the setup step when a setup command exits non-zero', async () => {
    const harness = createHarness();
    harness.setSetupResult(result(1, 'command failed'));
    const spec = routeSpec({ setupCommands: ['exit 1'] });

    await harness.manager.prepare(spec);

    expect(lastFrame(harness.frames)).toMatchObject({
      type: 'session.failed',
      step: 'setup',
      subtype: 'setup_command_failed',
    });
  });

  it('bounds setup commands with the 5-minute inactivity and 8-minute hard timeout', async () => {
    const runProcess = spyOn(processUtils, 'runProcess').mockImplementation(async () => result(0));
    try {
      const manager = createPreparationManager({
        timers: FAST_TIMERS,
        allocationId: 'allocation-test',
        emit: () => undefined,
        runtimes: {
          ensure: async () =>
            ({
              serverUrl: 'http://127.0.0.1:1',
              ensureSession: async () => undefined,
            }) as unknown as WrapperKiloClient,
          installCredentials: async () => undefined,
          isUnavailable: () => false,
          remove: () => undefined,
          release: () => undefined,
        },
        inheritedEnv: {},
        homeRoot: '/tmp/prepare-test-homes',
        hasGit: async () => false,
        readStamp: async () => null,
        writeStamp: async () => undefined,
        mkdir: async () => undefined,
        configureGitAuthor: async () => undefined,
        seedRegistration: async () => undefined,
        sessionExists: async () => true,
      });

      await manager.prepare(routeSpec({ setupCommands: ['pnpm install'] }));

      expect(runProcess).toHaveBeenCalledWith(
        'sh',
        ['-c', 'pnpm install'],
        expect.objectContaining({
          inactivityTimeoutMs: 300_000,
          hardTimeoutMs: 480_000,
        })
      );
    } finally {
      runProcess.mockRestore();
    }
  });

  it('logs distinct setup failure diagnostics with the configured limits', async () => {
    const cases = [
      { terminationReason: 'hard_timeout', subtype: 'setup_command_timeout', code: 124 },
      { terminationReason: 'inactivity_timeout', subtype: 'setup_command_timeout', code: 124 },
      { terminationReason: 'abort', subtype: 'setup_command_timeout', code: 124 },
      { terminationReason: undefined, subtype: 'setup_command_failed', code: 1 },
    ] as const;

    for (const testCase of cases) {
      const harness = createHarness();
      harness.setSetupResult({
        stdout: 'STDOUT_LEAK_CANARY',
        stderr: 'STDERR_LEAK_CANARY',
        exitCode: testCase.code,
        terminationReason: testCase.terminationReason,
      });

      await harness.manager.prepare(routeSpec({ setupCommands: ['secret-command'] }));

      const failureLog =
        harness.logs.find(line => line.includes('control-plane setup command failed')) ?? '';
      expect(failureLog).toContain(`terminationReason=${testCase.terminationReason ?? 'nonzero'}`);
      expect(failureLog).toContain('attemptId=attempt-1');
      expect(failureLog).toContain('index=1 count=1');
      expect(failureLog).toContain('inactivityTimeoutMs=300000 hardTimeoutMs=480000');
      expect(failureLog).not.toContain('secret-command');
      expect(failureLog).not.toContain('STDOUT_LEAK_CANARY');
      expect(failureLog).not.toContain('STDERR_LEAK_CANARY');
      expect(lastFrame(harness.frames)).toMatchObject({
        type: 'session.failed',
        step: 'setup',
        subtype: testCase.subtype,
      });
    }
  });

  it('creates the Kilo session when the ingest export is missing', async () => {
    const harness = createHarness();
    harness.setSessionExists(false);
    const spec = routeSpec();

    await harness.manager.prepare(spec);

    expect(lastFrame(harness.frames)).toEqual({ type: 'session.ready', sessionId: spec.sessionId });
    // The legacy ingest export is always attempted; a 404 means there is no
    // history to restore, so the route creates the Kilo session.
    expect(harness.restoreCalls()).toBe(1);
    expect(harness.ensureSessionCalls()).toBe(1);
  });

  it('restores from the legacy ingest export when the session is missing', async () => {
    const harness = createHarness();
    harness.setSessionExists(false);
    harness.setRestore(async () => ({
      ok: true,
      downloaded: true,
      imported: true,
      diffs: { applied: 0, skipped: 0, total: 0 },
    }));
    const spec = routeSpec();

    await harness.manager.prepare(spec);

    expect(lastFrame(harness.frames)).toEqual({ type: 'session.ready', sessionId: spec.sessionId });
    expect(harness.ensureSessionCalls()).toBe(0);
    expect(harness.restoreCalls()).toBe(1);
  });

  it('fails the route when the restore fails with a non-404 error', async () => {
    const harness = createHarness();
    harness.setSessionExists(false);
    harness.setRestore(async () => ({
      ok: false,
      code: 502,
      error: 'download failed status=401',
      step: 'download',
      subtype: 'kilo_import_failed',
    }));
    const spec = routeSpec();

    await harness.manager.prepare(spec);

    expect(lastFrame(harness.frames)).toMatchObject({
      type: 'session.failed',
      sessionId: spec.sessionId,
      reason: 'workspace_setup_failed',
      subtype: 'kilo_import_failed',
    });
    expect(harness.ensureSessionCalls()).toBe(0);
  });

  it('creates the Kilo session when the ingest export is an empty snapshot', async () => {
    const harness = createHarness();
    harness.setSessionExists(false);
    harness.setRestore(async () => ({
      ok: false,
      code: null,
      error: 'snapshot not found (404)',
      step: 'download',
      emptySnapshot: true,
    }));
    const spec = routeSpec();

    await harness.manager.prepare(spec);

    expect(lastFrame(harness.frames)).toEqual({ type: 'session.ready', sessionId: spec.sessionId });
    expect(harness.restoreCalls()).toBe(1);
    expect(harness.ensureSessionCalls()).toBe(1);
  });

  it('logs an incomplete restore and completes preparation', async () => {
    const harness = createHarness();
    harness.setSessionExists(false);
    harness.setRestore(async () => ({
      ok: true,
      downloaded: true,
      imported: true,
      diffs: {
        applied: 1,
        skipped: 1,
        total: 2,
        skippedDiffs: [{ file: 'a.ts', reason: 'conflict' }],
      },
    }));
    const spec = routeSpec();

    await harness.manager.prepare(spec);

    expect(harness.logs).toContain(
      `bootstrap restore incomplete kiloSessionId=${spec.kiloSessionId} skipped=1 total=2 reasons=conflict paths=a.ts`
    );
    expect(lastFrame(harness.frames)).toEqual({ type: 'session.ready', sessionId: spec.sessionId });
  });

  it('uses the existing Kilo session without restoring', async () => {
    const harness = createHarness();
    let restoreCalls = 0;
    harness.setRestore(async () => {
      restoreCalls += 1;
      return {
        ok: true,
        downloaded: true,
        imported: true,
        diffs: { applied: 0, skipped: 0, total: 0 },
      };
    });

    await harness.manager.prepare(routeSpec());

    expect(restoreCalls).toBe(0);
    expect(harness.ensureSessionCalls()).toBe(0);
    expect(lastFrame(harness.frames)?.type).toBe('session.ready');
  });

  it('drops the runtime and retries when the Kilo runtime start times out', async () => {
    const harness = createHarness(TIMEOUT_TIMERS);
    harness.setEnsureHung(true);

    await harness.manager.prepare(routeSpec());

    expect(harness.ensureCalls()).toBe(2);
    expect(harness.removeCalls).toContain('/tmp/prepare-test-worktree');
    expect(lastFrame(harness.frames)).toMatchObject({
      type: 'session.failed',
      reason: 'workspace_setup_failed',
      step: 'kilo_runtime',
    });
  });

  it('retries the Kilo runtime start once before failing the step', async () => {
    const harness = createHarness();
    harness.setEnsureRejects(true);

    await harness.manager.prepare(routeSpec());

    expect(harness.ensureCalls()).toBe(2);
    expect(lastFrame(harness.frames)).toMatchObject({
      type: 'session.failed',
      reason: 'workspace_setup_failed',
      step: 'kilo_runtime',
    });
  });

  it('serializes workspace preparation per directory so two sessions clone once', async () => {
    const harness = createHarness();
    const specA = routeSpec({
      sessionId: 'ses_a',
      kiloSessionId: 'kilo_a',
      git: { url: 'https://github.com/acme/repo.git' },
      setupCommands: ['echo hi'],
    });
    const specB = routeSpec({
      sessionId: 'ses_b',
      kiloSessionId: 'kilo_b',
      git: { url: 'https://github.com/acme/repo.git' },
      setupCommands: ['echo hi'],
    });

    await Promise.all([harness.manager.prepare(specA), harness.manager.prepare(specB)]);

    expect(harness.ensureCalls()).toBe(2);
    expect(harness.gitCalls.filter(args => args[0] === 'clone')).toHaveLength(1);
    expect(harness.cloneParallelism()).toBeLessThanOrEqual(1);
    expect(
      harness.frames.some(frame => frame.type === 'session.ready' && frame.sessionId === 'ses_b')
    ).toBe(true);
  });

  it('gives per-session runtimes distinct HOMEs', async () => {
    const harness = createHarness();
    const specA = routeSpec({
      sessionId: 'ses_a',
      kiloSessionId: 'kilo_a',
      runtimeIsolation: 'per-session',
    });
    const specB = routeSpec({
      sessionId: 'ses_b',
      kiloSessionId: 'kilo_b',
      runtimeIsolation: 'per-session',
    });

    await harness.manager.prepare(specA);
    await harness.manager.prepare(specB);

    expect(harness.ensureInputs).toHaveLength(2);
    expect(harness.ensureInputs[0]!.env.HOME).not.toBe(harness.ensureInputs[1]!.env.HOME);
  });

  it('re-prepares a prepared route whose runtime is unavailable', async () => {
    const harness = createHarness();
    const spec = routeSpec();
    await harness.manager.prepare(spec);
    expect(harness.ensureCalls()).toBe(1);

    harness.setUnavailable('/tmp/prepare-test-worktree', true);
    await harness.manager.prepare(spec);

    expect(harness.ensureCalls()).toBe(2);
    expect(lastFrame(harness.frames)).toEqual({ type: 'session.ready', sessionId: spec.sessionId });
  });

  it('applies fresh credentials on a prepared route without re-running preparation', async () => {
    const harness = createHarness();
    const spec = routeSpec({ git: { url: 'https://github.com/acme/repo.git', token: 'git-1' } });
    await harness.manager.prepare(spec);
    harness.gitCalls.length = 0;
    harness.installCalls.length = 0;

    const credentials: ControlPlaneSessionCredentialsPayload = {
      sessionId: spec.sessionId,
      git: { token: 'git-2', platform: 'github' },
      kilo: { token: 'kilo-token-2' },
    };
    await harness.manager.prepare(spec, credentials);

    expect(harness.ensureCalls()).toBe(1);
    const remote = harness.gitCalls.find(args => args[0] === 'remote');
    expect(remote?.[3]).toContain('git-2');
    expect(harness.installCalls).toHaveLength(1);
    expect(harness.installCalls[0]!.env.KILOCODE_TOKEN).toBe('kilo-token-2');
    expect(lastFrame(harness.frames)).toEqual({
      type: 'session.ready',
      sessionId: spec.sessionId,
      workspace: 'same',
    });
  });

  it('installs refreshed Git and Kilo credentials into the running route and runtime', async () => {
    const harness = createHarness();
    const spec = routeSpec({
      git: { url: 'https://github.com/acme/repo.git', token: 'git-1' },
      runtimeIsolation: 'per-session',
    });
    await harness.manager.prepare(spec);
    harness.gitCalls.length = 0;

    const credentials: ControlPlaneSessionCredentialsPayload = {
      sessionId: spec.sessionId,
      git: { token: 'git-2', platform: 'github' },
      kilo: { token: 'kilo-token-2' },
    };
    await harness.manager.installCredentials(credentials);

    const remote = harness.gitCalls.find(args => args[0] === 'remote');
    expect(remote?.[1]).toBe('set-url');
    expect(remote?.[3]).toContain('git-2');
    expect(remote?.[3]).not.toContain('git-1');
    expect(harness.installCalls).toHaveLength(1);
    expect(harness.installCalls[0]!.key).toBe(spec.sessionId);
    expect(harness.installCalls[0]!.env.KILOCODE_TOKEN).toBe('kilo-token-2');

    harness.manager.release(spec.sessionId);
    expect(harness.releaseCalls).toEqual([spec.sessionId]);
    expect(harness.manager.isPrepared(spec.sessionId)).toBe(false);
  });

  it('records refreshed Kilo environment before awaiting Git credential maintenance', async () => {
    const harness = createHarness();
    const spec = routeSpec({ git: { url: 'https://github.com/acme/repo.git', token: 'git-1' } });
    await harness.manager.prepare(spec);
    const gitStarted = Promise.withResolvers<void>();
    const finishGit = Promise.withResolvers<ExecResult>();
    harness.setGit(async () => {
      gitStarted.resolve();
      return finishGit.promise;
    });
    const installing = harness.manager.installCredentials({
      sessionId: spec.sessionId,
      kilo: { token: 'kilo-token-2' },
      git: { token: 'git-2' },
    });
    await gitStarted.promise;
    expect(harness.installCalls[0]?.env.KILOCODE_TOKEN).toBe('kilo-token-2');
    finishGit.resolve(result(0));
    await installing;
  });

  it('prefers the runtime-proxy handle and facade targets over the spec alias', async () => {
    const harness = createHarness();
    const spec = routeSpec();
    await harness.manager.prepare(spec);
    harness.ensureInputs.length = 0;
    harness.installCalls.length = 0;

    const credentials: ControlPlaneSessionCredentialsPayload = {
      sessionId: spec.sessionId,
      kilo: { token: 'kilo-alias-2' },
      proxy: {
        handle: 'proxy-handle-1',
        targets: {
          backendBaseUrl: 'https://facade.test',
          providerBaseUrl: 'https://facade.test',
          sessionIngestBaseUrl: 'https://facade.test',
        },
      },
    };
    await harness.manager.installCredentials(credentials);

    const env = harness.installCalls[0]?.env;
    expect(env?.KILOCODE_TOKEN).toBe('proxy-handle-1');
    expect(env?.KILOCODE_BACKEND_BASE_URL).toBe('https://facade.test');
  });

  it('surfaces setup-command output on the wire', async () => {
    const harness = createHarness();
    const manager = createPreparationManager({
      timers: FAST_TIMERS,
      emit: frame => harness.frames.push(frame),
      runtimes: {
        ensure: async () => ({ serverUrl: 'http://127.0.0.1:1' }) as unknown as WrapperKiloClient,
        installCredentials: async () => undefined,
        isUnavailable: () => false,
        remove: () => undefined,
        release: () => undefined,
      },
      inheritedEnv: {},
      homeRoot: '/tmp/prepare-test-homes',
      allocationId: 'alloc-current',
      hasGit: async () => true,
      readStamp: async () => null,
      writeStamp: async () => undefined,
      mkdir: async () => undefined,
      configureGitAuthor: async () => undefined,
      runGit: async () => result(0),
      runSetup: async (_command, _directory, _env, onOutput) => {
        onOutput?.('stdout', 'installing dependencies\n');
        return result(1);
      },
      restore: (async () => ({
        ok: false,
        code: 404,
        error: 'missing',
        step: 'download',
      })) as never,
      seedRegistration: async () => undefined,
      sessionExists: async () => true,
      sleep: async () => undefined,
    });
    const spec = routeSpec({ setupCommands: ['npm install'] });

    await manager.prepare(spec);

    const events = harness.frames.filter(frame => frame.type === 'session.events');
    const output = events
      .flatMap(frame => (frame.type === 'session.events' ? frame.events : []))
      .find(event => event.type === 'session.setup.output');
    expect(output?.properties.output).toBe('installing dependencies\n');
    expect(lastFrame(harness.frames)).toMatchObject({ type: 'session.failed', step: 'setup' });
  });

  it('separates streamed setup output and normalizes terminal progress like the legacy path', async () => {
    const harness = createHarness();
    harness.setSetupOutput(onOutput => {
      onOutput('stdout', '\u001b[32mProgress: resolved 10\u001b[0m\r\n');
      onOutput('stdout', 'Progress: resolved 15\rProgress: resolved 20\n');
      onOutput('stderr', 'warning: kilo-token-');
      onOutput('stderr', '1\n');
      onOutput('stdout', 'Done');
    });

    await harness.manager.prepare(routeSpec({ setupCommands: ['pnpm install'] }));

    const events = harness.frames.flatMap(frame =>
      frame.type === 'session.events' ? frame.events : []
    );
    const output = events
      .filter(event => event.type === 'session.setup.output')
      .map(event => event.properties.output);
    expect(output).toEqual([
      'Progress: resolved 10\n',
      'Progress: resolved 20\n',
      'warning: [REDACTED]\n',
      'Done\n',
    ]);
    expect(output.join('')).toBe(
      'Progress: resolved 10\nProgress: resolved 20\nwarning: [REDACTED]\nDone\n'
    );
    expect(events.at(-1)).toMatchObject({
      type: 'session.setup.finished',
      properties: { command: 1, exitCode: 0 },
    });
  });

  it('redacts a named non-heuristic secret from setup output', async () => {
    const secret = 'postgres://user:pass@localhost:5432/prod';
    const harness = createHarness();
    const splitAt = Math.floor(secret.length / 2);
    harness.setSetupOutput(onOutput => {
      onOutput('stdout', `connecting ${secret.slice(0, splitAt)}`);
      onOutput('stdout', `${secret.slice(splitAt)}\n`);
      onOutput('stderr', `warning: ${secret}\n`);
    });
    const spec = routeSpec({
      setupCommands: ['pnpm install'],
      env: { DATABASE_URL: secret },
      secretEnvKeys: ['DATABASE_URL'],
    });

    await harness.manager.prepare(spec);

    const outputs = harness.frames
      .flatMap(frame => (frame.type === 'session.events' ? frame.events : []))
      .filter(event => event.type === 'session.setup.output')
      .map(event => event.properties.output);
    expect(outputs).toContain('connecting [REDACTED]\n');
    expect(outputs).toContain('warning: [REDACTED]\n');
    expect(outputs.join('')).not.toContain('localhost');
  });

  describe('managed GitHub invocation options', () => {
    const url = 'https://github.com/acme/repo.git';
    const token = `kcp1.${Buffer.from('synthetic-sandbox').toString('base64url')}.github.${'ab12'.repeat(16)}`;
    const config = [
      '-c',
      'http.https://github.com/.proactiveAuth=basic',
      '-c',
      'http.https://github.com/.followRedirects=false',
    ] as const;

    it.each([url, 'https://github.com:443/acme/repo.git'])(
      'keeps both options on every clone retry for %s',
      async cloneUrl => {
        const harness = createHarness();
        let attempts = 0;
        harness.setGit(args =>
          args.includes('clone') && ++attempts < 3
            ? result(128, 'fatal: unable to access: Connection reset by peer')
            : result(0)
        );
        const spec = routeSpec({
          git: { url: cloneUrl, token, platform: 'github' },
        });
        await harness.manager.prepare(spec);
        const clones = harness.gitCalls.filter(args => args.includes('clone'));
        expect(clones).toHaveLength(3);
        for (const args of clones) expect(args.slice(0, 5)).toEqual([...config, 'clone']);
        expect(harness.gitCalls.filter(args => args[0] === '-c')).toEqual(clones);
        expect(lastFrame(harness.frames)?.type).toBe('session.ready');
      }
    );

    it('scopes both options to cached review-ref fetch, not checkout or credential refresh', async () => {
      const harness = createHarness(FAST_TIMERS, { hasGit: true });
      const spec = routeSpec({
        git: { url, token, platform: 'github' },
        branch: 'refs/pull/12/head',
      });
      await harness.manager.prepare(spec);
      await harness.manager.installCredentials({
        sessionId: spec.sessionId,
        git: { token, platform: 'github' },
        kilo: { token: 'kilo-token-2' },
      });
      const fetch = harness.gitCalls.find(args => args.includes('fetch'));
      expect(fetch?.slice(0, 5)).toEqual([...config, 'fetch']);
      expect(fetch).toContain(spec.branch);
      expect(harness.gitCalls.some(args => args.includes('clone'))).toBe(false);
      expect(harness.gitCalls.some(args => args[0] === 'checkout')).toBe(true);
      expect(harness.gitCalls.some(args => args[0] === 'remote')).toBe(true);
      for (const args of harness.gitCalls.filter(args => args !== fetch)) {
        expect(args).not.toContain(config[1]);
        expect(args).not.toContain(config[3]);
      }
      expect(lastFrame(harness.frames)?.type).toBe('session.ready');
    });

    it.each([
      ['direct token', url, 'ghp-direct', 'github'],
      ['missing token', url, undefined, 'github'],
      ['wrong purpose', url, token.replace('.github.', '.kilo.'), 'github'],
      ['wrong platform', url, token, 'gitlab'],
      ['missing platform', url, token, undefined],
      ['HTTP', 'http://github.com/acme/repo.git', token, 'github'],
      ['other hostname', 'https://github.com.evil.test/acme/repo.git', token, 'github'],
      ['alternate port', 'https://github.com:8443/acme/repo.git', token, 'github'],
    ] as const)(
      'omits both options on clone and fetch for %s',
      async (_name, url, token, platform) => {
        const harness = createHarness();
        await harness.manager.prepare(
          routeSpec({ git: { url, token, platform }, branch: 'refs/pull/12/head' })
        );
        expect(harness.gitCalls.some(args => args[0] === 'clone')).toBe(true);
        expect(harness.gitCalls.some(args => args[0] === 'fetch')).toBe(true);
        for (const args of harness.gitCalls) {
          expect(args).not.toContain(config[1]);
          expect(args).not.toContain(config[3]);
        }
      }
    );
  });
});

const FOREIGN_STAMP = {
  allocationId: 'alloc-previous',
  commit: 'old-commit',
  capturedAt: NOW - 60_000,
  generation: 0,
};
const DUE_STAMP = { ...FOREIGN_STAMP, capturedAt: NOW - SNAPSHOT_REFRESH_AFTER_MS };
const REPO = 'https://github.com/acme/repo.git';

function gitKinds(calls: string[][]): string[] {
  return calls.map(args => args.slice(0, args[0] === 'remote' ? 2 : 1).join(' '));
}

describe('adopting a repository snapshot', () => {
  function adoptHarness(options: { capture?: boolean } = {}) {
    const harness = createHarness(FAST_TIMERS, { hasGit: true, ...options });
    harness.setStamp(FOREIGN_STAMP);
    harness.setGit(args => {
      if (args[0] === 'show-ref') return result(1);
      if (args[0] === 'for-each-ref')
        return { stdout: 'main\nsession/old\n', stderr: '', exitCode: 0 };
      if (args[0] === 'rev-parse') return { stdout: 'new-commit\n', stderr: '', exitCode: 0 };
      return result(0);
    });
    return harness;
  }

  it('reconciles the snapshot with this route instead of cloning, for a new session branch', async () => {
    const harness = adoptHarness();
    const spec = routeSpec({
      git: { url: REPO, token: 'git-1', platform: 'github', author: { name: 'A', email: 'a@b.c' } },
      setupCommands: ['npm install'],
    });

    await harness.manager.prepare(spec);

    expect(harness.gitCalls.some(args => args[0] === 'clone')).toBe(false);
    const setUrl = harness.gitCalls.find(args => args[0] === 'remote' && args[1] === 'set-url');
    expect(setUrl?.[3]).toContain('git-1');
    expect(gitKinds(harness.gitCalls).slice(0, 7)).toEqual([
      'remote set-url',
      'fetch',
      'remote set-head',
      'checkout',
      'for-each-ref',
      'branch',
      'show-ref',
    ]);
    expect(harness.gitCalls).toContainEqual(['fetch', '--prune', 'origin']);
    expect(harness.gitCalls).toContainEqual(['checkout', '--detach', 'origin/HEAD']);
    expect(harness.gitCalls).toContainEqual(['branch', '-D', 'main', 'session/old']);
    expect(harness.gitCalls).toContainEqual(['checkout', '--progress', '-b', 'session/scope-1']);
    expect(harness.authorCalls).toEqual([{ name: 'A', email: 'a@b.c' }]);
    expect(progressSteps(harness.frames)).toEqual([
      'restore',
      'checkout',
      'setup',
      'kilo_runtime',
      'kilo_session',
    ]);
    expect(harness.stamp()).toEqual({
      allocationId: 'alloc-current',
      commit: 'new-commit',
      capturedAt: FOREIGN_STAMP.capturedAt,
      generation: 0,
    });
    expect(lastFrame(harness.frames)).toEqual({
      type: 'session.ready',
      sessionId: spec.sessionId,
      workspace: 'adopted',
    });
    expect(harness.emptyCalls).toEqual([]);
    expect(harness.clearedHomes).toHaveLength(1);
    expect(harness.clearedHomes[0]).toContain('/tmp/prepare-test-homes/');
  });

  it('checks out an explicit branch with the ordinary branch logic', async () => {
    const harness = adoptHarness();
    const spec = routeSpec({ git: { url: REPO }, branch: 'feature/x' });

    await harness.manager.prepare(spec);

    expect(harness.gitCalls).toContainEqual([
      'checkout',
      '--progress',
      '-B',
      'feature/x',
      'origin/feature/x',
    ]);
    expect(lastFrame(harness.frames)).toMatchObject({
      type: 'session.ready',
      workspace: 'adopted',
    });
  });

  it("tracks an existing session's own working branch from origin", async () => {
    const harness = adoptHarness();
    harness.setGit(args => {
      if (args[0] === 'show-ref' && args[3]?.startsWith('refs/heads/')) return result(1);
      if (args[0] === 'show-ref' && args[3]?.startsWith('refs/remotes/')) return result(0);
      if (args[0] === 'for-each-ref') return { stdout: '', stderr: '', exitCode: 0 };
      return result(0);
    });
    const spec = routeSpec({
      git: { url: REPO },
      branch: 'session/scope-1',
      branchMode: 'working',
    });

    await harness.manager.prepare(spec);

    expect(harness.gitCalls).toContainEqual([
      'checkout',
      '--progress',
      '-b',
      'session/scope-1',
      '--track',
      'origin/session/scope-1',
    ]);
    expect(harness.gitCalls.some(args => args[0] === 'branch')).toBe(false);
    expect(lastFrame(harness.frames)).toMatchObject({ workspace: 'adopted' });
  });

  it('fetches a review ref through the review-ref path after the refresh', async () => {
    const harness = adoptHarness();
    const spec = routeSpec({ git: { url: REPO }, branch: 'refs/pull/12/head' });

    await harness.manager.prepare(spec);

    expect(
      harness.gitCalls.some(args => args[0] === 'fetch' && args[3] === 'refs/pull/12/head')
    ).toBe(true);
    expect(lastFrame(harness.frames)).toMatchObject({ workspace: 'adopted' });
  });

  it('runs the setup commands after an adopt and fails the route when one fails', async () => {
    const harness = adoptHarness();
    harness.setSetupResult(result(1, 'install failed'));
    const spec = routeSpec({ git: { url: REPO }, setupCommands: ['npm install'] });

    await harness.manager.prepare(spec);

    expect(lastFrame(harness.frames)).toMatchObject({ type: 'session.failed', step: 'setup' });
    expect(harness.stamp()).toEqual(FOREIGN_STAMP);
  });

  it('falls back to a clone when the fetch fails', async () => {
    const harness = adoptHarness();
    harness.setGit(args => {
      if (args[0] === 'fetch') return result(1, 'fatal: repository not found');
      if (args[0] === 'show-ref') return result(1);
      return result(0);
    });
    const spec = routeSpec({ git: { url: REPO } });

    await harness.manager.prepare(spec);

    expect(harness.emptyCalls).toEqual([spec.directory]);
    expect(harness.gitCalls.filter(args => args[0] === 'clone')).toHaveLength(1);
    expect(progressSteps(harness.frames)).toEqual([
      'restore',
      'clone',
      'checkout',
      'kilo_runtime',
      'kilo_session',
    ]);
    expect(lastFrame(harness.frames)).toMatchObject({ type: 'session.ready', workspace: 'cloned' });
    expect(harness.stamp()?.allocationId).toBe('alloc-current');
  });

  it('retries a network failure of the fetch before it falls back', async () => {
    const harness = adoptHarness();
    let fetches = 0;
    harness.setGit(args => {
      if (args[0] === 'fetch') {
        fetches += 1;
        return fetches < 3 ? result(128, 'fatal: Could not resolve host: github.com') : result(0);
      }
      if (args[0] === 'show-ref') return result(1);
      return result(0);
    });

    await harness.manager.prepare(routeSpec({ git: { url: REPO } }));

    expect(fetches).toBe(3);
    expect(harness.emptyCalls).toEqual([]);
    expect(lastFrame(harness.frames)).toMatchObject({ workspace: 'adopted' });
  });

  it('falls back to a clone when the branch cannot be checked out', async () => {
    const harness = adoptHarness();
    let checkouts = 0;
    harness.setGit(args => {
      if (args[0] === 'checkout' && args.includes('-B')) {
        checkouts += 1;
        return checkouts === 1
          ? result(128, 'error: local changes would be overwritten')
          : result(0);
      }
      return result(0);
    });
    const spec = routeSpec({ git: { url: REPO }, branch: 'feature' });

    await harness.manager.prepare(spec);

    expect(harness.emptyCalls).toEqual([spec.directory]);
    expect(harness.gitCalls.filter(args => args[0] === 'clone')).toHaveLength(1);
    expect(lastFrame(harness.frames)).toMatchObject({ workspace: 'cloned' });
  });

  it('falls back to a clone when the adopt exceeds its budget', async () => {
    const harness = createHarness(timers({ restoreMs: 30, cloneMs: 2_000 }), { hasGit: true });
    harness.setStamp(FOREIGN_STAMP);
    harness.setGit(args => {
      if (args[0] === 'fetch') return new Promise<ExecResult>(() => undefined);
      return result(args[0] === 'show-ref' ? 1 : 0);
    });

    await harness.manager.prepare(routeSpec({ git: { url: REPO } }));

    expect(harness.emptyCalls).toHaveLength(1);
    expect(lastFrame(harness.frames)).toMatchObject({ workspace: 'cloned' });
  });

  it('does nothing for a workspace this allocation already prepared', async () => {
    const harness = createHarness(FAST_TIMERS, { hasGit: true });
    const prepared = {
      allocationId: 'alloc-current',
      commit: 'abc',
      capturedAt: NOW,
      generation: 0,
    };
    harness.setStamp(prepared);
    const spec = routeSpec({ git: { url: REPO }, setupCommands: ['npm install'] });

    await harness.manager.prepare(spec);

    expect(harness.gitCalls).toEqual([]);
    expect(harness.clearedHomes).toEqual([]);
    expect(progressSteps(harness.frames)).toEqual(['kilo_runtime', 'kilo_session']);
    expect(lastFrame(harness.frames)).toMatchObject({ workspace: 'same' });
    expect(harness.stamp()).toEqual(prepared);
  });

  it('reuses a repository without a stamp, never captures it, and stamps it', async () => {
    const harness = createHarness(FAST_TIMERS, { hasGit: true, capture: true });
    const spec = routeSpec({ git: { url: REPO }, capture: true });

    await harness.manager.prepare(spec);

    expect(harness.gitCalls.some(args => args[0] === 'clone')).toBe(false);
    expect(harness.gitCalls.some(args => args[0] === 'checkout')).toBe(true);
    expect(harness.captureRequests).toEqual([]);
    expect(harness.stamp()?.allocationId).toBe('alloc-current');
    expect(lastFrame(harness.frames)).toMatchObject({ workspace: 'cloned' });
  });
});

describe('refreshing an adopted repository snapshot', () => {
  function refreshHarness(stamp: WorkspaceStamp) {
    const harness = createHarness(FAST_TIMERS, { hasGit: true, capture: true });
    harness.setStamp(stamp);
    harness.setGit(args => {
      if (args[0] === 'show-ref') return result(1);
      if (args[0] === 'for-each-ref') return { stdout: 'main\n', stderr: '', exitCode: 0 };
      if (args[0] === 'rev-parse') return { stdout: 'new-commit\n', stderr: '', exitCode: 0 };
      return result(0);
    });
    const spec = routeSpec({
      git: { url: REPO, token: 'git-1', platform: 'github' },
      setupCommands: ['npm install'],
      capture: true,
    });
    return { harness, spec };
  }

  it('captures an adopted snapshot that is due, as the next generation', async () => {
    const { harness, spec } = refreshHarness({ ...DUE_STAMP, generation: 2 });

    await harness.manager.prepare(spec);

    expect(harness.gitCalls.some(args => args[0] === 'clone')).toBe(false);
    expect(harness.captureRequests).toHaveLength(1);
    expect(progressSteps(harness.frames)).toContain('snapshot');
    expect(harness.stamp()).toEqual({
      allocationId: 'alloc-current',
      commit: 'new-commit',
      capturedAt: NOW,
      generation: 3,
    });
    expect(lastFrame(harness.frames)).toMatchObject({ workspace: 'adopted' });
  });

  it('does not capture a fresh snapshot and keeps its capture time', async () => {
    const { harness, spec } = refreshHarness(FOREIGN_STAMP);

    await harness.manager.prepare(spec);

    expect(harness.captureRequests).toEqual([]);
    expect(harness.stamp()).toMatchObject({
      capturedAt: FOREIGN_STAMP.capturedAt,
      generation: 0,
    });
  });

  it('rebuilds a due snapshot at the generation cap from a clone, as generation 0', async () => {
    const { harness, spec } = refreshHarness({
      ...DUE_STAMP,
      generation: SNAPSHOT_MAX_GENERATION,
    });

    await harness.manager.prepare(spec);

    expect(harness.emptyCalls).toHaveLength(1);
    expect(harness.gitCalls.filter(args => args[0] === 'clone')).toHaveLength(1);
    expect(harness.gitCalls.some(args => args[0] === 'fetch')).toBe(false);
    expect(harness.captureRequests).toHaveLength(1);
    expect(harness.stamp()).toMatchObject({ capturedAt: NOW, generation: 0 });
    expect(lastFrame(harness.frames)).toMatchObject({ workspace: 'cloned' });
  });

  it('adopts a snapshot at the cap that is not due, without capturing it', async () => {
    const { harness, spec } = refreshHarness({
      ...FOREIGN_STAMP,
      generation: SNAPSHOT_MAX_GENERATION,
    });

    await harness.manager.prepare(spec);

    expect(harness.emptyCalls).toEqual([]);
    expect(harness.captureRequests).toEqual([]);
    expect(lastFrame(harness.frames)).toMatchObject({ workspace: 'adopted' });
    expect(harness.stamp()).toMatchObject({ generation: SNAPSHOT_MAX_GENERATION });
  });

  it('captures a due snapshot only when the route asks for a capture', async () => {
    const { harness, spec } = refreshHarness(DUE_STAMP);

    await harness.manager.prepare({ ...spec, capture: undefined });

    expect(harness.captureRequests).toEqual([]);
  });

  it('starts over at generation 0 when the adopt falls back to a clone', async () => {
    const harness = createHarness(timers({ restoreMs: 30, cloneMs: 2_000 }), {
      hasGit: true,
      capture: true,
    });
    harness.setStamp({ ...DUE_STAMP, generation: 3 });
    harness.setGit(args => {
      if (args[0] === 'fetch') return new Promise<ExecResult>(() => undefined);
      return result(args[0] === 'show-ref' ? 1 : 0);
    });

    await harness.manager.prepare(
      routeSpec({ git: { url: REPO, token: 'git-1', platform: 'github' }, capture: true })
    );

    expect(lastFrame(harness.frames)).toMatchObject({ workspace: 'cloned' });
    expect(harness.captureRequests).toHaveLength(1);
    expect(harness.stamp()).toMatchObject({ capturedAt: NOW, generation: 0 });
  });
});

describe('capturing a repository snapshot', () => {
  function captureSpec(overrides: Partial<ControlPlaneRouteSpec> = {}) {
    return routeSpec({
      git: { url: REPO, token: 'git-1', platform: 'github' },
      setupCommands: ['npm install'],
      capture: true,
      ...overrides,
    });
  }

  it('makes origin bare around the capture and restores the credential before Kilo starts', async () => {
    const harness = createHarness(FAST_TIMERS, { capture: true });
    const order: string[] = [];
    harness.setGit(args => {
      if (args[0] === 'remote') {
        order.push(args[3]?.includes('git-1') ? 'origin:authenticated' : 'origin:bare');
      }
      if (args[0] === 'reflog') order.push('reflog');
      if (args[0] === 'rev-parse') return { stdout: 'abc123\n', stderr: '', exitCode: 0 };
      return result(0);
    });
    const spec = captureSpec();

    await harness.manager.prepare(spec);

    expect(harness.captureRequests).toEqual([
      { sessionId: spec.sessionId, commit: 'abc123', timeoutMs: FAST_TIMERS.wrapper.captureMs },
    ]);
    expect(order).toEqual(['origin:bare', 'reflog', 'origin:authenticated']);
    expect(progressSteps(harness.frames)).toEqual([
      'clone',
      'checkout',
      'setup',
      'snapshot',
      'kilo_runtime',
      'kilo_session',
    ]);
    expect(harness.stamp()).toEqual({
      allocationId: 'alloc-current',
      commit: 'abc123',
      capturedAt: NOW,
      generation: 0,
    });
    expect(harness.truncations()).toBe(1);
    expect(harness.clearedHomes).toEqual([]);
    expect(lastFrame(harness.frames)).toMatchObject({ workspace: 'cloned' });
  });

  it('writes the stamp before it asks for the capture', async () => {
    const harness = createHarness(FAST_TIMERS, { capture: true });
    let stampAtCapture: unknown = 'unset';
    const requests = harness.captureRequests;
    const push = requests.push.bind(requests);
    requests.push = (...items) => {
      stampAtCapture = harness.stamp();
      return push(...items);
    };

    await harness.manager.prepare(captureSpec());

    expect(stampAtCapture).toMatchObject({ allocationId: 'alloc-current' });
  });

  it('continues when the capture is not saved or the channel fails, and restores origin', async () => {
    for (const outcome of [false, 'throw'] as const) {
      const harness = createHarness(FAST_TIMERS, { capture: true });
      harness.setCaptureResult(outcome);
      const spec = captureSpec();

      await harness.manager.prepare(spec);

      expect(lastFrame(harness.frames)).toMatchObject({ type: 'session.ready' });
      const setUrls = harness.gitCalls.filter(
        args => args[0] === 'remote' && args[1] === 'set-url'
      );
      expect(setUrls.at(-1)?.[3]).toContain('git-1');
    }
  });

  it('does not capture when origin cannot be made bare', async () => {
    const harness = createHarness(FAST_TIMERS, { capture: true });
    harness.setGit(args =>
      args[0] === 'remote' && !args[3]?.includes('git-1')
        ? result(1, 'fatal: no such remote')
        : result(0)
    );

    await harness.manager.prepare(captureSpec());

    expect(harness.captureRequests).toEqual([]);
    expect(lastFrame(harness.frames)).toMatchObject({ type: 'session.ready' });
  });

  it('fails the route when the credential cannot be restored after a capture', async () => {
    const harness = createHarness(FAST_TIMERS, { capture: true });
    harness.setGit(args =>
      args[0] === 'remote' && args[3]?.includes('git-1')
        ? result(1, 'fatal: cannot set url')
        : result(0)
    );

    await harness.manager.prepare(captureSpec());

    expect(lastFrame(harness.frames)).toMatchObject({
      type: 'session.failed',
      reason: 'workspace_setup_failed',
      step: 'snapshot',
    });
  });

  it('does not capture without a capture request, a repository or a capture channel', async () => {
    const withoutRequest = createHarness(FAST_TIMERS, { capture: true });
    await withoutRequest.manager.prepare(captureSpec({ capture: undefined }));
    expect(withoutRequest.captureRequests).toEqual([]);

    const withoutChannel = createHarness(FAST_TIMERS);
    await withoutChannel.manager.prepare(captureSpec());
    expect(progressSteps(withoutChannel.frames)).not.toContain('snapshot');

    const withoutRepo = createHarness(FAST_TIMERS, { capture: true });
    await withoutRepo.manager.prepare(captureSpec({ git: undefined }));
    expect(withoutRepo.captureRequests).toEqual([]);
  });
});

describe('control-plane runtime profiles', () => {
  it('materializes skills, agents and commands before Kilo starts and retains them through credential refresh', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'control-profile-'));
    const profile = {
      runtimeSkills: [
        {
          name: 'review',
          rawMarkdown: '---\nname: review\ndescription: Review\n---\nReview changes',
          files: { 'scripts/check.sh': 'echo checked' },
        },
      ],
      runtimeAgents: [
        {
          slug: 'reviewer',
          name: 'Reviewer',
          config: {
            prompt: 'Review carefully',
            model: 'test-model',
            variant: 'high',
            permission: { bash: 'deny' },
          },
        },
      ],
      kiloCommands: [
        {
          name: 'review-now',
          template: 'Review $ARGUMENTS',
          agent: 'reviewer',
          model: 'command-model',
          subtask: true,
        },
      ],
    };
    const harness = createHarness(FAST_TIMERS, {
      homeRoot: root,
      beforeEnsure: async () => {
        const env = harness.ensureInputs.at(-1)!.env;
        if (!env.KILO_CONFIG) return;
        expect(
          await fs.readFile(path.join(env.HOME, '.kilocode/skills/review/SKILL.md'), 'utf8')
        ).toBe(profile.runtimeSkills[0].rawMarkdown);
        expect(
          await fs.readFile(path.join(env.HOME, '.kilocode/skills/review/scripts/check.sh'), 'utf8')
        ).toBe('echo checked');
        expect(JSON.parse(await fs.readFile(env.KILO_CONFIG, 'utf8'))).toMatchObject({
          agent: {
            reviewer: {
              mode: 'primary',
              prompt: 'Review carefully',
              model: 'kilo/test-model',
              variant: 'high',
              permission: { bash: 'deny' },
            },
          },
          command: {
            'review-now': {
              template: 'Review $ARGUMENTS',
              agent: 'reviewer',
              model: 'kilo/command-model',
              subtask: true,
            },
          },
        });
      },
    });
    try {
      const spec = routeSpec({ ...profile, runtimeIsolation: 'per-session' });
      await harness.manager.prepare(spec);
      expect(harness.frames.at(-1)?.type).toBe('session.ready');
      const env = harness.ensureInputs[0].env;
      expect(env.KILO_CONFIG).toBe(profileConfigPath(env.HOME));
      await harness.manager.installCredentials({
        sessionId: spec.sessionId,
        kilo: { token: 'rotated-token' },
      });
      expect(harness.installCalls[0].env.KILO_CONFIG).toBe(env.KILO_CONFIG);
      expect(harness.installCalls[0].env.KILOCODE_TOKEN).toBe('rotated-token');
      expect(
        JSON.parse(await fs.readFile(env.KILO_CONFIG, 'utf8')).command['review-now'].agent
      ).toBe('reviewer');
      const sibling = routeSpec({
        sessionId: 'ses_22222222222222222222222222',
        runtimeIsolation: 'per-session',
      });
      await harness.manager.prepare(sibling);
      const siblingEnv = harness.ensureInputs[1].env;
      expect(siblingEnv.HOME).not.toBe(env.HOME);
      expect(siblingEnv.KILO_CONFIG).toBeUndefined();
      expect(existsSync(path.join(siblingEnv.HOME, '.kilocode/skills/review/SKILL.md'))).toBe(
        false
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
