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
import type { WrapperKiloClient } from '../kilo-api.js';
import type { ExecResult, ProcessOutputStream } from '../utils.js';
import * as processUtils from '../utils.js';
import { createPreparationManager, type PrepareRuntimePort } from './prepare.js';
import { KiloWorktreeMcpMismatchError } from './kilo-runtime.js';

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
  setGit: (value: (args: string[]) => ExecResult | Promise<ExecResult>) => void;
  setSessionExists: (value: boolean) => void;
  setSessionExistsHung: (value: boolean) => void;
  setRestore: (value: () => Promise<unknown>) => void;
  restoreCalls: () => number;
  restoreOptions: () => Array<Record<string, unknown> | undefined>;
  setEnsureRejects: (value: boolean) => void;
  setEnsureError: (value: unknown) => void;
  setEnsureHung: (value: boolean) => void;
  setUnavailable: (key: string, value: boolean) => void;
  setBootstrapMarker: (value: boolean) => void;
  setSetupResult: (value: ExecResult) => void;
  setSetupOutput: (
    value: (onOutput: (stream: ProcessOutputStream, output: string) => void) => void
  ) => void;
};

function createHarness(
  activeTimers: ControlPlaneTimers = FAST_TIMERS,
  options: {
    hasGit?: boolean;
    beforeEnsure?: () => Promise<void>;
    beforeInstall?: () => Promise<void>;
  } = {}
): Harness {
  const frames: ControlPlaneWrapperFrame[] = [];
  const logs: string[] = [];
  const gitCalls: string[][] = [];
  const authorCalls: Array<{ name: string; email: string } | undefined> = [];
  const ensureInputs: EnsureInput[] = [];
  const installCalls: Array<{ key: string; env: Record<string, string> }> = [];
  const releaseCalls: string[] = [];
  const removeCalls: string[] = [];
  let clone: ExecResult | (() => Promise<ExecResult>) = result(0);
  let customGit: ((args: string[]) => ExecResult | Promise<ExecResult>) | undefined;
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
  let bootstrapMarker = false;
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
    runtimes,
    inheritedEnv: {},
    homeRoot: '/tmp/prepare-test-homes',
    hasGit: async () => options.hasGit ?? false,
    hasBootstrapMarker: async () => bootstrapMarker,
    writeBootstrapMarker: async () => {
      bootstrapMarker = true;
    },
    mkdir: async () => undefined,
    configureGitAuthor: async (_directory, _runGit, author) => {
      authorCalls.push(author);
    },
    runGit: async args => {
      gitCalls.push(args);
      if (customGit) return customGit(args);
      if (args[0] === 'clone') {
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
    setBootstrapMarker: value => {
      bootstrapMarker = value;
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
    expect(lastFrame(harness.frames)).toEqual({ type: 'session.ready', sessionId: spec.sessionId });
    expect(harness.gitCalls.some(args => args[0] === 'clone')).toBe(true);
    expect(harness.gitCalls.some(args => args[0] === 'checkout')).toBe(true);
    expect(harness.manager.isPrepared(spec.sessionId)).toBe(true);

    const before = harness.frames.length;
    await harness.manager.prepare(spec);
    expect(harness.frames.length).toBe(before + 1);
    expect(lastFrame(harness.frames)).toEqual({ type: 'session.ready', sessionId: spec.sessionId });
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
    expect(lastFrame(harness.frames)).toEqual({ type: 'session.ready', sessionId: spec.sessionId });
    expect(harness.gitCalls).toContainEqual(['clone', expect.any(String), spec.directory]);
    expect(harness.gitCalls.some(args => args[0] === 'checkout')).toBe(true);
    expect(harness.authorCalls).toEqual([author]);
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
      if (args[0] === 'checkout' && args[1] === '-B') {
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

    expect(lastFrame(harness.frames)).toEqual({ type: 'session.ready', sessionId: spec.sessionId });
    expect(harness.gitCalls).toContainEqual(['checkout', '-b', 'session/scope-1']);
    expect(harness.gitCalls).not.toContainEqual([
      'checkout',
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
        hasBootstrapMarker: async () => false,
        writeBootstrapMarker: async () => undefined,
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
    expect(lastFrame(harness.frames)).toEqual({ type: 'session.ready', sessionId: spec.sessionId });
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
      hasGit: async () => true,
      hasBootstrapMarker: async () => false,
      writeBootstrapMarker: async () => undefined,
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
    expect(output?.properties.output).toContain('installing dependencies');
    expect(lastFrame(harness.frames)).toMatchObject({ type: 'session.failed', step: 'setup' });
  });
});
