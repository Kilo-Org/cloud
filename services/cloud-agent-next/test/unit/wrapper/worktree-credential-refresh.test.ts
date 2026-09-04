import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createWrapperKiloClient, type WrapperKiloClient } from '../../../wrapper/src/kilo-api.js';
import {
  createWorktreeKiloRuntimes,
  type WorktreeKiloAuth,
  type WorktreeKiloRuntimes,
} from '../../../wrapper/src/control/worktree-runtime.js';
import {
  directoryForSession,
  resetSessionDirectoryState,
} from '../../../wrapper/src/control/session-directories.js';
import { resetDirectoryOperationState } from '../../../wrapper/src/control/worktree-operations.js';
import {
  createControlHandlerDeps,
  createSessionActivityRegistry,
  handleControlRequest,
  refreshHeartbeatPayload,
  type ControlHandlerResult,
  type HandlerDeps,
} from '../../../wrapper/src/control/sandbox-control-handlers.js';
import { startSandboxControlEventFeed } from '../../../wrapper/src/control/sandbox-control-runtime.js';
import type * as ControlRuntimeModule from '../../../wrapper/src/control/sandbox-control-runtime.js';
import type * as KiloApiModule from '../../../wrapper/src/kilo-api.js';
import type * as UtilsModule from '../../../wrapper/src/utils.js';

vi.mock('node:fs/promises', () => ({
  default: {
    mkdir: vi.fn(async () => undefined),
    writeFile: vi.fn(async () => undefined),
    rm: vi.fn(async () => undefined),
  },
}));
vi.mock('@kilocode/sdk', () => ({ createKiloClient: vi.fn(() => ({})) }));
vi.mock('../../../wrapper/src/kilo-api.js', async importOriginal => ({
  ...(await importOriginal<typeof KiloApiModule>()),
  createWrapperKiloClient: vi.fn(),
}));
vi.mock('../../../wrapper/src/control/sandbox-control-runtime.js', async importOriginal => ({
  ...(await importOriginal<typeof ControlRuntimeModule>()),
  startSandboxControlEventFeed: vi.fn(async () => ({
    isFresh: () => true,
    usable: Promise.resolve(true),
    close: () => {},
    settled: Promise.resolve(),
  })),
}));

const first = {
  sessionId: 'workspace_first',
  kiloSessionId: 'ses_first',
  directory: '/workspace/test-refresh',
};
const sibling = { ...first, sessionId: 'workspace_sibling', kiloSessionId: 'ses_sibling' };
const auth: WorktreeKiloAuth = {
  scopeId: 'worktree_refresh',
  token: 'real-kilo-original',
  containmentEnabled: false,
  targets: {
    backendBaseUrl: 'https://backend.example.test',
    providerBaseUrl: 'https://provider.example.test',
    sessionIngestBaseUrl: 'https://ingest.example.test',
  },
};
const registries: WorktreeKiloRuntimes[] = [];

function fixture() {
  const clients: WrapperKiloClient[] = [];
  vi.mocked(createWrapperKiloClient).mockImplementation((_client, serverUrl) => {
    const client = {
      serverUrl,
      getSessionStatuses: async () => ({}),
      createPty: async () => {
        throw new Error('Unexpected PTY');
      },
    } as WrapperKiloClient;
    clients.push(client);
    return client;
  });
  const close = vi.fn();
  const startServer = vi.fn<
    NonNullable<Parameters<typeof createWorktreeKiloRuntimes>[0]['startServer']>
  >(async options => {
    const stopped = Promise.withResolvers<void>();
    options.onProcessScope?.({
      stop: async () => {
        stopped.resolve();
        return true;
      },
      verify: async () => true,
    } as never);
    return {
      url: `http://127.0.0.1:${10000 + clients.length}`,
      stopped: stopped.promise,
      close: () => {
        close();
        stopped.resolve();
      },
    };
  });
  const registry = createWorktreeKiloRuntimes({
    homeRoot: '/test-homes',
    inheritedEnv: {},
    startServer,
    onUnexpectedClose: () => {},
  });
  registries.push(registry);
  async function attach(
    identity = first,
    requestedAuth = auth,
    environment = { GH_TOKEN: 'github-original' }
  ) {
    const attachment = registry.attach(
      identity,
      requestedAuth,
      environment,
      () => true,
      'per-session'
    );
    const runtime = await attachment.ready;
    attachment.commit();
    attachment.release();
    return runtime;
  }
  return { registry, attach, clients, startServer, stops };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json([]))
  );
});

afterEach(() => {
  for (const registry of registries.splice(0)) registry.shutdown();
  vi.unstubAllGlobals();
});

describe('direct per-session worktree credential refresh', () => {
  it('starts sibling roots in one directory with independent servers, clients, homes, and auth', async () => {
    const f = fixture();
    const [firstRuntime, siblingRuntime] = await Promise.all([f.attach(first), f.attach(sibling)]);

    expect(f.startServer).toHaveBeenCalledTimes(2);
    expect(firstRuntime).not.toBe(siblingRuntime);
    expect(firstRuntime.kiloClient).not.toBe(siblingRuntime.kiloClient);
    expect(firstRuntime.env.HOME).not.toBe(siblingRuntime.env.HOME);
    expect(firstRuntime.env.KILOCODE_TOKEN).toBe(auth.token);
    expect(siblingRuntime.env.KILOCODE_TOKEN).toBe(auth.token);
    expect(f.registry.get(first)).toBe(firstRuntime);
    expect(f.registry.get(sibling)).toBe(siblingRuntime);
    expect(f.registry.getAll(first.directory)).toEqual(
      expect.arrayContaining([firstRuntime, siblingRuntime])
    );
    expect(fs.writeFile).toHaveBeenCalledTimes(2);
  });

  it('refreshes only the requested root and never blocks its sibling', async () => {
    const f = fixture();
    const firstRuntime = await f.attach(first);
    const siblingRuntime = await f.attach(sibling);
    const originalSiblingClient = siblingRuntime.kiloClient;

    const refreshed = await f.attach(
      first,
      { ...auth, token: 'real-kilo-renewed' },
      {
        GH_TOKEN: 'github-renewed',
      }
    );

    expect(refreshed).toBe(firstRuntime);
    expect(refreshed.kiloClient).not.toBe(f.clients[0]);
    expect(refreshed.env.GH_TOKEN).toBe('github-renewed');
    expect(siblingRuntime.signal.aborted).toBe(false);
    expect(siblingRuntime.kiloClient).toBe(originalSiblingClient);
    expect(siblingRuntime.env.GH_TOKEN).toBe('github-original');
    expect(f.registry.get(sibling)).toBe(siblingRuntime);
    expect(f.startServer).toHaveBeenCalledTimes(3);
  });

  it('keeps a sibling alive through detach, replacement, and directory-wide deletion', async () => {
    const f = fixture();
    const runtime = await f.attach();
    await f.attach(auth, originalEnv, sibling);
    const queried = Promise.withResolvers<void>();
    const release = Promise.withResolvers<Record<string, { type: string }>>();
    f.statuses.mockImplementationOnce(() => {
      queried.resolve();
      return release.promise;
    });
    const activity = createSessionActivityRegistry();
    activity.attach(identity.kiloSessionId);
    activity.attach(sibling.kiloSessionId);
    const emitSessionEvent = vi.fn();
    const deps: HandlerDeps = createControlHandlerDeps({
      kiloRuntimes: f.registry,
      version: 'test',
      kiloReady: true,
      sessions: [],
      activity,
      emitSessionEvent,
      retireRuntime: vi.fn(),
      applyAttach: (session, payload, options) =>
        applySessionAttach(session, payload, {
          ...options,
          hasBootstrapMarker: async () => true,
          sessionExists: async () => true,
        }),
    });
    const refreshing = handleControlRequest(
      'session.attach',
      identity,
      { kilo: auth, env: { ...originalEnv, GH_TOKEN: 'github-renewed' } },
      deps
    );
    try {
      await queried.promise;
      expect(f.registry.get(identity.directory)).toBeUndefined();
      expect(f.registry.isHealthy()).toBe(true);
      expect(
        await handleControlRequest(
          'session.prompt',
          sibling,
          {
            messageId: 'waiting-sibling',
            turn: { type: 'prompt', prompt: 'continue' },
            agent: { mode: 'code', model: 'kilo/test' },
          },
          deps
        )
      ).toMatchObject({ ok: false, error: { code: 'session_busy', retryable: true } });
      expect(deps.operations.hasActive(sibling.kiloSessionId)).toBe(false);
      expect(emitSessionEvent).not.toHaveBeenCalled();
      expect(runtime.signal.aborted).toBe(false);
    } finally {
      release.resolve({});
      await refreshing;
    }
    expect(await refreshing).toEqual({ ok: true, result: { attached: true } });
    expect(f.registry.get(identity.directory)).toBe(runtime);
    expect(runtime.env.GH_TOKEN).toBe('github-renewed');
    expect(f.onUnexpectedClose).not.toHaveBeenCalled();
    expect(deps.retireRuntime).not.toHaveBeenCalled();
  });

  it.each(['stale', 'aborted', 'other-directory', 'execution', 'unattached', 'no-task'] as const)(
    'keeps unavailable prompt semantics instead of reporting refresh contention: %s',
    async condition => {
      const f = fixture();
      let fresh = true;
      vi.mocked(startSandboxControlEventFeed).mockResolvedValueOnce({
        isFresh: () => fresh,
        usable: Promise.resolve(true),
        close: () => {},
        settled: Promise.resolve(),
      });
      await f.attach();
      await f.attach(auth, originalEnv, sibling);
      if (condition === 'stale') fresh = false;
      else vi.spyOn(f.registry, 'get').mockReturnValue(undefined);
      if (condition === 'unattached') f.registry.detach(sibling);
      const emitSessionEvent = vi.fn();
      const retireRuntime = vi.fn();
      const deps: HandlerDeps = createControlHandlerDeps({
        kiloRuntimes: f.registry,
        version: 'test',
        kiloReady: true,
        sessions: [],
        emitSessionEvent,
        retireRuntime,
      });
      const held = Promise.withResolvers<ControlHandlerResult>();
      let operation:
        | { cancel: (r: string, s: 'cancelled') => void; done: Promise<unknown> }
        | undefined;
      if (condition !== 'no-task') {
        const taskSession = {
          ...identity,
          directory: condition === 'other-directory' ? '/workspace/other' : identity.directory,
        };
        if (condition === 'execution') {
          const runtimeLifetime = new AbortController();
          const fakeRuntime = {
            directory: taskSession.directory,
            scopeId: 'fake',
            env: {},
            kiloClient: {
              sendPrompt: () => held.promise,
              abortSession: async () => true,
              getSessionDetails: async (id: string) => ({ id }),
            },
            signal: runtimeLifetime.signal,
          };
          operation = deps.operations.start(
            taskSession,
            undefined,
            {
              operation: 'session.prompt',
              payload: {
                messageId: 'other-message',
                turn: { type: 'prompt', prompt: 'block' },
                agent: { mode: 'code', model: 'kilo/test' },
              },
              runtime: fakeRuntime as any,
            },
            { emitSessionEvent: () => {} }
          );
        } else {
          operation = deps.operations.start(
            taskSession,
            undefined,
            {
              operation: 'session.attach',
              payload: {} as any,
              apply: () => held.promise,
              onAttached: () => {},
            },
            { emitSessionEvent: () => {} }
          );
        }
        if (condition === 'aborted') operation.cancel('test-abort', 'cancelled');
      }
      expect(
        await handleControlRequest(
          'session.prompt',
          sibling,
          {
            messageId: 'waiting-sibling',
            turn: { type: 'prompt', prompt: 'continue' },
            agent: { mode: 'code', model: 'kilo/test' },
          },
          deps
        )
      ).toMatchObject({ ok: false, error: { code: 'not_ready', retryable: true } });
      expect(deps.operations.hasActive(sibling.kiloSessionId)).toBe(false);
      expect(emitSessionEvent).not.toHaveBeenCalled();
      expect(retireRuntime).not.toHaveBeenCalled();
      // Clean up held operations
      held.resolve({ ok: true, result: {} });
      if (operation) await operation.done.catch(() => {});
    }
  );

  it('waits for confirmed old process exit before launching the refreshed process', async () => {
    const f = fixture();
    const stopped = Promise.withResolvers<void>();
    f.startServer.mockImplementationOnce(async options => {
      options.onProcessScope?.({ stop: async () => true, verify: async () => true } as never);
      return { url: 'http://127.0.0.1:10000', close: f.close, stopped: stopped.promise };
    });
    const runtime = await f.attach();
    const attachment = f.registry.attach(
      identity,
      auth,
      { ...originalEnv, GH_TOKEN: 'github-renewed' },
      () => true
    );
    await vi.waitFor(() => expect(f.close).toHaveBeenCalledTimes(1));
    expect(f.startServer).toHaveBeenCalledTimes(1);
    expect(f.registry.get(identity.directory)).toBeUndefined();
    stopped.resolve();
    expect(await attachment.ready).toBe(runtime);
    attachment.commit();
    attachment.release();
    expect(f.startServer).toHaveBeenCalledTimes(2);
  });

  it.each(['server-start', 'feed-start', 'feed-timeout', 'process-stop-timeout'] as const)(
    'requests bounded owner recovery after destructive refresh failure: %s',
    async failure => {
      const f = fixture();
      const stopped = Promise.withResolvers<void>();
      if (failure === 'process-stop-timeout') {
        f.startServer.mockImplementationOnce(async options => {
          options.onProcessScope?.({ stop: async () => false, verify: async () => false } as never);
          return { url: 'http://127.0.0.1:10000', close: f.close, stopped: stopped.promise };
        });
      }
      const runtime = await f.attach();
      await f.attach(auth, originalEnv, sibling);
      if (failure === 'server-start')
        f.startServer.mockRejectedValueOnce(new Error('private-startup-credential'));
      if (failure === 'feed-start')
        vi.mocked(startSandboxControlEventFeed).mockRejectedValueOnce(
          new Error('private-feed-credential')
        );
      if (failure === 'feed-timeout')
        vi.mocked(startSandboxControlEventFeed).mockImplementationOnce(() => new Promise(() => {}));
      vi.useFakeTimers();
      const outcome = f
        .attach(auth, { ...originalEnv, GH_TOKEN: 'github-renewed' })
        .catch(error => error);
      await vi.advanceTimersByTimeAsync(30_001);

      expect(await outcome).toMatchObject({ code: 'runtime_unhealthy', retryable: true });
      expect(runtime.signal.aborted).toBe(true);
      expect(f.registry.get(identity.directory)).toBeUndefined();
      await vi.waitFor(() => expect(f.onUnexpectedClose).toHaveBeenCalledTimes(1));
      expect(f.registry.isHealthy()).toBe(failure !== 'process-stop-timeout');
      expect(f.onUnexpectedClose.mock.calls[0]?.[0]).toMatchObject({
        directory: identity.directory,
        reason: 'credential_refresh_failed',
        cleanup: failure === 'process-stop-timeout' ? 'unconfirmed' : 'confirmed',
      });
      expect(f.startServer).toHaveBeenCalledTimes(failure === 'process-stop-timeout' ? 1 : 2);
      stopped.resolve();
      f.registry.shutdown();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(f.onUnexpectedClose).toHaveBeenCalledTimes(1);
      expect(() => f.registry.attach(sibling, auth, originalEnv, () => true)).toThrow(
        'Kilo worktrees are closed'
      );
    }
  );

  it('does not report intentional shutdown during a pending destructive refresh as unexpected', async () => {
    const f = fixture();
    const stopped = Promise.withResolvers<void>();
    f.startServer.mockImplementationOnce(async options => {
      options.onProcessScope?.({ stop: async () => true, verify: async () => true } as never);
      return { url: 'http://127.0.0.1:10000', close: f.close, stopped: stopped.promise };
    });
    await f.attach();
    const outcome = f
      .attach(auth, { ...originalEnv, GH_TOKEN: 'github-renewed' })
      .catch(error => error);
    await vi.waitFor(() => expect(f.close).toHaveBeenCalledTimes(1));
    f.registry.shutdown();
    expect(await outcome).toMatchObject({ code: 'runtime_unhealthy' });
    stopped.resolve();
    expect(f.startServer).toHaveBeenCalledTimes(1);
    expect(f.onUnexpectedClose).not.toHaveBeenCalled();
  });

  it('keeps failed initial startup retryable without retiring a healthy owner', async () => {
    const f = fixture();
    f.startServer.mockRejectedValueOnce(new Error('private-startup-credential'));
    await expect(f.attach()).rejects.toMatchObject({ code: 'not_ready', retryable: true });
    expect(f.onUnexpectedClose).not.toHaveBeenCalled();
    await f.attach();
    expect(f.registry.isHealthy()).toBe(true);
    expect(f.startServer).toHaveBeenCalledTimes(2);
  });

  it('reports confirmed process exit immediately even if the feed still appears fresh', async () => {
    const f = fixture();
    const stopped = Promise.withResolvers<void>();
    f.startServer.mockImplementationOnce(async options => {
      options.onProcessScope?.({ stop: async () => true, verify: async () => true } as never);
      return { url: 'http://127.0.0.1:10000', close: f.close, stopped: stopped.promise };
    });
    const runtime = await f.attach();
    stopped.resolve();
    await stopped.promise;
    expect(runtime.signal.aborted).toBe(true);
    expect(f.registry.get(identity.directory)).toBeUndefined();
    await vi.waitFor(() => expect(f.onUnexpectedClose).toHaveBeenCalledTimes(1));
    expect(f.registry.isHealthy()).toBe(true);
    expect(f.onUnexpectedClose.mock.calls[0]?.[0]).toMatchObject({
      directory: identity.directory,
      reason: 'process_exited',
      cleanup: 'confirmed',
    });
  });

  it.each(['connection', 'http'] as const)(
    'recovers from real SDK SSE startup %s errors without retaining private data',
    async failure => {
      vi.mocked(fetch).mockImplementation(async request => {
        const url = request instanceof Request ? request.url : String(request);
        if (new URL(url).pathname === '/global/health') {
          return Response.json({ healthy: true, version: '7.4.20' });
        }
        if (failure === 'connection') throw new Error('private-connection-credential');
        return new Response(null, { status: 503, statusText: 'private-http-credential' });
      });
      const f = fixture();
      const runtime = await f.attach();
      const feed = vi.mocked(startSandboxControlEventFeed).mock.calls[0]?.[0];
      if (!feed) throw new Error('Missing worktree event feed');
      const { stream } = await feed.open(feed.signal);
      if (!stream) throw new Error('Missing SDK SSE stream');
      const error = await stream[Symbol.asyncIterator]()
        .next()
        .catch(error => error);
      expect(error).toMatchObject({
        reason: 'feed_failed',
        message: 'Kilo global event feed failed',
      });
      expect(error).not.toHaveProperty('cause');
      expect(String(error)).not.toContain('private-');
      expect(JSON.stringify(error)).not.toContain('private-');
      expect(
        vi.mocked(fetch).mock.calls.filter(([request]) => {
          const url = request instanceof Request ? request.url : String(request);
          return new URL(url).pathname === '/global/event';
        })
      ).toHaveLength(1);
      expect(runtime.signal.aborted).toBe(false);
      feed.onUnexpectedClose(error);
      await vi.waitFor(() =>
        expect(vi.mocked(startSandboxControlEventFeed)).toHaveBeenCalledTimes(2)
      );
      expect(f.onUnexpectedClose).not.toHaveBeenCalled();
      expect(runtime.signal.aborted).toBe(false);
    }
  );

  it('ignores retired process feed failures and recovers current feed errors', async () => {
    const f = fixture();
    const runtime = await f.attach();
    const oldFeed = vi.mocked(startSandboxControlEventFeed).mock.calls[0]?.[0];
    expect(oldFeed).toBeDefined();
    await f.attach(auth, { ...originalEnv, GH_TOKEN: 'github-renewed' });
    oldFeed?.onUnexpectedClose(new Error('private-old-feed-credential'));
    expect(runtime.signal.aborted).toBe(false);
    expect(f.registry.isHealthy()).toBe(true);
    expect(f.onUnexpectedClose).not.toHaveBeenCalled();
    const currentFeed = vi.mocked(startSandboxControlEventFeed).mock.calls[1]?.[0];
    expect(currentFeed).toBeDefined();
    currentFeed?.onUnexpectedClose(new Error('private-current-feed-credential'));
    currentFeed?.onUnexpectedClose(new Error('private-duplicate-feed-credential'));
    await vi.waitFor(() =>
      expect(vi.mocked(startSandboxControlEventFeed)).toHaveBeenCalledTimes(3)
    );
    expect(f.onUnexpectedClose).not.toHaveBeenCalled();
    expect(runtime.signal.aborted).toBe(false);
  });

  it('keeps a stale runtime while its feed recovery begins', async () => {
    const f = fixture();
    let fresh = true;
    vi.mocked(startSandboxControlEventFeed).mockResolvedValueOnce({
      isFresh: () => fresh,
      usable: Promise.resolve(true),
      close: () => {},
      settled: Promise.resolve(),
    });
    const runtime = await f.attach();
    fresh = false;
    expect(f.registry.prepareForNewWork?.(identity.directory)).toBe(false);
    expect(f.registry.get(identity.directory)).toBe(runtime);
    expect(f.registry.isHealthy()).toBe(true);
  });

  it('discards heartbeat statuses from a replaced process with the same logical runtime', async () => {
    const f = fixture();
    const runtime = await f.attach();
    const status =
      Promise.withResolvers<Awaited<ReturnType<WrapperKiloClient['getSessionStatuses']>>>();
    f.statuses.mockReturnValueOnce(status.promise);
    const activity = createSessionActivityRegistry();
    activity.attach(identity.kiloSessionId);
    const deps: HandlerDeps = createControlHandlerDeps({
      kiloRuntimes: f.registry,
      version: 'test',
      kiloReady: true,
      sessions: [],
      activity,
      emitSessionEvent: vi.fn(),
      retireRuntime: vi.fn(),
    });
    const heartbeat = refreshHeartbeatPayload(deps);
    const oldClient = runtime.kiloClient;
    await f.attach(auth, { ...originalEnv, GH_TOKEN: 'github-renewed' });
    expect(f.registry.get(identity.directory)).toBe(runtime);
    expect(runtime.kiloClient).not.toBe(oldClient);
    status.resolve({ [identity.kiloSessionId]: { type: 'busy' } });
    expect((await heartbeat).sessions).toEqual([
      expect.objectContaining({ kiloSessionId: identity.kiloSessionId, state: 'idle' }),
    ]);
    expect(f.onUnexpectedClose).not.toHaveBeenCalled();
  });

  it('does not recycle while terminal creation is in flight', async () => {
    const f = fixture();
    const runtime = await f.attach();
    const created = Promise.withResolvers<Awaited<ReturnType<WrapperKiloClient['createPty']>>>();
    f.createPty.mockReturnValue(created.promise);
    const pending = runtime.kiloClient.createPty({
      cwd: identity.directory,
      title: 'Workspace terminal',
      env: runtime.env,
    });
    await expect(
      f.attach(auth, { ...originalEnv, GH_TOKEN: 'github-renewed' })
    ).rejects.toMatchObject({
      code: 'session_busy',
      retryable: true,
    });
    expect(f.close).not.toHaveBeenCalled();
    created.resolve({
      id: 'pty-test',
      title: 'Workspace terminal',
      command: 'sh',
      args: [],
      cwd: identity.directory,
      status: 'running',
      pid: 1,
    });
    await pending;
  });

  it('keeps contained alias changes unauthorized and preserves contained environment reuse', async () => {
    const f = fixture();
    const contained = { ...auth, containmentEnabled: undefined };
    const runtime = await f.attach(contained);
    await expect(f.attach({ ...contained, token: 'replacement-alias' })).rejects.toMatchObject({
      code: 'unauthorized',
      retryable: false,
    });
    expect(await f.attach(contained, { ...originalEnv, GH_TOKEN: 'different-profile-token' })).toBe(
      runtime
    );
    expect(runtime.env.GH_TOKEN).toBe(originalEnv.GH_TOKEN);
    expect(f.startServer).toHaveBeenCalledTimes(1);
  });

  it.each([
    { ...auth, scopeId: 'other-worktree' },
    { ...auth, organizationId: 'other-org' },
    { ...auth, containmentEnabled: true },
    { ...auth, targets: { ...auth.targets, providerBaseUrl: 'https://other.example.test' } },
  ])('does not treat changed authorization context as token rotation', async changed => {
    const f = fixture();
    await f.attach();
    await expect(f.attach(changed)).rejects.toMatchObject({
      code: 'unauthorized',
      retryable: false,
    });
    expect(f.close).not.toHaveBeenCalled();
  });

  it('refreshes warm Git origin while preserving an explicit profile token without recycling', async () => {
    const f = fixture();
    const runGit = vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 }));
    const runSetup = vi.fn();
    const deps = {
      kiloRuntimes: f.registry,
      canRefreshCredentials: () => true,
      hasBootstrapMarker: async () => true,
      sessionExists: async () => true,
      runGit,
      runSetup,
    };
    for (const token of ['github-original', 'github-renewed']) {
      const result = await applySessionAttach(
        identity,
        {
          kilo: auth,
          git: { url: 'https://github.com/acme/repo.git', token, platform: 'github' },
          env: { GH_TOKEN: 'profile-override' },
          setupCommands: ['do-not-repeat'],
        },
        deps
      );
      expect(result).toEqual({ ok: true, result: { attached: true } });
      expect(runGit).toHaveBeenLastCalledWith(
        ['remote', 'set-url', 'origin', `https://x-access-token:${token}@github.com/acme/repo.git`],
        identity.directory,
        expect.any(AbortSignal)
      );
    }
    expect(f.registry.get(identity.directory)?.env.GH_TOKEN).toBe('profile-override');
    expect(f.startServer).toHaveBeenCalledTimes(1);
    expect(f.close).not.toHaveBeenCalled();
    expect(runSetup).not.toHaveBeenCalled();
  });

  it('reattaches with fresh managed tokens after an active sibling becomes idle', async () => {
    const f = fixture();
    const runtime = await f.attach();
    await f.attach(auth, originalEnv, sibling);
    const runGit = vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 }));
    let idle = false;
    const deps = {
      kiloRuntimes: f.registry,
      canRefreshCredentials: () => idle,
      hasBootstrapMarker: async () => true,
      sessionExists: async () => true,
      runGit,
    };
    const payload = {
      kilo: { ...auth, token: 'real-kilo-renewed' },
      git: { url: 'https://github.com/acme/repo.git', token: 'github-renewed', platform: 'github' },
      env: { ...originalEnv, GH_TOKEN: 'github-renewed' },
    };
    expect(await applySessionAttach(identity, payload, deps)).toMatchObject({
      ok: false,
      error: { code: 'session_busy', retryable: true },
    });
    expect(f.close).not.toHaveBeenCalled();
    expect(runGit).not.toHaveBeenCalled();
    idle = true;
    expect(await applySessionAttach(identity, payload, deps)).toEqual({
      ok: true,
      result: { attached: true },
    });
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(runtime.env.GH_TOKEN).toBe('github-renewed');
    expect(runtime.env.KILOCODE_TOKEN).toBe('real-kilo-renewed');
    expect(runGit).toHaveBeenCalledTimes(1);
    expect(directoryForSession(sibling.kiloSessionId)).toBe(identity.directory);
  });

  it('wires handler task and activity guards without aborting active sibling work', async () => {
    const f = fixture();
    const runtime = await f.attach();
    await f.attach(auth, originalEnv, sibling);
    const activity = createSessionActivityRegistry();
    activity.attach(identity.kiloSessionId);
    activity.attach(sibling.kiloSessionId);
    activity.markActive(sibling.kiloSessionId);
    const deps: HandlerDeps = createControlHandlerDeps({
      kiloRuntimes: f.registry,
      version: 'test',
      kiloReady: true,
      sessions: [],
      activity,
      emitSessionEvent: vi.fn(),
      retireRuntime: vi.fn(),
      applyAttach: (session, payload, options) =>
        applySessionAttach(session, payload, {
          ...options,
          hasBootstrapMarker: async () => true,
          sessionExists: async () => true,
        }),
    });
    const held = Promise.withResolvers<ControlHandlerResult>();
    const runtimeLifetime = new AbortController();
    const fakeRuntime = {
      directory: sibling.directory,
      scopeId: 'fake',
      env: {},
      kiloClient: {
        sendPrompt: () => held.promise,
        abortSession: async () => true,
        getSessionDetails: async (id: string) => ({ id }),
      },
      signal: runtimeLifetime.signal,
    };
    const getRuntime = f.registry.get.bind(f.registry);
    f.registry.get = directory =>
      directory === sibling.directory ? (fakeRuntime as typeof runtime) : getRuntime(directory);
    const siblingOp = deps.operations.start(
      sibling,
      undefined,
      {
        operation: 'session.prompt',
        payload: {
          messageId: 'active-sibling-message',
          turn: { type: 'prompt', prompt: 'block' },
          agent: { mode: 'code', model: 'kilo/test' },
        },
        runtime: fakeRuntime as any,
      },
      { emitSessionEvent: () => {} }
    );
    const payload = { kilo: auth, env: { ...originalEnv, GH_TOKEN: 'github-renewed' } };
    expect(await handleControlRequest('session.attach', identity, payload, deps)).toMatchObject({
      ok: false,
      error: { code: 'session_busy', retryable: true },
    });
    expect(siblingOp.signal.aborted).toBe(false);
    expect(runtime.signal.aborted).toBe(false);
    expect(f.close).not.toHaveBeenCalled();
    // Remove the sibling operation (equivalent to old deps.tasks.delete)
    siblingOp.cancel('test-cleanup', 'cancelled');
    held.resolve({ ok: true, result: {} });
    await siblingOp.done.catch(() => {});
    f.registry.get = getRuntime;
    // Operation completion reconciles activity to idle; restore active state
    // to match the original test which only removed the task without touching activity
    activity.markActive(sibling.kiloSessionId);
    expect(await handleControlRequest('session.attach', identity, payload, deps)).toMatchObject({
      ok: false,
      error: { code: 'session_busy', retryable: true },
    });
    expect(f.close).not.toHaveBeenCalled();
    activity.observeEvent('session.idle', sibling.kiloSessionId, sibling.kiloSessionId, {});
    expect(await handleControlRequest('session.attach', identity, payload, deps)).toEqual({
      ok: true,
      result: { attached: true },
    });
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(runtime.env.GH_TOKEN).toBe('github-renewed');
    runtimeLifetime.abort();
  });

  it('fails attach instead of accepting stale Git auth when origin refresh fails', async () => {
    const f = fixture();
    expect(
      await applySessionAttach(
        identity,
        {
          kilo: auth,
          git: {
            url: 'https://github.com/acme/repo.git',
            token: 'github-renewed',
            platform: 'github',
          },
          env: originalEnv,
        },
        {
          kiloRuntimes: f.registry,
          canRefreshCredentials: () => true,
          hasBootstrapMarker: async () => true,
          runGit: async () => ({ stdout: '', stderr: 'failed', exitCode: 1 }),
        }
      )
    ).toMatchObject({
      ok: false,
      error: { message: 'Worktree Git credential refresh failed', retryable: true },
    });
  });
});
