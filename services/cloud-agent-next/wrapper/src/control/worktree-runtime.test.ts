import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildWorktreeKiloEnvironment,
  createWorktreeKiloRuntimes,
  isRetirementReportCurrent,
  startWorktreeKiloServer,
  type RootRuntimeRetirement,
  type WorktreeKiloAuth,
  type WorktreeKiloRuntimes,
} from './worktree-runtime';
import type { NativeRetirement } from './session-operation-cleanup';
import type { OwnedProcessScope } from './owned-processes';
import {
  SANDBOX_CONTROL_RECOVERY_MAX_ATTEMPTS,
  SANDBOX_CONTROL_CLEANUP_TIMEOUT_MS,
  SANDBOX_CONTROL_EXECUTION_TIMEOUT_MS,
  sessionMessageOutcomeSchema,
  type SessionEventIdentity,
  type SessionRequestIdentity,
} from '../../../src/shared/sandbox-control-protocol';
import {
  buildHeartbeatPayload,
  createControlHandlerDeps,
  handleControlRequest,
  type HandlerDeps,
} from './sandbox-control-handlers';
import type { WrapperKiloClient } from '../kilo-api';
import {
  ControlTerminalRuntimeError,
  createControlTerminalRuntime,
  type ControlTerminalRuntime,
} from './terminal-runtime';
import { applySessionAttach, type ApplyAttachDeps } from './apply-attach';
import { childFromSessionCreated, eventKiloSessionId, sessionEventIdentity } from './feed';
import { operationAuthorization } from './control-test-fixtures';
import {
  directoryForSession,
  rememberChildSession,
  rememberAttachedRoot,
  resetSessionDirectoryState,
  rootForSession,
} from './session-directories';

const auth: WorktreeKiloAuth = {
  scopeId: 'worktree_a',
  token: 'opaque-guest-a',
  targets: {
    backendBaseUrl: 'https://backend.example.test/a',
    providerBaseUrl: 'https://provider.example.test/a',
    sessionIngestBaseUrl: 'https://ingest.example.test/a',
  },
};

const bitbucketMetadata = {
  KILO_BITBUCKET_WORKSPACE_SLUG: 'acme-workspace',
  KILO_BITBUCKET_REPOSITORY_SLUG: 'widgets',
  KILO_BITBUCKET_WORKSPACE_UUID: '{33333333-3333-4333-8333-333333333333}',
  KILO_BITBUCKET_REPOSITORY_UUID: '{11111111-1111-4111-8111-111111111111}',
};

const inherited = {
  PATH: process.env.PATH,
  HOME: '/home/shared',
  XDG_DATA_HOME: '/home/shared/data',
  KILOCODE_TOKEN: 'actual-managed-kilo-token',
  KILOCODE_TOKEN_FILE: '/actual-managed-token-file',
  KILO_AUTH_CONTENT: JSON.stringify({ kilo: { type: 'api', key: 'actual-managed-auth-token' } }),
  KILO_CONFIG_CONTENT: JSON.stringify({
    provider: { kilo: { options: { apiKey: 'actual-managed-api-key' } } },
  }),
  OPENCODE_CONFIG_CONTENT: 'actual-managed-config',
  KILO_CONFIG: '/actual-managed-config-file',
  OPENCODE_CONFIG_DIR: '/actual-managed-config-directory',
  GH_TOKEN: 'actual-managed-github-token',
  GITHUB_TOKEN: 'actual-managed-github-token',
  SANDBOX_CONTROL_CREDENTIAL: 'actual-control-credential',
};

let tmpDir: string;
const registries: WorktreeKiloRuntimes[] = [];
const terminalRuntimes: ControlTerminalRuntime[] = [];
const servers: ReturnType<typeof createKiloStub>[] = [];
const aborts: AbortController[] = [];

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Condition timed out');
    await Bun.sleep(10);
  }
}

async function rejected(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  throw new Error('Expected runtime operation to fail');
}

function asFetch(
  fn: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>
): typeof fetch {
  return Object.assign(fn, { preconnect: fetch.preconnect });
}

function createKiloStub(
  health: unknown = { healthy: true, version: '7.4.20' },
  statuses: Record<string, { type: string }> = {}
) {
  const requests: Array<{ pathname: string; directory: string | null; body?: unknown }> = [];
  const permissions: Awaited<ReturnType<WrapperKiloClient['getPermissions']>> = [];
  const sessionStatuses: Record<string, { type: string }> = { ...statuses };
  const feeds = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const encoder = new TextEncoder();
  let feedConnections = 0;
  const heldPrompts = new Map<string, PromiseWithResolvers<void>>();
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/global/event') {
        feedConnections += 1;
        let feed: ReadableStreamDefaultController<Uint8Array> | undefined;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              feed = controller;
              feeds.add(controller);
              controller.enqueue(
                encoder.encode('data: {"payload":{"type":"server.connected","properties":{}}}\n\n')
              );
            },
            cancel() {
              if (feed) feeds.delete(feed);
            },
          }),
          { headers: { 'Content-Type': 'text/event-stream' } }
        );
      }
      const text = await request.text();
      const body = text ? (JSON.parse(text) as Record<string, unknown>) : undefined;
      requests.push({
        pathname: url.pathname,
        directory:
          url.searchParams.get('directory') ??
          decodeURIComponent(request.headers.get('x-kilo-directory') ?? ''),
        ...(body ? { body } : {}),
      });
      if (request.method === 'GET' && url.pathname === '/global/health')
        return Response.json(health);
      if (request.method === 'GET' && url.pathname === '/permission') {
        return Response.json(permissions);
      }
      if (request.method === 'GET' && url.pathname === '/session/status')
        return Response.json(sessionStatuses);
      if (request.method === 'GET' && url.pathname === '/pty') return Response.json([]);
      if (request.method === 'POST' && url.pathname.startsWith('/permission/')) {
        const id = decodeURIComponent(url.pathname.split('/')[2]);
        const index = permissions.findIndex(permission => permission.id === id);
        if (index === -1) return new Response('Permission not pending', { status: 404 });
        permissions.splice(index, 1);
        return Response.json(true);
      }
      if (request.method === 'POST' && url.pathname.endsWith('/abort')) {
        const sessionId = decodeURIComponent(url.pathname.split('/')[2] ?? '');
        heldPrompts.get(sessionId)?.resolve();
        return Response.json(true);
      }
      if (request.method === 'POST' && /\/session\/[^/]+\/(message|command)$/.test(url.pathname)) {
        const sessionId = decodeURIComponent(url.pathname.split('/')[2] ?? '');
        const directory = requests.at(-1)?.directory ?? '';
        const completion: Awaited<ReturnType<WrapperKiloClient['sendPrompt']>> = {
          info: {
            id: `assistant_${String(body?.messageID)}`,
            sessionID: decodeURIComponent(url.pathname.split('/')[2]),
            parentID: String(body?.messageID),
            role: 'assistant',
            time: { created: 1, completed: 2 },
            modelID: 'test',
            providerID: 'kilo',
            mode: 'code',
            agent: 'code',
            path: { cwd: directory, root: directory },
            cost: 0,
            tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
          },
          parts: [],
        };
        await heldPrompts.get(sessionId)?.promise;
        return Response.json(completion);
      }
      if (request.method === 'GET' && url.pathname.startsWith('/session/')) {
        return Response.json({
          id: decodeURIComponent(url.pathname.slice('/session/'.length)),
          directory: url.searchParams.get('directory'),
        });
      }
      if (request.method === 'POST' && url.pathname === '/pty') {
        return Response.json({
          id: `pty_${crypto.randomUUID()}`,
          title: 'Workspace terminal',
          command: '/bin/sh',
          args: [],
          cwd: body?.cwd,
          status: 'running',
          pid: 1,
        });
      }
      return Response.json({});
    },
  });
  return {
    url: server.url.toString(),
    requests,
    permissions,
    sessionStatuses,
    get feedConnections() {
      return feedConnections;
    },
    emit(event: unknown) {
      for (const feed of feeds) feed.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
    },
    holdPrompts(sessionId: string) {
      heldPrompts.set(sessionId, Promise.withResolvers<void>());
    },
    releasePrompts(sessionId: string) {
      heldPrompts.get(sessionId)?.resolve();
    },
    endFeeds() {
      for (const feed of feeds) feed.close();
      feeds.clear();
    },
    stop: () => server.stop(true),
  };
}

function rootIdentity(directory: string, name = path.basename(directory)): SessionRequestIdentity {
  return { sessionId: `workspace_${name}`, kiloSessionId: `root_${name}`, directory };
}

function proveOwnedProcesses(
  options: Parameters<typeof startWorktreeKiloServer>[0],
  stopped?: Promise<unknown>
): void {
  options.onProcessScope?.({
    stop: async () => {
      await stopped;
      return true;
    },
  } as unknown as OwnedProcessScope);
}

function createRegistry(
  overrides: Partial<Parameters<typeof createWorktreeKiloRuntimes>[0]> = {},
  isolation: 'per-session' | 'directory-shared' = 'per-session'
) {
  const launches: Array<Parameters<typeof startWorktreeKiloServer>[0]> = [];
  let closes = 0;
  let unexpectedCloses = 0;
  const registry = createWorktreeKiloRuntimes({
    homeRoot: path.join(tmpDir, 'homes'),
    inheritedEnv: inherited,
    startServer: async options => {
      launches.push(options);
      const server = createKiloStub();
      servers.push(server);
      options.onProcessScope?.({ stop: async () => true } as unknown as OwnedProcessScope);
      return {
        url: server.url,
        close: () => {
          closes += 1;
        },
      };
    },
    onUnexpectedClose: () => {
      unexpectedCloses += 1;
    },
    ...overrides,
  });
  registries.push(registry);
  return {
    registry: {
      ...registry,
      attach(
        identity: SessionRequestIdentity,
        kilo: WorktreeKiloAuth,
        env?: Record<string, string>,
        canRefreshCredentials?: () => boolean
      ) {
        return registry.attach(identity, kilo, env, canRefreshCredentials, isolation);
      },
      get kiloCliVersion() {
        return registry.kiloCliVersion;
      },
      async ensure(directory: string, kilo: WorktreeKiloAuth, env?: Record<string, string>) {
        const attachment = registry.attach(
          rootIdentity(directory),
          kilo,
          env,
          undefined,
          isolation
        );
        try {
          const runtime = await attachment.ready;
          attachment.commit();
          return runtime;
        } finally {
          attachment.release();
        }
      },
    },
    rawRegistry: registry,
    launches,
    get closes() {
      return closes;
    },
    get unexpectedCloses() {
      return unexpectedCloses;
    },
  };
}

function createSharedRegistry(
  overrides: Partial<Parameters<typeof createWorktreeKiloRuntimes>[0]> = {}
) {
  return createRegistry(overrides, 'directory-shared');
}

function createHandlerDeps(registry: WorktreeKiloRuntimes): HandlerDeps {
  const terminalRuntime = createControlTerminalRuntime({
    controlUrl: 'ws://127.0.0.1:1/sandbox-control/test',
    wrapperInstanceId: crypto.randomUUID(),
    getKiloRuntime: identity => registry.get(identity),
  });
  terminalRuntimes.push(terminalRuntime);
  return createControlHandlerDeps({
    kiloRuntimes: registry,
    terminalRuntime,
    version: 'test',
    kiloReady: true,
    sessions: [],
    emitSessionEvent: () => {},
    retireRuntime: () => {},
  });
}

function createIntegratedRegistry(
  overrides: Partial<Parameters<typeof createWorktreeKiloRuntimes>[0]> = {}
) {
  const context: { handlerDeps?: HandlerDeps } = {};
  const settlements: RootRuntimeRetirement[] = [];
  const harness = createSharedRegistry({
    onRootRetirementStarted: attempt => {
      context.handlerDeps?.operations.markRootRetirementStarted(attempt);
    },
    onRootRetirement: settlement => {
      settlements.push(settlement);
      context.handlerDeps?.operations.settleRootPublication(settlement);
    },
    onRootDisappeared: disappearance =>
      context.handlerDeps?.operations.notifyRootDisappeared(disappearance),
    ...overrides,
  });
  const dependencies = createHandlerDeps(harness.registry);
  context.handlerDeps = dependencies;
  return { ...harness, handlerDeps: dependencies, settlements };
}

beforeEach(() => {
  resetSessionDirectoryState();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-kilo-test-'));
});

afterEach(async () => {
  for (const abort of aborts.splice(0)) abort.abort();
  for (const terminal of terminalRuntimes.splice(0)) terminal.shutdown();
  for (const registry of registries.splice(0)) registry.shutdown();
  await Promise.all(servers.splice(0).map(server => server.stop()));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('observed Kilo runtime version', () => {
  it('ignores a delayed health response from a retired Kilo process', async () => {
    const response = Promise.withResolvers<Response>();
    const requested = Promise.withResolvers<void>();
    const originalFetch = globalThis.fetch;
    let delayHealth = true;
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
      asFetch((request, init) => {
        const url = request instanceof Request ? request.url : String(request);
        if (delayHealth && new URL(url).pathname === '/global/health') {
          delayHealth = false;
          requested.resolve();
          return response.promise;
        }
        return originalFetch(request, init);
      })
    );
    const { registry } = createRegistry();
    try {
      const firstDirectory = path.join(tmpDir, 'first');
      await registry.ensure(firstDirectory, auth);
      await requested.promise;
      registry.detach(rootIdentity(firstDirectory));
      await registry.ensure(path.join(tmpDir, 'second'), { ...auth, scopeId: 'second' });
      await waitUntil(() => registry.kiloCliVersion === '7.4.20');
      response.resolve(Response.json({ healthy: true, version: '9.9.9' }));
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(registry.kiloCliVersion).toBe('7.4.20');
    } finally {
      response.resolve(Response.json({}));
      registry.shutdown();
      fetchSpy.mockRestore();
    }
  });
  it('reports health version in heartbeats without status-time probes and retains it after detach', async () => {
    const { registry } = createRegistry();
    const directory = path.join(tmpDir, 'runtime');
    const deps = createHandlerDeps(registry);
    expect(buildHeartbeatPayload(deps).kilo.version).toBeNull();
    await registry.ensure(directory, auth);
    await waitUntil(() => registry.kiloCliVersion === '7.4.20');
    for (let i = 0; i < 3; i++) {
      expect(buildHeartbeatPayload(deps).kilo.version).toBe('7.4.20');
      await handleControlRequest('sandbox.status', undefined, {}, deps);
    }
    expect(
      servers[0].requests.filter(request => request.pathname === '/global/health')
    ).toHaveLength(1);
    registry.detach(rootIdentity(directory));
    expect(buildHeartbeatPayload(deps).kilo.version).toBe('7.4.20');
  });

  it.each([
    { healthy: true, version: '7.5.0' },
    { healthy: true, version: 'https://private.invalid/credential' },
    { healthy: false, version: '7.4.20' },
    {},
  ])(
    'does not report one version for inconsistent or unavailable health: %j',
    async secondHealth => {
      let count = 0;
      const { registry } = createRegistry({
        startServer: async options => {
          proveOwnedProcesses(options);
          const server = createKiloStub(
            count++ === 0 ? { healthy: true, version: '7.4.20' } : secondHealth
          );
          servers.push(server);
          return { url: server.url, close() {} };
        },
      });
      await registry.ensure(path.join(tmpDir, 'one'), auth);
      await waitUntil(() => registry.kiloCliVersion === '7.4.20');
      await registry.ensure(path.join(tmpDir, 'two'), { ...auth, scopeId: 'worktree_two' });
      await waitUntil(() => registry.kiloCliVersion === null);
      expect(buildHeartbeatPayload(createHandlerDeps(registry)).kilo.version).toBeNull();
      expect(registry.isHealthy()).toBe(true);
    }
  );
});

describe('retirement report ownership', () => {
  it('only permits shutdown when the retired entry is still current', () => {
    const retiredRuntimeId = 'retired-runtime';

    expect(isRetirementReportCurrent(undefined, retiredRuntimeId)).toBe(true);
    expect(isRetirementReportCurrent(retiredRuntimeId, retiredRuntimeId)).toBe(true);
    expect(isRetirementReportCurrent('replacement-runtime', retiredRuntimeId)).toBe(false);
  });

  it('exposes a replacement entry while startup is pending', async () => {
    const replacementStarted = Promise.withResolvers<void>();
    const releaseReplacement = Promise.withResolvers<void>();
    const retirements: RootRuntimeRetirement[] = [];
    let launches = 0;
    const harness = createSharedRegistry({
      startServer: async options => {
        launches += 1;
        const server = createKiloStub();
        servers.push(server);
        options.onProcessScope?.({ stop: async () => true } as unknown as OwnedProcessScope);
        if (launches === 2) {
          replacementStarted.resolve();
          await releaseReplacement.promise;
        }
        return { url: server.url, close: () => {} };
      },
      onRootRetirement: retirement => retirements.push(retirement),
    });
    const directory = path.join(tmpDir, 'retirement-report-replacement');
    const firstIdentity = rootIdentity(directory, 'first');
    const siblingIdentity = rootIdentity(directory, 'sibling');
    const first = harness.registry.attach(firstIdentity, auth);
    const runtime = await first.ready;
    first.commit();
    const sibling = harness.registry.attach(siblingIdentity, auth);
    await sibling.ready;
    sibling.commit();
    const retiredRuntimeId = runtime.runtimeId;
    try {
      expect(
        await harness.registry.retireRuntimeIfUnshared?.(
          directory,
          { runtimeId: retiredRuntimeId, client: runtime.kiloClient },
          firstIdentity.kiloSessionId,
          Date.now() + 1_000,
          'event rejected'
        )
      ).toBe('shared');
      expect(harness.registry.detach(siblingIdentity)).toBe(true);
      await waitUntil(() => retirements.some(retirement => retirement.result === 'retired'));
      expect(harness.registry.getEntryRuntimeId?.(directory)).toBeUndefined();

      const replacement = harness.registry.attach(rootIdentity(directory, 'replacement'), auth);
      await replacementStarted.promise;
      const replacementRuntimeId = harness.registry.getEntryRuntimeId?.(directory);
      expect(replacementRuntimeId).toBeDefined();
      expect(replacementRuntimeId).not.toBe(retiredRuntimeId);
      expect(harness.registry.get(directory)).toBeUndefined();
      expect(isRetirementReportCurrent(replacementRuntimeId, retiredRuntimeId)).toBe(false);
      expect(replacement.signal.aborted).toBe(false);

      releaseReplacement.resolve();
      const replacementRuntime = await replacement.ready;
      replacement.commit();
      replacement.release();
      expect(harness.registry.getEntryRuntimeId?.(directory)).toBe(replacementRuntime.runtimeId);
      expect(harness.registry.get(directory)).toBe(replacementRuntime);
      expect(replacement.signal.aborted).toBe(false);
      const completion = await replacementRuntime.kiloClient.sendPrompt({
        sessionId: 'root_replacement',
        messageId: 'replacement_message',
        prompt: 'complete replacement work',
      });
      expect(completion.info.parentID).toBe('replacement_message');
    } finally {
      releaseReplacement.resolve();
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  });
});

describe('worktree Kilo environments', () => {
  it.each([undefined, 'org-trusted'])(
    'uses only trusted organization attribution: %s',
    organizationId => {
      const env = buildWorktreeKiloEnvironment(
        '/workspace/a',
        '/home/a',
        { ...auth, token: 'real-kilo-token', organizationId },
        { KILOCODE_ORGANIZATION_ID: 'profile-org' },
        { KILOCODE_ORGANIZATION_ID: 'inherited-org' }
      );
      if (organizationId) expect(env.KILOCODE_ORGANIZATION_ID).toBe(organizationId);
      else expect(env).not.toHaveProperty('KILOCODE_ORGANIZATION_ID');
      expect(JSON.parse(env.KILO_CONFIG_CONTENT).provider.kilo.options).toEqual({
        apiKey: 'real-kilo-token',
        kilocodeToken: 'real-kilo-token',
        baseURL: auth.targets.providerBaseUrl,
        ...(organizationId ? { kilocodeOrganizationId: organizationId } : {}),
      });
      expect(env.KILO_CONFIG_CONTENT).toBe(env.OPENCODE_CONFIG_CONTENT);
    }
  );

  it('retains only the four trusted Bitbucket metadata keys from the attachment', () => {
    const env = buildWorktreeKiloEnvironment(
      '/workspace/a',
      '/home/a',
      auth,
      {
        ...bitbucketMetadata,
        BITBUCKET_TOKEN: 'opaque-bitbucket-token',
        KILO_BITBUCKET_INTEGRATION_ID: 'actual-managed-integration',
        KILO_BITBUCKET_TOKEN: 'actual-managed-token',
        KILO_BITBUCKET_WORKSPACE_SLUG_EXTRA: 'actual-managed-override',
        KILO_CONFIG_CONTENT: 'actual-managed-config',
        OPENCODE_CONFIG_CONTENT: 'actual-managed-config',
        SANDBOX_CONTROL_CREDENTIAL: 'actual-control-credential',
      },
      inherited
    );

    expect(env).toMatchObject({
      ...bitbucketMetadata,
      BITBUCKET_TOKEN: 'opaque-bitbucket-token',
      KILOCODE_TOKEN: auth.token,
    });
    expect(
      Object.keys(env)
        .filter(name => name.startsWith('KILO_BITBUCKET_'))
        .sort()
    ).toEqual(Object.keys(bitbucketMetadata).sort());
    expect(JSON.stringify(env)).not.toContain('actual-');
    expect(JSON.parse(env.KILO_AUTH_CONTENT)).toEqual({ kilo: { type: 'api', key: auth.token } });
    expect(env.KILO_CONFIG_CONTENT).toBe(env.OPENCODE_CONFIG_CONTENT);
    expect(
      buildWorktreeKiloEnvironment(
        '/workspace/other',
        '/home/other',
        auth,
        {},
        {
          ...inherited,
          ...bitbucketMetadata,
        }
      )
    ).not.toHaveProperty('KILO_BITBUCKET_WORKSPACE_SLUG');
  });

  it('rebuilds all auth surfaces from the guest token and targets without managed credentials', () => {
    const environment = {
      CUSTOM_VALUE: 'profile-value',
      GH_TOKEN: 'opaque-github-credential',
      KILOCODE_TOKEN: 'actual-attachment-token',
      KILO_AUTH_CONTENT: 'actual-attachment-auth',
      KILO_CONFIG_CONTENT: 'actual-attachment-config',
      OPENCODE_CONFIG_CONTENT: 'actual-attachment-config',
      KILO_SESSION_INGEST_URL: 'https://wrong.example.test',
      HOME: '/wrong-home',
      XDG_DATA_HOME: '/wrong-data',
    };
    const env = buildWorktreeKiloEnvironment(
      '/workspace/a',
      '/home/worktree-a',
      auth,
      environment,
      inherited
    );

    expect(env).toMatchObject({
      CUSTOM_VALUE: 'profile-value',
      GH_TOKEN: 'opaque-github-credential',
      PWD: '/workspace/a',
      HOME: '/home/worktree-a',
      XDG_DATA_HOME: '/home/worktree-a/.local/share',
      XDG_CONFIG_HOME: '/home/worktree-a/.config',
      XDG_CACHE_HOME: '/home/worktree-a/.cache',
      KILOCODE_TOKEN: auth.token,
      KILO_API_URL: auth.targets.backendBaseUrl,
      KILOCODE_BACKEND_BASE_URL: auth.targets.backendBaseUrl,
      KILO_OPENROUTER_BASE: auth.targets.providerBaseUrl,
      KILO_SESSION_INGEST_URL: auth.targets.sessionIngestBaseUrl,
    });
    expect(JSON.parse(env.KILO_AUTH_CONTENT)).toEqual({ kilo: { type: 'api', key: auth.token } });
    expect(JSON.parse(env.KILO_CONFIG_CONTENT)).toMatchObject({
      autoupdate: false,
      provider: {
        kilo: {
          options: {
            apiKey: auth.token,
            kilocodeToken: auth.token,
            baseURL: auth.targets.providerBaseUrl,
          },
        },
      },
    });
    expect(env.OPENCODE_CONFIG_CONTENT).toBe(env.KILO_CONFIG_CONTENT);
    for (const name of [
      'SANDBOX_CONTROL_CREDENTIAL',
      'KILOCODE_TOKEN_FILE',
      'KILO_CONFIG',
      'OPENCODE_CONFIG_DIR',
      'GITHUB_TOKEN',
    ]) {
      expect(env).not.toHaveProperty(name);
    }
    expect(JSON.stringify(env)).not.toContain('actual-');
    expect(inherited.KILOCODE_TOKEN).toBe('actual-managed-kilo-token');
    expect(environment.KILOCODE_TOKEN).toBe('actual-attachment-token');
  });
});

describe('worktree Kilo runtime registry', () => {
  it('waits for exit, gates replacement, and preserves a recovery acknowledgement', async () => {
    const stopped = Promise.withResolvers<void>();
    const directory = path.join(tmpDir, 'recovery');
    const identity = rootIdentity(directory);
    const stub = createKiloStub(undefined, { [identity.kiloSessionId]: { type: 'idle' } });
    const replacementStub = createKiloStub(undefined, {
      [identity.kiloSessionId]: { type: 'idle' },
    });
    servers.push(stub);
    servers.push(replacementStub);
    let closes = 0;
    let starts = 0;
    const { rawRegistry } = createRegistry({
      startServer: async () => {
        if (starts++ > 0) return { url: replacementStub.url, close: () => {} };
        return {
          url: stub.url,
          stopped: stopped.promise,
          close: () => {
            closes += 1;
          },
        };
      },
    });
    const attachment = rawRegistry.attach(identity, auth, undefined, undefined, 'per-session');
    const runtime = await attachment.ready;
    attachment.commit();
    const recoveryId = '11111111-1111-4111-8111-111111111111';
    const retirement = rawRegistry.retireForRecovery(identity, recoveryId, () => {});
    await waitUntil(() => closes === 1);
    expect(rawRegistry.get(identity)).toBeUndefined();
    expect(() => rawRegistry.attach(identity, auth, undefined, undefined, 'per-session')).toThrow(
      'Kilo runtime is retiring'
    );
    stopped.resolve();
    await retirement;

    const fresh = rawRegistry.attach(identity, auth, undefined, undefined, 'per-session');
    const freshRuntime = await fresh.ready;
    fresh.commit();
    await rawRegistry.retireForRecovery(identity, recoveryId, () => {
      throw new Error('Recovery acknowledgement must win');
    });
    expect(freshRuntime.signal.aborted).toBe(false);
    expect(runtime.signal.aborted).toBe(true);
    fresh.release();
    attachment.release();
  });

  it('acknowledges an absent root without affecting a sibling or a later attachment', async () => {
    const directory = path.join(tmpDir, 'cold-recovery');
    const absent = rootIdentity(directory, 'absent');
    const sibling = rootIdentity(directory, 'sibling');
    const stub = createKiloStub(undefined, {
      [absent.kiloSessionId]: { type: 'idle' },
      [sibling.kiloSessionId]: { type: 'idle' },
    });
    servers.push(stub);
    const { rawRegistry } = createRegistry({
      startServer: async () => ({ url: stub.url, close: () => {} }),
    });
    const siblingAttachment = rawRegistry.attach(
      sibling,
      auth,
      undefined,
      undefined,
      'per-session'
    );
    const siblingRuntime = await siblingAttachment.ready;
    siblingAttachment.commit();
    const recoveryId = '22222222-2222-4222-8222-222222222222';
    expect(await rawRegistry.retireForRecovery(absent, recoveryId, () => {})).toBe('absent');
    expect(rawRegistry.get(sibling)).toBe(siblingRuntime);

    const pending = rawRegistry.attach(absent, auth, undefined, undefined, 'per-session');
    expect(
      await rejected(
        rawRegistry.retireForRecovery(absent, '33333333-3333-4333-8333-333333333333', () => {})
      )
    ).toMatchObject({ code: 'session_busy' });
    const freshRuntime = await pending.ready;
    pending.commit();
    expect(await rawRegistry.retireForRecovery(absent, recoveryId, () => {})).toBe('acknowledged');
    expect(freshRuntime.signal.aborted).toBe(false);
    pending.release();
    siblingAttachment.release();
  });

  it('defaults missing runtime isolation to a directory-shared runtime', async () => {
    const { rawRegistry, launches } = createRegistry();
    const directory = path.join(tmpDir, 'legacy-shared');
    const firstIdentity = rootIdentity(directory, 'first');
    const secondIdentity = rootIdentity(directory, 'second');
    const first = rawRegistry.attach(firstIdentity, auth);
    const second = rawRegistry.attach(secondIdentity, auth);
    try {
      const [firstRuntime, secondRuntime] = await Promise.all([first.ready, second.ready]);
      first.commit();
      second.commit();
      expect(secondRuntime).toBe(firstRuntime);
      expect(firstRuntime.isolation).toBe('directory-shared');
      expect(launches).toHaveLength(1);
      expect(rawRegistry.detach(firstIdentity)).toBe(true);
      expect(secondRuntime.signal.aborted).toBe(false);
      expect(rawRegistry.get(secondIdentity)).toBe(secondRuntime);
    } finally {
      first.release();
      second.release();
    }
  });

  it('starts lazily and reuses one server and feed for concurrent same-worktree roots', async () => {
    const { registry, launches } = createRegistry();
    const directory = path.join(tmpDir, 'worktree-a');
    expect(launches).toEqual([]);
    expect(registry.get(rootIdentity(directory))).toBeUndefined();

    const [first, second, third] = await Promise.all([
      registry.ensure(directory, auth),
      registry.ensure(directory, auth),
      registry.ensure(directory, { ...auth, targets: { ...auth.targets } }),
    ]);
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(await registry.ensure(directory, auth)).toBe(first);
    expect(registry.get(rootIdentity(directory))).toBe(first);
    expect(launches).toHaveLength(1);
    expect(servers[0]?.feedConnections).toBe(1);

    await Promise.all(
      ['root_one', 'root_two'].map(sessionId =>
        first.kiloClient.sendPromptAsync({
          sessionId,
          messageId: `message_${sessionId}`,
          prompt: sessionId,
        })
      )
    );
    expect(servers[0]?.requests.map(request => request.pathname).sort()).toEqual([
      '/global/health',
      '/session/root_one/prompt_async',
      '/session/root_two/prompt_async',
    ]);
    expect(servers[0]?.requests.every(request => request.directory === directory)).toBe(true);
    expect(servers[0]?.requests.map(request => request.body)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ messageID: 'message_root_one' }),
        expect.objectContaining({ messageID: 'message_root_two' }),
      ])
    );
  });

  it('uses the real SDK timeout-free fetch for global SSE with runtime-owned cancellation', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch');
    const harness = createRegistry();
    try {
      const runtime = await harness.registry.ensure(path.join(tmpDir, 'worktree-sse'), auth);
      const sseCalls = fetchSpy.mock.calls.filter(
        ([request]) =>
          request instanceof Request && new URL(request.url).pathname === '/global/event'
      );
      expect(sseCalls).toHaveLength(1);
      const [request, init] = sseCalls[0];
      if (!(request instanceof Request)) throw new Error('Expected SDK SSE request');
      expect(init).toMatchObject({ duplex: 'half', timeout: false });
      expect(new URL(request.url).searchParams.get('directory')).toBe(runtime.directory);
      expect(request.signal.aborted).toBe(false);
      expect(runtime.signal.aborted).toBe(false);
      expect(harness.registry.isHealthy()).toBe(true);
      harness.registry.shutdown();
      expect(request.signal.aborted).toBe(true);
      expect(runtime.signal.aborted).toBe(true);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(harness.unexpectedCloses).toBe(0);
    } finally {
      harness.registry.shutdown();
      fetchSpy.mockRestore();
    }
  });

  it.each(['stream-error', 'feed-end', 'reconnect'] as const)(
    'retires real SDK SSE %s only after bounded observer recovery fails',
    async failure => {
      const connected = 'data: {"payload":{"type":"server.connected","properties":{}}}\n\n';
      const encoder = new TextEncoder();
      const opened = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(connected));
            opened.resolve(controller);
          },
        }),
        { headers: { 'Content-Type': 'text/event-stream' } }
      );
      const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
        asFetch(async request => {
          const url = request instanceof Request ? request.url : String(request);
          return new URL(url).pathname === '/global/health'
            ? Response.json({ healthy: true, version: '7.4.20' })
            : response;
        })
      );
      const failures: unknown[] = [];
      const harness = createRegistry({ onUnexpectedClose: error => failures.push(error) });
      try {
        const runtime = await harness.registry.ensure(path.join(tmpDir, 'worktree-sse'), auth);
        const stream = await opened.promise;
        if (failure === 'stream-error') stream.error(new Error('private-stream-credential'));
        else if (failure === 'feed-end') stream.close();
        else stream.enqueue(encoder.encode(connected));
        await waitUntil(() => failures.length > 0);
        expect(failures).toEqual([
          expect.objectContaining({
            directory: runtime.directory,
            reason:
              failure === 'stream-error'
                ? 'feed_failed'
                : failure === 'feed-end'
                  ? 'feed_ended'
                  : 'feed_reconnected',
            cleanup: 'confirmed',
            runtimeId: expect.any(String),
          }),
        ]);
        expect(runtime.signal.aborted).toBe(true);
        expect(harness.registry.isHealthy()).toBe(true);
        expect(harness.registry.getRetained?.(runtime.directory)).toBeUndefined();
        expect(
          fetchSpy.mock.calls.filter(
            ([request]) =>
              request instanceof Request && new URL(request.url).pathname === '/global/event'
          )
        ).toHaveLength(1 + SANDBOX_CONTROL_RECOVERY_MAX_ATTEMPTS);
      } finally {
        harness.registry.shutdown();
        fetchSpy.mockRestore();
      }
    }
  );

  it('refreshes direct credentials only for their identity after intentional old-process shutdown', async () => {
    const received: string[] = [];
    const harness = createRegistry({
      startServer: async options => {
        const server = createKiloStub();
        servers.push(server);
        const stopped = Promise.withResolvers<void>();
        proveOwnedProcesses(options, stopped.promise);
        return {
          url: server.url,
          stopped: stopped.promise,
          close: () => {
            server.endFeeds();
            stopped.resolve();
          },
        };
      },
      onEvent: (_runtime, event) => received.push(event.type),
    });
    const directAuth = { ...auth, containmentEnabled: false };
    const identity = rootIdentity(path.join(tmpDir, 'shared'));
    const siblingIdentity = rootIdentity(identity.directory, 'sibling');
    const first = harness.registry.attach(identity, directAuth);
    const runtime = await first.ready;
    const cleanupOriginal = first.cleanup
      ? (deadlineAt: number) => first.cleanup?.(deadlineAt)
      : undefined;
    first.commit();
    first.release();
    const siblingAttachment = harness.registry.attach(siblingIdentity, directAuth);
    const sibling = await siblingAttachment.ready;
    siblingAttachment.commit();
    siblingAttachment.release();
    const siblingClient = sibling.kiloClient;
    const originalClient = runtime.kiloClient;
    const originalRuntimeId = runtime.runtimeId;
    const refresh = harness.registry.attach(
      identity,
      { ...directAuth, token: 'rotated-token' },
      undefined,
      () => true
    );
    const refreshed = await refresh.ready;
    expect(refreshed).toBe(runtime);
    expect(refreshed.runtimeId).not.toBe(originalRuntimeId);
    expect(runtime.signal.aborted).toBe(false);
    expect(await cleanupOriginal?.(Date.now() + 1_000)).toBe('stale');
    expect(harness.registry.get(identity)).toBe(refreshed);
    refresh.commit();
    refresh.release();
    expect(runtime.kiloClient).not.toBe(originalClient);
    expect(sibling.kiloClient).toBe(siblingClient);
    expect(sibling.signal.aborted).toBe(false);
    expect(harness.registry.get(siblingIdentity)).toBe(sibling);
    expect(servers).toHaveLength(3);
    servers[2]?.emit({ payload: { type: 'server.heartbeat', properties: {} } });
    servers[2]?.emit({ payload: { type: 'session.updated', properties: {} } });
    await waitUntil(() => received.includes('session.updated'));
    expect(runtime.signal.aborted).toBe(false);
    expect(harness.registry.isHealthy()).toBe(true);
    expect(harness.registry.get(identity)).toBe(refreshed);
    expect(harness.unexpectedCloses).toBe(0);
    servers[1]?.endFeeds();
    await waitUntil(() => (servers[1]?.feedConnections ?? 0) === 2);
    expect(runtime.signal.aborted).toBe(false);
    expect(harness.registry.isHealthy()).toBe(true);
    expect(harness.registry.get(identity)).toBe(refreshed);
    expect(harness.unexpectedCloses).toBe(0);
  });

  it('isolates different worktrees with separate servers, homes, auth files, and event clients', async () => {
    const events: Array<{ directory: string; scopeId: string; type: string }> = [];
    const { registry, launches } = createRegistry({
      onEvent: (runtime, event) =>
        events.push({ directory: runtime.directory, scopeId: runtime.scopeId, type: event.type }),
    });
    const otherAuth = { ...auth, scopeId: 'worktree_b', token: 'opaque-guest-b' };
    const [first, second] = await Promise.all([
      registry.ensure(path.join(tmpDir, 'worktree-a'), auth),
      registry.ensure(path.join(tmpDir, 'worktree-b'), otherAuth),
    ]);
    expect(launches).toHaveLength(2);
    expect(first.kiloClient.serverUrl).not.toBe(second.kiloClient.serverUrl);
    for (const key of [
      'HOME',
      'XDG_DATA_HOME',
      'XDG_CONFIG_HOME',
      'XDG_CACHE_HOME',
      'XDG_STATE_HOME',
      'XDG_RUNTIME_DIR',
    ]) {
      expect(first.env[key]).not.toBe(second.env[key]);
    }
    for (const runtime of [first, second]) {
      const authPath = path.join(runtime.env.XDG_DATA_HOME, 'kilo', 'auth.json');
      expect(JSON.parse(fs.readFileSync(authPath, 'utf8'))).toEqual({
        kilo: { type: 'api', key: runtime.env.KILOCODE_TOKEN },
      });
      expect(fs.statSync(authPath).mode & 0o777).toBe(0o600);
      expect(JSON.stringify(runtime.env)).not.toContain('actual-');
    }
    expect(first.env.KILOCODE_TOKEN).toBe(auth.token);
    expect(second.env.KILOCODE_TOKEN).toBe(otherAuth.token);
    for (const server of servers)
      server.emit({ payload: { type: 'session.updated', properties: {} } });
    await waitUntil(() => events.filter(event => event.type === 'session.updated').length === 2);
    expect(events.filter(event => event.type === 'session.updated')).toEqual(
      expect.arrayContaining([
        { directory: first.directory, scopeId: auth.scopeId, type: 'session.updated' },
        { directory: second.directory, scopeId: otherAuth.scopeId, type: 'session.updated' },
      ])
    );
  });

  it('routes separate SandboxSession roots sharing a worktree through isolated SDK runtimes', async () => {
    const identities = [
      {
        sessionId: 'workspace_first',
        kiloSessionId: 'root_first',
        directory: path.join(tmpDir, 'shared'),
      },
      {
        sessionId: 'workspace_second',
        kiloSessionId: 'root_second',
        directory: path.join(tmpDir, 'shared'),
      },
      {
        sessionId: 'workspace_other',
        kiloSessionId: 'root_other',
        directory: path.join(tmpDir, 'other'),
      },
    ];
    const routedEvents: SessionEventIdentity[] = [];
    const outcomes: Array<{ identity: SessionRequestIdentity; messageId: string; status: string }> =
      [];
    const harness = createRegistry({
      onEvent: (_runtime, event) => {
        if (event.type === 'session.created') {
          const child = childFromSessionCreated(event.properties);
          if (child) rememberChildSession(child);
        }
        const sessionId = eventKiloSessionId(event.properties);
        if (!sessionId) return;
        const identity = sessionEventIdentity({ sessionId, directory: event.directory });
        if (identity) routedEvents.push(identity);
      },
    });
    const terminals = createControlTerminalRuntime({
      controlUrl: 'ws://127.0.0.1:1/sandbox-control/test',
      wrapperInstanceId: crypto.randomUUID(),
      getKiloRuntime: identity => harness.registry.get(identity),
    });
    const deps: HandlerDeps = createControlHandlerDeps({
      kiloRuntimes: harness.registry,
      terminalRuntime: terminals,
      version: 'test',
      kiloReady: true,
      sessions: [],
      emitSessionEvent: (identity, event) => {
        if (event.type === 'session.message.outcome') {
          const { messageId, status } = sessionMessageOutcomeSchema.parse(event.properties);
          outcomes.push({ identity, messageId, status });
        }
      },
      retireRuntime: () => {},
    });
    const waitForTasks = () =>
      Promise.all(deps.operations.activeOperations().map(task => task.done));
    try {
      const attached = await Promise.all(
        identities.map((identity, index) =>
          handleControlRequest(
            'session.attach',
            identity,
            {
              kilo:
                index === 2 ? { ...auth, scopeId: 'worktree_other', token: 'opaque-other' } : auth,
              env:
                index === 2
                  ? {}
                  : { ...bitbucketMetadata, BITBUCKET_TOKEN: 'opaque-bitbucket-token' },
            },
            deps
          )
        )
      );
      expect(attached).toEqual(identities.map(() => ({ ok: true, result: { attached: true } })));
      expect(harness.launches).toHaveLength(3);
      expect(servers.map(server => server.feedConnections)).toEqual([1, 1, 1]);
      const sameDirectoryRuntimes = identities.slice(0, 2).map(identity => {
        const runtime = harness.registry.get(identity);
        if (!runtime) throw new Error('Expected same-directory runtime');
        return runtime;
      });
      expect(sameDirectoryRuntimes[0].kiloClient).not.toBe(sameDirectoryRuntimes[1].kiloClient);
      expect(sameDirectoryRuntimes[0].kiloClient.serverUrl).not.toBe(
        sameDirectoryRuntimes[1].kiloClient.serverUrl
      );
      expect(sameDirectoryRuntimes[0].env.HOME).not.toBe(sameDirectoryRuntimes[1].env.HOME);
      expect(path.join(sameDirectoryRuntimes[0].env.XDG_DATA_HOME, 'kilo', 'auth.json')).not.toBe(
        path.join(sameDirectoryRuntimes[1].env.XDG_DATA_HOME, 'kilo', 'auth.json')
      );

      for (const identity of identities) {
        const runtime = harness.registry.get(identity);
        const server = servers.find(server => server.url === runtime?.kiloClient.serverUrl);
        if (!runtime || !server) throw new Error('Expected attached worktree runtime');
        const before = server.requests.length;
        const messageId = `message_${identity.kiloSessionId}`;
        expect(
          await handleControlRequest(
            'session.prompt',
            identity,
            {
              messageId,
              turn: { type: 'prompt', prompt: 'hello' },
              agent: { mode: 'code', model: 'test' },
            },
            deps
          )
        ).toEqual({ ok: true, result: { messageId, status: 'accepted' } });
        await waitForTasks();
        expect(
          await handleControlRequest(
            'session.prompt',
            identity,
            {
              messageId: `command_${identity.kiloSessionId}`,
              turn: { type: 'command', command: 'review', arguments: '--all' },
              agent: { mode: 'code', model: 'test' },
            },
            deps
          )
        ).toEqual({
          ok: true,
          result: { messageId: `command_${identity.kiloSessionId}`, status: 'accepted' },
        });
        await waitForTasks();
        expect(outcomes.slice(-2)).toEqual([
          { identity, messageId, status: 'completed' },
          { identity, messageId: `command_${identity.kiloSessionId}`, status: 'completed' },
        ]);
        server.permissions.push({
          id: `permission_${identity.kiloSessionId}`,
          sessionID: identity.kiloSessionId,
          permission: 'bash',
          patterns: [],
          metadata: {},
          always: [],
        });
        expect(
          await handleControlRequest(
            'session.permission.resolve',
            identity,
            {
              permissionId: `permission_${identity.kiloSessionId}`,
              response: 'once',
            },
            deps
          )
        ).toEqual({ ok: true, result: { success: true } });
        expect(server.permissions).toEqual([]);
        expect(
          (
            await handleControlRequest(
              'session.terminal.create',
              identity,
              {
                operationId: crypto.randomUUID(),
              },
              deps
            )
          ).ok
        ).toBe(true);
        expect(server.requests.slice(before)).toMatchObject([
          {
            pathname: `/session/${identity.kiloSessionId}/message`,
            directory: identity.directory,
            body: { messageID: messageId },
          },
          {
            pathname: `/session/${identity.kiloSessionId}/command`,
            directory: identity.directory,
            body: { messageID: `command_${identity.kiloSessionId}`, command: 'review' },
          },
          {
            pathname: '/permission',
            directory: identity.directory,
          },
          {
            pathname: `/permission/permission_${identity.kiloSessionId}/reply`,
            directory: identity.directory,
            body: { reply: 'once' },
          },
          {
            pathname: '/pty',
            directory: identity.directory,
            body: { cwd: identity.directory, env: runtime.env },
          },
        ]);
        if (runtime.scopeId === auth.scopeId) {
          const expectedEnv = {
            ...bitbucketMetadata,
            BITBUCKET_TOKEN: 'opaque-bitbucket-token',
            KILOCODE_TOKEN: auth.token,
          };
          expect(runtime.env).toMatchObject(expectedEnv);
          expect(server.requests.at(-1)).toMatchObject({
            pathname: '/pty',
            body: { env: expectedEnv },
          });
        } else {
          for (const key of Object.keys(bitbucketMetadata))
            expect(runtime.env).not.toHaveProperty(key);
        }
        expect(JSON.stringify(server.requests.slice(before))).not.toContain('actual-');
        server.emit({
          directory: identity.directory,
          payload: {
            type: 'session.created',
            properties: { info: { id: identity.kiloSessionId, directory: identity.directory } },
          },
        });
        server.emit({
          directory: identity.directory,
          payload: {
            type: 'session.created',
            properties: {
              info: { id: `child_${identity.kiloSessionId}`, parentID: identity.kiloSessionId },
            },
          },
        });
      }
      await waitUntil(() => routedEvents.length === 6);
      for (const identity of identities) {
        expect(routedEvents).toContainEqual({
          directory: identity.directory,
          kiloSessionId: identity.kiloSessionId,
          rootKiloSessionId: identity.kiloSessionId,
        });
        expect(routedEvents).toContainEqual({
          directory: identity.directory,
          kiloSessionId: `child_${identity.kiloSessionId}`,
          rootKiloSessionId: identity.kiloSessionId,
        });
      }

      const [first, second] = identities;
      const runtime = harness.registry.get(first);
      expect(await handleControlRequest('session.detach', second, {}, deps)).toEqual({
        ok: true,
        result: { detached: true },
      });
      expect(harness.registry.get(first)).toBe(runtime);
      expect(harness.registry.get(second)).toBeUndefined();
      expect(harness.closes).toBe(1);
      expect(rootForSession(undefined, first.directory)).toBe(first.kiloSessionId);
      expect(rootForSession(`child_${second.kiloSessionId}`, first.directory)).toBeUndefined();
      const survivingPrompt = {
        messageId: 'surviving_root',
        turn: { type: 'prompt', prompt: 'still attached' },
        agent: { mode: 'code', model: 'test' },
      };
      expect(await handleControlRequest('session.prompt', first, survivingPrompt, deps)).toEqual({
        ok: true,
        result: { messageId: survivingPrompt.messageId, status: 'accepted' },
      });
      await waitForTasks();
      expect(outcomes.at(-1)).toEqual({
        identity: first,
        messageId: survivingPrompt.messageId,
        status: 'completed',
      });
      expect(await handleControlRequest('session.abort', first, {}, deps)).toEqual({
        ok: true,
        result: { status: 'already_idle' },
      });
      expect((await handleControlRequest('session.prompt', second, survivingPrompt, deps)).ok).toBe(
        false
      );
      expect(harness.launches).toHaveLength(3);

      expect(await handleControlRequest('session.detach', first, {}, deps)).toEqual({
        ok: true,
        result: { detached: true },
      });
      expect(runtime?.signal.aborted).toBe(true);
      expect(harness.registry.get(first)).toBeUndefined();
      expect(harness.closes).toBe(2);
      expect(rootForSession(first.kiloSessionId)).toBeUndefined();
      expect(rootForSession(`child_${first.kiloSessionId}`)).toBeUndefined();
      expect(
        await handleControlRequest('session.prompt', identities[2], survivingPrompt, deps)
      ).toEqual({
        ok: true,
        result: { messageId: survivingPrompt.messageId, status: 'accepted' },
      });
      await waitForTasks();
      expect(outcomes.at(-1)).toEqual({
        identity: identities[2],
        messageId: survivingPrompt.messageId,
        status: 'completed',
      });
      expect(await handleControlRequest('session.abort', identities[2], {}, deps)).toEqual({
        ok: true,
        result: { status: 'already_idle' },
      });
      expect(
        (
          await handleControlRequest(
            'session.terminal.create',
            identities[2],
            {
              operationId: crypto.randomUUID(),
            },
            deps
          )
        ).ok
      ).toBe(true);
      expect(
        (
          await handleControlRequest(
            'session.attach',
            first,
            {
              kilo: { ...auth, token: 'replacement-token' },
            },
            deps
          )
        ).ok
      ).toBe(true);
      expect(harness.registry.get(first)).not.toBe(runtime);
      expect(
        (
          await handleControlRequest(
            'session.terminal.create',
            first,
            {
              operationId: crypto.randomUUID(),
            },
            deps
          )
        ).ok
      ).toBe(true);
      expect(harness.launches).toHaveLength(4);
      expect(harness.unexpectedCloses).toBe(0);
    } finally {
      terminals.shutdown();
    }
  });

  it('retires each same-directory identity independently and permits reuse without affecting another worktree', async () => {
    const harness = createRegistry();
    const directory = path.join(tmpDir, 'shared');
    const first = await harness.registry.ensure(directory, auth);
    const siblingIdentity = rootIdentity(directory, 'sibling');
    const sibling = harness.registry.attach(siblingIdentity, auth);
    const other = await harness.registry.ensure(path.join(tmpDir, 'other'), {
      ...auth,
      scopeId: 'other',
    });
    const marker = path.join(directory, '.kilo-bootstrap-complete');
    fs.writeFileSync(marker, 'ready');

    expect(harness.registry.detach(rootIdentity(directory))).toBe(true);
    expect(first.signal.aborted).toBe(true);
    expect(harness.registry.get(rootIdentity(directory))).toBeUndefined();
    expect(sibling.signal.aborted).toBe(false);
    const siblingRuntime = await sibling.ready;
    expect(siblingRuntime).not.toBe(first);
    sibling.commit();
    sibling.release();
    expect(harness.closes).toBe(1);

    expect(harness.registry.detach(siblingIdentity)).toBe(true);
    expect(siblingRuntime.signal.aborted).toBe(true);
    expect(harness.registry.get(siblingIdentity)).toBeUndefined();
    expect(harness.closes).toBe(2);
    expect(harness.registry.get(rootIdentity(other.directory))).toBe(other);
    await other.kiloClient.abortSession({ sessionId: 'root_other' });
    const otherServer = servers.find(server => server.url === other.kiloClient.serverUrl);
    expect(otherServer?.requests.at(-1)?.pathname).toBe('/session/root_other/abort');

    const replacement = await harness.registry.ensure(directory, {
      ...auth,
      token: 'replacement-token',
    });
    expect(replacement).not.toBe(first);
    expect(replacement.env.HOME).toBe(first.env.HOME);
    expect(replacement.env.KILOCODE_TOKEN).toBe('replacement-token');
    expect(fs.readFileSync(marker, 'utf8')).toBe('ready');
    expect(harness.registry.get(rootIdentity(other.directory))).toBe(other);
    expect(harness.unexpectedCloses).toBe(0);
    expect(harness.launches).toHaveLength(4);
  });

  it('does not accumulate duplicate roots or release a committed root on a failed retry', async () => {
    const harness = createRegistry();
    const identity = rootIdentity(path.join(tmpDir, 'shared'));
    const first = harness.registry.attach(identity, auth);
    const duplicate = harness.registry.attach(identity, auth);
    first.release();
    first.release();
    const runtime = await duplicate.ready;
    await first.ready;
    duplicate.commit();
    duplicate.release();
    const retry = harness.registry.attach(identity, auth);
    expect(await retry.ready).toBe(runtime);
    retry.release();

    expect(harness.registry.get(identity)).toBe(runtime);
    expect(harness.closes).toBe(0);
    expect(harness.launches).toHaveLength(1);
    expect(harness.registry.detach(identity)).toBe(true);
    expect(harness.registry.detach(identity)).toBe(false);
    expect(harness.closes).toBe(1);
    expect(runtime.signal.aborted).toBe(true);
  });

  it('maps pending roots and children before startup and removes them only after the final failed attempt', async () => {
    const harness = createRegistry();
    const identity = rootIdentity(path.join(tmpDir, 'shared'));
    const first = harness.registry.attach(identity, auth);
    const duplicate = harness.registry.attach(identity, auth);
    expect(rootForSession(identity.kiloSessionId, identity.directory)).toBe(identity.kiloSessionId);
    rememberChildSession({ childId: 'pending_child', parentId: identity.kiloSessionId });
    expect(rootForSession('pending_child', identity.directory)).toBe(identity.kiloSessionId);
    first.release();
    expect(rootForSession(identity.kiloSessionId)).toBe(identity.kiloSessionId);
    expect(rootForSession('pending_child')).toBe(identity.kiloSessionId);
    const runtime = await duplicate.ready;
    await first.ready;
    duplicate.release();
    expect(rootForSession(identity.kiloSessionId)).toBeUndefined();
    expect(rootForSession('pending_child')).toBeUndefined();
    expect(directoryForSession(identity.kiloSessionId)).toBeUndefined();
    expect(directoryForSession('pending_child')).toBeUndefined();
    expect(runtime.signal.aborted).toBe(true);
    expect(harness.closes).toBe(1);
  });

  it('creates independent runtimes for distinct identities without disturbing pending ownership', async () => {
    const harness = createRegistry();
    const identity = rootIdentity(path.join(tmpDir, 'shared'));
    const attachment = harness.registry.attach(identity, auth);
    const distinct = [
      { ...identity, directory: path.join(tmpDir, 'other') },
      { ...identity, sessionId: 'workspace_foreign' },
      { ...identity, kiloSessionId: 'root_foreign' },
    ];
    const attachments = distinct.map(candidate => harness.registry.attach(candidate, auth));
    const runtime = await attachment.ready;
    attachment.commit();
    expect(harness.registry.get(identity)).toBe(runtime);
    for (const candidate of attachments) {
      const candidateRuntime = await candidate.ready;
      expect(candidateRuntime).not.toBe(runtime);
      candidate.commit();
    }
    expect(harness.registry.detach(rootIdentity(identity.directory, 'unknown'))).toBe(false);
    expect(harness.closes).toBe(0);
    for (const candidate of distinct) expect(harness.registry.detach(candidate)).toBe(true);
    expect(harness.registry.detach(identity)).toBe(true);
  });

  it('keeps a pending sibling startup alive while cancelling only its detached identity', async () => {
    const launched = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const server = createKiloStub();
    servers.push(server);
    let closes = 0;
    let starts = 0;
    const { registry } = createRegistry({
      startServer: async options => {
        proveOwnedProcesses(options);
        launched.resolve();
        if (starts++ === 0) await release.promise;
        return {
          url: server.url,
          close: () => {
            closes += 1;
          },
        };
      },
    });
    const directory = path.join(tmpDir, 'shared');
    const firstIdentity = rootIdentity(directory, 'first');
    const first = registry.attach(firstIdentity, auth);
    await launched.promise;
    const siblingIdentity = rootIdentity(directory, 'sibling');
    const sibling = registry.attach(siblingIdentity, auth);
    try {
      expect(registry.detach(firstIdentity)).toBe(true);
      expect(first.signal.aborted).toBe(true);
      expect(sibling.signal.aborted).toBe(false);
      const runtime = await sibling.ready;
      expect(runtime.identity).toEqual(siblingIdentity);
      release.resolve();
      expect(await rejected(first.ready)).toMatchObject({ code: 'not_ready' });
      expect(() => first.commit()).toThrow();
      first.release();
      sibling.commit();
      expect(registry.get(siblingIdentity)).toBe(runtime);
      expect(closes).toBe(1);
      expect(registry.detach(siblingIdentity)).toBe(true);
      expect(closes).toBe(2);
    } finally {
      release.resolve();
      await Promise.allSettled([first.ready, sibling.ready]);
    }
  });

  it('fences late startup and cleanup from a replacement lifetime and its auth files', async () => {
    const launched = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const stopped = Promise.withResolvers<void>();
    const oldServer = createKiloStub();
    const newServer = createKiloStub();
    servers.push(oldServer, newServer);
    const steps: string[] = [];
    const harness = createRegistry({
      startServer: async options => {
        proveOwnedProcesses(options);
        const old = options.env.KILOCODE_TOKEN === auth.token;
        steps.push(old ? 'start-old' : 'start-new');
        if (old) {
          launched.resolve();
          await release.promise;
        }
        return {
          url: old ? oldServer.url : newServer.url,
          ...(old ? { stopped: stopped.promise } : {}),
          close: () => {
            steps.push(old ? 'close-old' : 'close-new');
          },
        };
      },
    });
    const identity = rootIdentity(path.join(tmpDir, 'shared'));
    const old = harness.registry.attach(identity, auth);
    const oldResult = rejected(old.ready);
    try {
      await launched.promise;
      expect(harness.registry.detach(identity)).toBe(true);
      const replacement = harness.registry.attach(identity, { ...auth, token: 'replacement' });
      rememberChildSession({
        childId: 'replacement_startup_child',
        parentId: identity.kiloSessionId,
      });
      old.release();
      expect(rootForSession(identity.kiloSessionId)).toBe(identity.kiloSessionId);
      expect(rootForSession('replacement_startup_child')).toBe(identity.kiloSessionId);
      await Promise.resolve();
      expect(steps).toEqual(['start-old']);
      release.resolve();
      expect(await oldResult).toMatchObject({ code: 'not_ready' });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(steps).toEqual(['start-old', 'close-old']);
      expect(newServer.feedConnections).toBe(0);
      stopped.resolve();
      const runtime = await replacement.ready;
      replacement.commit();
      old.release();
      expect(rootForSession(identity.kiloSessionId)).toBe(identity.kiloSessionId);
      expect(rootForSession('replacement_startup_child')).toBe(identity.kiloSessionId);
      expect(steps).toEqual(['start-old', 'close-old', 'start-new']);
      expect(oldServer.feedConnections).toBe(0);
      expect(newServer.feedConnections).toBe(1);
      expect(harness.registry.get(identity)).toBe(runtime);
      expect(
        JSON.parse(
          fs.readFileSync(path.join(runtime.env.XDG_DATA_HOME, 'kilo', 'auth.json'), 'utf8')
        )
      ).toEqual({
        kilo: { type: 'api', key: 'replacement' },
      });
      const independent = harness.registry.attach(rootIdentity(path.join(tmpDir, 'other')), {
        ...auth,
        token: 'replacement',
      });
      expect((await independent.ready).env.KILOCODE_TOKEN).toBe('replacement');
      independent.commit();
      independent.release();
      expect(harness.unexpectedCloses).toBe(0);
    } finally {
      release.resolve();
      stopped.resolve();
      await oldResult;
    }
  });

  it('rejects contained credential changes for one identity while allowing a distinct identity', async () => {
    const { registry, launches } = createRegistry();
    const directory = path.join(tmpDir, 'worktree-a');
    await registry.ensure(directory, auth);
    const conflicts = [
      { ...auth, scopeId: 'different-scope' },
      { ...auth, token: 'different-token' },
      { ...auth, organizationId: 'different-organization' },
      ...Object.keys(auth.targets).map(key => ({
        ...auth,
        targets: { ...auth.targets, [key]: 'https://different.example.test' },
      })),
    ];
    for (const conflict of conflicts) {
      expect(await rejected(registry.ensure(directory, conflict))).toMatchObject({
        code: 'unauthorized',
        message: 'Kilo worktree auth context mismatch',
        retryable: false,
      });
    }
    const distinct = await registry.ensure(path.join(tmpDir, 'worktree-b'), auth);
    expect(distinct).not.toBe(registry.get(rootIdentity(directory)));
    expect(launches).toHaveLength(2);
  });

  it('releases a failed sole attachment and permits retry with fresh auth', async () => {
    let attempts = 0;
    const stub = createKiloStub();
    servers.push(stub);
    const { registry } = createRegistry({
      startServer: async options => {
        proveOwnedProcesses(options);
        attempts += 1;
        if (attempts === 1) throw new Error('actual-managed-token');
        return { url: stub.url, close: () => {} };
      },
    });
    const directory = path.join(tmpDir, 'worktree-a');
    expect(await rejected(registry.ensure(directory, auth))).toMatchObject({
      message: 'Kilo worktree failed to start',
    });
    expect(registry.get(rootIdentity(directory))).toBeUndefined();
    const runtime = await registry.ensure(directory, { ...auth, token: 'changed-token' });
    expect(runtime.scopeId).toBe(auth.scopeId);
    expect(runtime.env.KILOCODE_TOKEN).toBe('changed-token');
    expect(attempts).toBe(2);
  });

  it('closes all worktree servers and feeds once and prevents later use', async () => {
    const harness = createRegistry();
    const first = await harness.registry.ensure(path.join(tmpDir, 'a'), auth);
    const second = await harness.registry.ensure(path.join(tmpDir, 'b'), {
      ...auth,
      scopeId: 'worktree_b',
    });
    rememberChildSession({
      childId: 'shutdown_child',
      parentId: rootIdentity(first.directory).kiloSessionId,
    });
    harness.registry.shutdown();
    harness.registry.shutdown();
    expect(rootForSession(rootIdentity(first.directory).kiloSessionId)).toBeUndefined();
    expect(rootForSession(rootIdentity(second.directory).kiloSessionId)).toBeUndefined();
    expect(rootForSession('shutdown_child')).toBeUndefined();
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);
    expect(harness.closes).toBe(2);
    if (!first.identity) throw new Error('Expected runtime identity');
    expect(harness.registry.get(first.identity)).toBeUndefined();
    expect(await rejected(harness.registry.ensure(first.directory, auth))).toMatchObject({
      message: 'Kilo worktrees are closed',
    });
    await Bun.sleep(0);
    expect(harness.unexpectedCloses).toBe(0);
  });

  it('closes a server whose launch completes after shutdown without opening its event feed', async () => {
    const launched = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    const stub = createKiloStub();
    servers.push(stub);
    let closes = 0;
    const { registry } = createRegistry({
      startServer: async options => {
        proveOwnedProcesses(options);
        launched.resolve();
        await released.promise;
        return {
          url: stub.url,
          close: () => {
            closes += 1;
          },
        };
      },
    });
    const pending = registry.ensure(path.join(tmpDir, 'a'), auth);
    const failure = pending.catch((error: unknown) => error);
    await launched.promise;
    registry.shutdown();
    released.resolve();
    expect(await failure).toMatchObject({
      code: 'not_ready',
      message: 'Kilo worktree failed to start',
    });
    expect(closes).toBe(1);
    expect(stub.feedConnections).toBe(0);
  });

  it('replaces an unexpected event-feed closure without invalidating its runtime', async () => {
    const harness = createRegistry();
    const runtime = await harness.registry.ensure(path.join(tmpDir, 'a'), auth);
    servers[0]?.endFeeds();
    await waitUntil(() => (servers[0]?.feedConnections ?? 0) === 2);
    expect(runtime.signal.aborted).toBe(false);
    if (!runtime.identity) throw new Error('Expected runtime identity');
    expect(harness.registry.get(runtime.identity)).toBe(runtime);
    expect(harness.closes).toBe(0);
    expect(harness.unexpectedCloses).toBe(0);
  });

  it('retires a runtime on process exit independently of feed recovery', async () => {
    const exited = Promise.withResolvers<void>();
    const server = createKiloStub();
    const failures: unknown[] = [];
    servers.push(server);
    const harness = createRegistry({
      startServer: async options => {
        options.onProcessScope?.({ stop: async () => true } as unknown as OwnedProcessScope);
        return { url: server.url, close() {}, exited: exited.promise };
      },
      onUnexpectedClose: failure => failures.push(failure),
    });
    const runtime = await harness.registry.ensure(path.join(tmpDir, 'process-exit'), auth);
    exited.resolve();
    await waitUntil(() => failures.length === 1);
    expect(failures).toEqual([
      expect.objectContaining({
        directory: runtime.directory,
        identity: runtime.identity,
        reason: 'process_exited',
        cleanup: 'confirmed',
        runtimeId: runtime.runtimeId,
      }),
    ]);
    expect(runtime.signal.aborted).toBe(true);
    expect(harness.registry.getRetained?.(runtime.directory)).toBeUndefined();
  });

  it('preserves an admitted operation and its runtime while a real feed recovers', async () => {
    const timers = spyOn(globalThis, 'setTimeout');
    const harness = createRegistry({
      startServer: async options => {
        const server = createKiloStub();
        servers.push(server);
        options.onProcessScope?.({
          stop: async () => true,
          verify: async () => true,
        } as unknown as OwnedProcessScope);
        return { url: server.url, close() {} };
      },
    });
    const identity = rootIdentity(path.join(tmpDir, 'recovery'));
    const runtime = await harness.registry.ensure(identity.directory, auth);
    const server = servers.find(item => item.url === runtime.kiloClient.serverUrl);
    if (!server) throw new Error('Missing Kilo test server');
    const deps = createHandlerDeps(harness.registry);
    const client = runtime.kiloClient;
    const prompt = {
      messageId: 'feed_recovery',
      turn: { type: 'prompt' as const, prompt: 'continue the admitted work' },
      agent: { mode: 'code', model: 'test' },
    };
    server.sessionStatuses[identity.kiloSessionId] = { type: 'idle' };
    server.holdPrompts(identity.kiloSessionId);
    server.permissions.push({
      id: 'permission_recovery',
      sessionID: identity.kiloSessionId,
      permission: 'bash',
      patterns: [],
      metadata: {},
      always: [],
    });
    try {
      expect(await handleControlRequest('session.prompt', identity, prompt, deps)).toEqual({
        ok: true,
        result: { messageId: prompt.messageId, status: 'accepted' },
      });
      await waitUntil(() =>
        server.requests.some(
          request => request.pathname === `/session/${identity.kiloSessionId}/message`
        )
      );
      const executionDeadlineCount = timers.mock.calls.filter(
        ([, ms]) => ms === SANDBOX_CONTROL_EXECUTION_TIMEOUT_MS
      ).length;
      expect(executionDeadlineCount).toBeGreaterThan(0);

      server.endFeeds();
      await waitUntil(() => server.feedConnections === 2);
      expect(harness.registry.prepareForNewWork?.(identity.directory)).toBe(false);
      expect(harness.registry.get(identity)).toBe(runtime);
      expect(runtime.kiloClient).toBe(client);
      expect(runtime.kiloClient.serverUrl).toBe(client.serverUrl);
      expect(
        await handleControlRequest(
          'session.prompt',
          identity,
          { ...prompt, messageId: 'feed_recovery_rejected' },
          deps
        )
      ).toEqual({
        ok: false,
        error: {
          code: 'not_ready',
          message: 'Native feed recovery is in progress',
          retryable: true,
          admission: 'not-admitted',
        },
      });
      expect(
        await handleControlRequest(
          'session.permission.resolve',
          identity,
          { permissionId: 'permission_recovery', response: 'once' },
          deps
        )
      ).toEqual({ ok: true, result: { success: true } });
      const stopping = handleControlRequest(
        'session.abort',
        identity,
        { messageId: prompt.messageId },
        deps
      );
      await waitUntil(() =>
        server.requests.some(
          request => request.pathname === `/session/${identity.kiloSessionId}/abort`
        )
      );
      expect(await stopping).toEqual({ ok: true, result: { status: 'aborted' } });
      expect(
        server.requests.filter(
          request => request.pathname === `/session/${identity.kiloSessionId}/message`
        )
      ).toHaveLength(1);
      expect(
        timers.mock.calls.filter(([, ms]) => ms === SANDBOX_CONTROL_EXECUTION_TIMEOUT_MS)
      ).toHaveLength(executionDeadlineCount);

      server.emit({ payload: { type: 'server.heartbeat', properties: {} } });
      await waitUntil(() => harness.registry.prepareForNewWork?.(identity.directory) === true);
      expect(harness.registry.get(identity)).toBe(runtime);
      expect(runtime.kiloClient).toBe(client);
      expect(harness.unexpectedCloses).toBe(0);
    } finally {
      server.releasePrompts(identity.kiloSessionId);
      timers.mockRestore();
    }
  });
});

describe('worktree directory deletion', () => {
  it('waits for confirmed child exit before removing HOME while another directory stays live', async () => {
    const stopped = Promise.withResolvers<void>();
    const directory = path.join(tmpDir, 'stopping');
    const closed: string[] = [];
    const harness = createRegistry({
      startServer: async options => {
        proveOwnedProcesses(options, stopped.promise);
        const stub = createKiloStub();
        servers.push(stub);
        return {
          url: stub.url,
          close: () => {
            closed.push(options.directory);
          },
          ...(options.directory === directory ? { stopped: stopped.promise } : {}),
        };
      },
    });
    const runtime = await harness.registry.ensure(directory, auth);
    const other = await harness.registry.ensure(path.join(tmpDir, 'other'), {
      ...auth,
      scopeId: 'other',
    });
    const authFile = path.join(runtime.env.XDG_DATA_HOME, 'kilo', 'auth.json');
    let deleted = false;
    const deletion = harness.registry.deleteDirectory(directory).then(() => {
      deleted = true;
    });
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(runtime.signal.aborted).toBe(true);
      expect(closed).toEqual([directory]);
      expect(deleted).toBe(false);
      expect(fs.existsSync(authFile)).toBe(true);
      expect(harness.registry.get(rootIdentity(other.directory))).toBe(other);
      expect(fs.existsSync(other.env.HOME)).toBe(true);
      expect(other.signal.aborted).toBe(false);
      fs.writeFileSync(path.join(runtime.env.HOME, 'last-write-before-exit'), 'stopping');
      stopped.resolve();
      await deletion;
      expect(deleted).toBe(true);
      expect(fs.existsSync(runtime.env.HOME)).toBe(false);
      expect(fs.existsSync(other.env.HOME)).toBe(true);
    } finally {
      stopped.resolve();
      await deletion;
    }
  });

  it('fails deletion closed on an exit deadline and retries the same retirement after the child stops', async () => {
    const stopped = Promise.withResolvers<void>();
    const stub = createKiloStub();
    servers.push(stub);
    let closes = 0;
    const harness = createRegistry({
      startServer: async options => {
        proveOwnedProcesses(options, stopped.promise);
        return {
          url: stub.url,
          close: () => {
            closes++;
          },
          stopped: stopped.promise,
        };
      },
    });
    const directory = path.join(tmpDir, 'stuck-exit');
    const runtime = await harness.registry.ensure(directory, auth);
    const checkoutFile = path.join(directory, 'checkout');
    fs.writeFileSync(checkoutFile, 'keep checkout');
    harness.registry.detach(rootIdentity(directory));
    const timers = spyOn(globalThis, 'setTimeout');
    let retry: Promise<void> | undefined;
    try {
      const failure = rejected(harness.registry.deleteDirectory(directory));
      const deadline = timers.mock.calls.find(([, ms]) => ms === 30_000)?.[0];
      if (typeof deadline !== 'function') throw new Error('Missing retirement deadline');
      deadline();
      expect(await failure).toEqual(new Error('Kilo worktree retirement timed out'));
      expect(fs.existsSync(runtime.env.HOME)).toBe(true);
      expect(fs.readFileSync(checkoutFile, 'utf8')).toBe('keep checkout');
      expect(closes).toBe(1);
      let deleted = false;
      retry = harness.registry.deleteDirectory(directory).then(() => {
        deleted = true;
      });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(deleted).toBe(false);
      expect(fs.existsSync(runtime.env.HOME)).toBe(true);
      stopped.resolve();
      await retry;
      expect(fs.existsSync(runtime.env.HOME)).toBe(false);
      expect(fs.readFileSync(checkoutFile, 'utf8')).toBe('keep checkout');
      expect(closes).toBe(1);
    } finally {
      stopped.resolve();
      await retry;
      timers.mockRestore();
    }
  });

  it('removes live and retired generated homes and roots without touching another directory', async () => {
    const harness = createRegistry();
    const directory = path.join(tmpDir, 'deleted');
    const identity = rootIdentity(directory);
    const retired = await harness.registry.ensure(directory, auth);
    const retiredHome = retired.env.HOME;
    const savedSession = path.join(retiredHome, 'saved-session');
    fs.writeFileSync(savedSession, 'restore state');
    expect(harness.registry.detach(identity)).toBe(true);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(fs.readFileSync(savedSession, 'utf8')).toBe('restore state');
    const restored = await harness.registry.ensure(directory, auth);
    expect(restored.env.HOME).toBe(retiredHome);
    expect(fs.readFileSync(savedSession, 'utf8')).toBe('restore state');
    expect(harness.registry.detach(identity)).toBe(true);
    const liveAuth = { ...auth, scopeId: 'new_scope', token: 'new_guest' };
    const live = await harness.registry.ensure(directory, liveAuth);
    const liveHome = live.env.HOME;
    expect(liveHome).toBe(retiredHome);
    const siblingIdentity = rootIdentity(directory, 'sibling');
    const sibling = harness.registry.attach(siblingIdentity, liveAuth);
    await sibling.ready;
    sibling.commit();
    rememberChildSession({ childId: 'deleted_child', parentId: siblingIdentity.kiloSessionId });
    const other = await harness.registry.ensure(path.join(tmpDir, 'other'), {
      ...auth,
      scopeId: 'other_scope',
    });
    const otherIdentity = rootIdentity(other.directory);
    rememberChildSession({ childId: 'surviving_child', parentId: otherIdentity.kiloSessionId });
    const otherAuthFile = path.join(other.env.XDG_DATA_HOME, 'kilo', 'auth.json');
    const otherAuthBefore = fs.readFileSync(otherAuthFile, 'utf8');
    const checkoutFile = path.join(directory, 'checkout-file');
    fs.writeFileSync(checkoutFile, 'owned by checkout cleanup');
    live.env.HOME = other.env.HOME;

    expect(harness.registry.get(identity)).toBe(live);
    await harness.registry.deleteDirectory(directory);
    expect(fs.existsSync(retiredHome)).toBe(false);
    expect(fs.existsSync(liveHome)).toBe(false);
    expect(fs.readFileSync(checkoutFile, 'utf8')).toBe('owned by checkout cleanup');
    expect(fs.readFileSync(otherAuthFile, 'utf8')).toBe(otherAuthBefore);
    expect(live.signal.aborted).toBe(true);
    expect(sibling.signal.aborted).toBe(true);
    expect(harness.registry.get(identity)).toBeUndefined();
    for (const id of [identity.kiloSessionId, siblingIdentity.kiloSessionId, 'deleted_child']) {
      expect(rootForSession(id)).toBeUndefined();
      expect(directoryForSession(id)).toBeUndefined();
    }
    if (!other.identity) throw new Error('Expected runtime identity');
    expect(harness.registry.get(other.identity)).toBe(other);
    expect(other.signal.aborted).toBe(false);
    expect(rootForSession('surviving_child')).toBe(otherIdentity.kiloSessionId);
    expect(await other.kiloClient.abortSession({ sessionId: otherIdentity.kiloSessionId })).toBe(
      true
    );
    expect(harness.closes).toBe(4);
    expect(harness.registry.isHealthy()).toBe(true);
    expect(() => harness.registry.attach(rootIdentity(directory, 'new_root'), liveAuth)).toThrow(
      'Kilo worktree is deleted'
    );
    await harness.registry.deleteDirectory(directory);
    expect(harness.launches).toHaveLength(5);
    expect(harness.closes).toBe(4);
    expect(harness.unexpectedCloses).toBe(0);
  });

  it('deletes already-retired homes idempotently after runtime entries are gone', async () => {
    const harness = createRegistry();
    const directory = path.join(tmpDir, 'retired');
    const homes: string[] = [];
    for (const scopeId of ['first_scope', 'second_scope']) {
      const runtime = await harness.registry.ensure(directory, { ...auth, scopeId });
      homes.push(runtime.env.HOME);
      expect(harness.registry.detach(rootIdentity(directory))).toBe(true);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(harness.registry.get(rootIdentity(directory, scopeId))).toBeUndefined();
      expect(fs.existsSync(runtime.env.HOME)).toBe(true);
    }
    await Promise.all([
      harness.registry.deleteDirectory(directory),
      harness.registry.deleteDirectory(directory),
    ]);
    for (const home of homes) expect(fs.existsSync(home)).toBe(false);
    await harness.registry.deleteDirectory(directory);
    expect(() => harness.registry.attach(rootIdentity(directory), auth)).toThrow(
      'Kilo worktree is deleted'
    );
    expect(harness.launches).toHaveLength(2);
    expect(harness.closes).toBe(2);
  });

  it('permanently fences a never-started directory without launching Kilo or deleting checkout content', async () => {
    const harness = createRegistry();
    const directory = path.join(tmpDir, 'never-started');
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, 'keep'), 'checkout');
    const deletion = harness.registry.deleteDirectory(directory);
    expect(() => harness.registry.attach(rootIdentity(directory), auth)).toThrow(
      'Kilo worktree is deleted'
    );
    await deletion;
    await harness.registry.deleteDirectory(directory);
    expect(harness.registry.get(rootIdentity(directory))).toBeUndefined();
    expect(harness.registry.detach(rootIdentity(directory))).toBe(false);
    expect(fs.readFileSync(path.join(directory, 'keep'), 'utf8')).toBe('checkout');
    expect(fs.existsSync(path.join(tmpDir, 'homes'))).toBe(false);
    expect(harness.launches).toEqual([]);
    expect(harness.closes).toBe(0);
    expect(harness.registry.isHealthy()).toBe(true);
  });

  it.each(['active', 'retiring', 'replacement', 'shutdown'] as const)(
    'drains %s startup before deleting generated HOME state',
    async state => {
      const launched = Promise.withResolvers<Parameters<typeof startWorktreeKiloServer>[0]>();
      const release = Promise.withResolvers<void>();
      const steps: string[] = [];
      let launches = 0;
      const stub = createKiloStub();
      servers.push(stub);
      const harness = createRegistry({
        startServer: async options => {
          proveOwnedProcesses(options);
          launches++;
          launched.resolve(options);
          await release.promise;
          fs.writeFileSync(path.join(options.env.HOME, 'late-startup-state'), 'pending startup');
          steps.push('late-write');
          return {
            url: stub.url,
            close: () => {
              steps.push('close');
            },
          };
        },
      });
      const directory = path.join(tmpDir, 'pending');
      const identity = rootIdentity(directory);
      const attachment = harness.registry.attach(identity, auth);
      const result = rejected(attachment.ready);
      const replacements: ReturnType<WorktreeKiloRuntimes['attach']>[] = [];
      const results = [result];
      const deletions: Promise<void>[] = [];
      try {
        const options = await launched.promise;
        if (state === 'retiring' || state === 'replacement') harness.registry.detach(identity);
        if (state === 'replacement') {
          const replacement = harness.registry.attach(identity, {
            ...auth,
            scopeId: 'replacement_scope',
          });
          replacements.push(replacement);
          results.push(rejected(replacement.ready));
        }
        if (state === 'shutdown') harness.registry.shutdown();
        let settled = false;
        const deletion = harness.registry.deleteDirectory(directory).then(() => {
          settled = true;
          steps.push('deleted');
        });
        deletions.push(deletion, harness.registry.deleteDirectory(directory));
        expect(attachment.signal.aborted).toBe(true);
        for (const replacement of replacements) expect(replacement.signal.aborted).toBe(true);
        expect(rootForSession(identity.kiloSessionId)).toBeUndefined();
        expect(() => harness.registry.attach(identity, auth)).toThrow();
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(settled).toBe(false);
        expect(fs.existsSync(options.env.HOME)).toBe(true);
        expect(steps).toEqual([]);
        release.resolve();
        for (const pending of results) expect(await pending).toMatchObject({ code: 'not_ready' });
        await Promise.all(deletions);
        expect(steps).toEqual(['late-write', 'close', 'deleted']);
        expect(fs.existsSync(options.env.HOME)).toBe(false);
        expect(fs.readdirSync(path.join(tmpDir, 'homes'))).toEqual([]);
        expect(harness.registry.get(rootIdentity(directory))).toBeUndefined();
        attachment.release();
        for (const replacement of replacements) replacement.release();
        expect(launches).toBe(1);
        expect(stub.feedConnections).toBe(0);
        expect(harness.unexpectedCloses).toBe(0);
        await harness.registry.deleteDirectory(directory);
      } finally {
        release.resolve();
        await Promise.allSettled([...results, ...deletions]);
      }
    }
  );
});

describe('worktree attachment lifecycle', () => {
  it.each(['setup', 'restore', 'terminal'] as const)(
    'releases a failed sole %s attachment and its routing',
    async phase => {
      const harness = createRegistry();
      const identity = rootIdentity(path.join(tmpDir, 'worktree'));
      const result = await applySessionAttach(
        identity,
        {
          kilo: auth,
          ...(phase === 'setup' ? { setupCommands: ['prepare'] } : {}),
        },
        {
          kiloRuntimes: harness.registry,
          hasBootstrapMarker: async () => false,
          runSetup: async () => ({ stdout: '', stderr: '', exitCode: 1 }),
          sessionExists: async () => phase === 'terminal',
          restoreSession: async () => ({
            ok: false,
            error: 'restore failed',
            code: 502,
            step: 'download',
          }),
          terminalRuntime: {
            rememberAttachedSession: () => {
              throw new ControlTerminalRuntimeError(
                'unauthorized',
                'Terminal ownership mismatch',
                false
              );
            },
          },
        }
      );
      expect(result.ok).toBe(false);
      expect(harness.registry.get(identity)).toBeUndefined();
      expect(rootForSession(identity.kiloSessionId)).toBeUndefined();
      expect(directoryForSession(identity.kiloSessionId)).toBeUndefined();
      expect(harness.closes).toBe(1);
      const deps = createHandlerDeps(harness.registry);
      expect(
        (
          await handleControlRequest(
            'session.attach',
            identity,
            {
              kilo: { ...auth, token: 'replacement' },
            },
            deps
          )
        ).ok
      ).toBe(true);
      expect(harness.registry.get(identity)?.env.KILOCODE_TOKEN).toBe('replacement');
      expect(
        (
          await handleControlRequest(
            'session.terminal.create',
            identity,
            {
              operationId: crypto.randomUUID(),
            },
            deps
          )
        ).ok
      ).toBe(true);
      expect(harness.unexpectedCloses).toBe(0);
    }
  );

  it('keeps a restoring same-directory sibling alive after another identity detaches', async () => {
    const harness = createRegistry();
    const deps = createHandlerDeps(harness.registry);
    const first = rootIdentity(path.join(tmpDir, 'shared'), 'first');
    const sibling = rootIdentity(first.directory, 'sibling');
    expect((await handleControlRequest('session.attach', first, { kilo: auth }, deps)).ok).toBe(
      true
    );
    const runtime = harness.registry.get(first);
    const restoring = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const pending = applySessionAttach(
      sibling,
      { kilo: auth },
      {
        ...deps,
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
      expect((await handleControlRequest('session.detach', first, {}, deps)).ok).toBe(true);
      expect(runtime?.signal.aborted).toBe(true);
      expect(harness.closes).toBe(1);
      release.resolve();
      expect(await pending).toEqual({ ok: true, result: { attached: true } });
      const siblingRuntime = harness.registry.get(sibling);
      expect(siblingRuntime).toBeDefined();
      expect(siblingRuntime).not.toBe(runtime);
      expect(rootForSession(first.kiloSessionId)).toBeUndefined();
      expect(rootForSession(sibling.kiloSessionId)).toBe(sibling.kiloSessionId);
      expect((await handleControlRequest('session.detach', sibling, {}, deps)).ok).toBe(true);
      expect(siblingRuntime?.signal.aborted).toBe(true);
      expect(harness.closes).toBe(2);
    } finally {
      release.resolve();
      await pending;
    }
  });

  it('does not let a failed duplicate attachment release a successful root', async () => {
    const harness = createRegistry();
    const deps = createHandlerDeps(harness.registry);
    const identity = rootIdentity(path.join(tmpDir, 'shared'));
    const restoring = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const pending = applySessionAttach(
      identity,
      { kilo: auth },
      {
        ...deps,
        sessionExists: async () => false,
        restoreSession: async () => {
          restoring.resolve();
          await release.promise;
          return { ok: false, error: 'restore failed', code: 502, step: 'download' };
        },
      }
    );
    try {
      await restoring.promise;
      expect(
        (await handleControlRequest('session.attach', identity, { kilo: auth }, deps)).ok
      ).toBe(true);
      const runtime = harness.registry.get(identity);
      release.resolve();
      expect((await pending).ok).toBe(false);
      expect(harness.registry.get(identity)).toBe(runtime);
      expect(rootForSession(identity.kiloSessionId)).toBe(identity.kiloSessionId);
      expect(harness.closes).toBe(0);
      expect((await handleControlRequest('session.detach', identity, {}, deps)).ok).toBe(true);
      expect(harness.closes).toBe(1);
      expect(runtime?.signal.aborted).toBe(true);
    } finally {
      release.resolve();
      await pending;
    }
  });

  it('fences a detached restore from reattaching over a replacement root while its sibling stays live', async () => {
    const harness = createRegistry();
    const deps = createHandlerDeps(harness.registry);
    const sibling = rootIdentity(path.join(tmpDir, 'shared'), 'sibling');
    const identity = rootIdentity(sibling.directory, 'first');
    expect((await handleControlRequest('session.attach', sibling, { kilo: auth }, deps)).ok).toBe(
      true
    );
    const siblingRuntime = harness.registry.get(sibling);
    const restoring = Promise.withResolvers<AbortSignal>();
    const release = Promise.withResolvers<void>();
    const pending = applySessionAttach(
      identity,
      { kilo: auth },
      {
        ...deps,
        sessionExists: async () => false,
        restoreSession: async (_id, _directory, _file, options) => {
          if (!options?.signal) throw new Error('Expected restore cancellation signal');
          restoring.resolve(options.signal);
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
      const signal = await restoring.promise;
      expect(rootForSession(identity.kiloSessionId)).toBe(identity.kiloSessionId);
      rememberChildSession({ childId: 'old_child', parentId: identity.kiloSessionId });
      expect(rootForSession('old_child')).toBe(identity.kiloSessionId);
      expect((await handleControlRequest('session.detach', identity, {}, deps)).ok).toBe(true);
      expect(rootForSession(identity.kiloSessionId)).toBeUndefined();
      expect(rootForSession('old_child')).toBeUndefined();
      expect(signal.aborted).toBe(true);
      expect(siblingRuntime?.signal.aborted).toBe(false);
      expect(
        (await handleControlRequest('session.attach', identity, { kilo: auth }, deps)).ok
      ).toBe(true);
      rememberChildSession({ childId: 'replacement_child', parentId: identity.kiloSessionId });
      release.resolve();
      expect((await pending).ok).toBe(false);
      const replacementRuntime = harness.registry.get(identity);
      expect(replacementRuntime).toBeDefined();
      expect(replacementRuntime).not.toBe(siblingRuntime);
      expect(rootForSession(identity.kiloSessionId)).toBe(identity.kiloSessionId);
      expect(rootForSession('replacement_child')).toBe(identity.kiloSessionId);
      expect(rootForSession('old_child')).toBeUndefined();
      expect(rootForSession(sibling.kiloSessionId)).toBe(sibling.kiloSessionId);
      expect(
        (
          await handleControlRequest(
            'session.terminal.create',
            identity,
            {
              operationId: crypto.randomUUID(),
            },
            deps
          )
        ).ok
      ).toBe(true);
      expect(harness.closes).toBe(1);
      expect(harness.launches).toHaveLength(3);
    } finally {
      release.resolve();
      await pending;
    }
  });

  it('cancels detached workspace preparation before marking it complete and permits retry', async () => {
    const harness = createRegistry();
    const deps = createHandlerDeps(harness.registry);
    const identity = rootIdentity(path.join(tmpDir, 'shared'));
    const preparing = Promise.withResolvers<AbortSignal | undefined>();
    const release = Promise.withResolvers<void>();
    let markers = 0;
    const preparation: ApplyAttachDeps = {
      ...deps,
      hasBootstrapMarker: async () => false,
      runSetup: async (_command, _directory, _env, _output, signal) => {
        preparing.resolve(signal);
        await release.promise;
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      writeBootstrapMarker: async () => {
        markers += 1;
      },
    };
    const pending = applySessionAttach(
      identity,
      { kilo: auth, setupCommands: ['prepare'] },
      preparation
    );
    try {
      const signal = await preparing.promise;
      expect((await handleControlRequest('session.detach', identity, {}, deps)).ok).toBe(true);
      expect(signal?.aborted).toBe(true);
      expect(harness.closes).toBe(1);
      const replacement = handleControlRequest(
        'session.attach',
        identity,
        {
          kilo: { ...auth, token: 'replacement' },
        },
        deps
      );
      release.resolve();
      expect((await pending).ok).toBe(false);
      expect(await replacement).toEqual({ ok: true, result: { attached: true } });
      expect(markers).toBe(0);
      expect(rootForSession(identity.kiloSessionId)).toBe(identity.kiloSessionId);
      expect(harness.registry.get(identity)?.env.KILOCODE_TOKEN).toBe('replacement');
    } finally {
      release.resolve();
      await pending;
    }
  });
});

describe('explicit Kilo child launcher', () => {
  function launchEnvironment(script: string) {
    const bin = path.join(tmpDir, 'bin');
    const directory = path.join(tmpDir, 'workspace');
    fs.mkdirSync(bin);
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(bin, 'kilo'), `#!${process.execPath}\n${script}`, { mode: 0o755 });
    const env = buildWorktreeKiloEnvironment(
      directory,
      path.join(tmpDir, 'home'),
      auth,
      {
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        PID_PATH: path.join(tmpDir, 'child.pid'),
      },
      inherited
    );
    const abort = new AbortController();
    aborts.push(abort);
    return { directory, env, signal: abort.signal, abort };
  }

  it('starts with the explicit cwd/env, handles split readiness output, and stops on close', async () => {
    const options = launchEnvironment(`
const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch: () => Response.json({
    pid: process.pid,
    cwd: process.cwd(),
    args: process.argv.slice(2),
    token: process.env.KILOCODE_TOKEN,
    home: process.env.HOME,
    config: process.env.KILO_CONFIG_CONTENT,
    control: process.env.SANDBOX_CONTROL_CREDENTIAL,
    github: process.env.GH_TOKEN,
  }),
});
const line = 'kilo server listening on ' + server.url.origin + '\\n';
process.stdout.write(line.slice(0, -3));
setTimeout(() => process.stdout.write(line.slice(-3)), 25);
`);
    const handle = await startWorktreeKiloServer(options);
    const state = (await (await fetch(handle.url)).json()) as {
      pid: number;
      cwd: string;
      args: string[];
      token: string;
      home: string;
      config: string;
    };
    expect(state).toEqual({
      pid: expect.any(Number),
      cwd: fs.realpathSync(options.directory),
      args: ['serve', '--hostname=127.0.0.1', '--port=0'],
      token: auth.token,
      home: options.env.HOME,
      config: options.env.KILO_CONFIG_CONTENT,
    });
    handle.close();
    handle.close();
    await waitUntil(() => {
      try {
        process.kill(state.pid, 0);
        return false;
      } catch {
        return true;
      }
    });
  });

  it('exposes actual child exit rather than treating SIGTERM delivery as stopped', async () => {
    const options = launchEnvironment(`
import fs from 'node:fs';
fs.writeFileSync(process.env.PID_PATH, String(process.pid));
process.on('SIGTERM', () => fs.writeFileSync(process.env.PID_PATH + '.sigterm', 'received'));
setInterval(() => {
  if (fs.existsSync(process.env.PID_PATH + '.exit')) process.exit(0);
}, 10);
console.log('kilo server listening on http://127.0.0.1:12345');
`);
    const handle = await startWorktreeKiloServer(options);
    const pid = Number(fs.readFileSync(options.env.PID_PATH, 'utf8'));
    let exited = false;
    const stopped = handle.stopped.then(() => {
      exited = true;
    });
    try {
      handle.close();
      handle.close();
      await waitUntil(() => fs.existsSync(`${options.env.PID_PATH}.sigterm`));
      expect(exited).toBe(false);
      expect(() => process.kill(pid, 0)).not.toThrow();
      fs.writeFileSync(`${options.env.PID_PATH}.exit`, 'exit');
      await stopped;
      expect(exited).toBe(true);
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      fs.writeFileSync(`${options.env.PID_PATH}.exit`, 'exit');
      handle.close();
      await stopped;
    }
  });

  it('terminates a startup timeout and does not expose child output in errors', async () => {
    const options = launchEnvironment(`
await Bun.write(process.env.PID_PATH, String(process.pid));
console.error('actual-managed-token');
setInterval(() => {}, 1000);
`);
    expect(await rejected(startWorktreeKiloServer({ ...options, timeoutMs: 500 }))).toMatchObject({
      message: 'Kilo server failed to start',
    });
    const pid = Number(fs.readFileSync(options.env.PID_PATH, 'utf8'));
    await waitUntil(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    });
  });

  it('does not spawn when the worktree has already shut down', async () => {
    const options = launchEnvironment(
      `await Bun.write(process.env.PID_PATH, String(process.pid));`
    );
    options.abort.abort();
    expect(await rejected(startWorktreeKiloServer(options))).toBeInstanceOf(Error);
    expect(fs.existsSync(options.env.PID_PATH)).toBe(false);
  });

  it('retires both roots that share a native process without stopping an isolated runtime', async () => {
    const sharedProcesses = { stop: async () => true } as unknown as OwnedProcessScope;
    const registry = createWorktreeKiloRuntimes({
      homeRoot: path.join(tmpDir, 'homes'),
      inheritedEnv: inherited,
      startServer: async options => {
        proveOwnedProcesses(options);
        const server = createKiloStub();
        servers.push(server);
        options.onProcessScope?.(sharedProcesses);
        return { url: server.url, close: () => {} };
      },
      onUnexpectedClose: () => {},
    });
    registries.push(registry);
    const sharedDirectory = path.join(tmpDir, 'shared');
    const isolatedDirectory = path.join(tmpDir, 'isolated');
    const first = registry.attach(rootIdentity(sharedDirectory, 'first'), auth);
    const runtime = await first.ready;
    first.commit();
    const sibling = registry.attach(rootIdentity(sharedDirectory, 'second'), auth);
    await sibling.ready;
    sibling.commit();
    const isolated = registry.attach(rootIdentity(isolatedDirectory, 'isolated'), {
      ...auth,
      scopeId: 'worktree_isolated',
    });
    const isolatedRuntime = await isolated.ready;
    isolated.commit();

    expect(
      await registry.retireRuntime?.(sharedDirectory, Date.now() + 1_000, {
        runtimeId: runtime.runtimeId ?? '',
        client: runtime.kiloClient,
      })
    ).toBe('retired');
    expect(first.signal.aborted).toBe(true);
    expect(sibling.signal.aborted).toBe(true);
    expect(registry.getRetained?.(sharedDirectory)).toBeUndefined();
    expect(registry.getRetained?.(isolatedDirectory)).toBe(isolatedRuntime);
  });

  it('aborts the second isolated runtime through handler dependencies without stopping its sibling', async () => {
    const registry = createWorktreeKiloRuntimes({
      homeRoot: path.join(tmpDir, 'homes'),
      inheritedEnv: inherited,
      startServer: async options => {
        const server = createKiloStub();
        servers.push(server);
        options.onProcessScope?.({
          spawn: () => {
            throw new Error('Unexpected process spawn');
          },
          run: operation => operation(),
          seal: () => {},
          dispose: () => true,
          observesOccupancy: () => true,
          captureBaseline: async () => {},
          stop: async () => true,
          verify: async () => true,
        });
        return { url: server.url, close: () => {} };
      },
      onUnexpectedClose: () => {},
    });
    registries.push(registry);
    const directory = path.join(tmpDir, 'shared');
    const firstIdentity = rootIdentity(directory, 'first');
    const secondIdentity = rootIdentity(directory, 'second');
    const first = registry.attach(firstIdentity, auth, {}, undefined, 'per-session');
    const firstRuntime = await first.ready;
    first.commit();
    const second = registry.attach(secondIdentity, auth, {}, undefined, 'per-session');
    const secondRuntime = await second.ready;
    second.commit();
    const target = { runtimeId: secondRuntime.runtimeId, client: secondRuntime.kiloClient };

    expect(registry.getRetained?.(directory, secondRuntime.runtimeId)).toBe(secondRuntime);
    expect(await registry.verifyQuiescence?.(directory, target, Date.now() + 1_000)).toBe(true);
    const handlerDeps = createHandlerDeps(registry);
    expect(
      await handleControlRequest(
        'session.abort',
        secondIdentity,
        { nativeRuntimeId: secondRuntime.runtimeId, cleanupDeadlineAt: Date.now() + 1_000 },
        handlerDeps
      )
    ).toMatchObject({
      ok: true,
      result: {
        status: 'aborted',
        quiescent: true,
        runtimeRetired: true,
        nativeRuntimeId: secondRuntime.runtimeId,
      },
    });
    expect(second.signal.aborted).toBe(true);
    expect(first.signal.aborted).toBe(false);
    expect(registry.get(firstIdentity)).toBe(firstRuntime);
    expect(registry.getRetained?.(directory, secondRuntime.runtimeId)).toBeUndefined();
    expect(await registry.retireRuntime?.(directory, Date.now() + 1_000, target)).toBe('stale');
    expect(first.signal.aborted).toBe(false);
  });

  it('keeps positive process-death proof authoritative after the cleanup deadline', async () => {
    const harness = createSharedRegistry();
    const directory = path.join(tmpDir, 'deadline');
    const runtime = await harness.registry.ensure(directory, auth);

    expect(
      await harness.registry.retireRuntime?.(directory, Date.now() - 1, {
        runtimeId: runtime.runtimeId,
        client: runtime.kiloClient,
      })
    ).toBe('retired');
    expect(harness.registry.get(directory)).toBeUndefined();
  });

  it('retains failed native cleanup ownership without affecting another runtime', async () => {
    const unresolvedProcesses = { stop: async () => false } as unknown as OwnedProcessScope;
    const registry = createWorktreeKiloRuntimes({
      homeRoot: path.join(tmpDir, 'homes'),
      inheritedEnv: inherited,
      startServer: async options => {
        const server = createKiloStub();
        servers.push(server);
        options.onProcessScope?.(unresolvedProcesses);
        return { url: server.url, close: () => {} };
      },
      onUnexpectedClose: () => {},
    });
    registries.push(registry);
    const failedDirectory = path.join(tmpDir, 'failed');
    const isolatedDirectory = path.join(tmpDir, 'isolated');
    const first = registry.attach(rootIdentity(failedDirectory, 'first'), auth);
    const runtime = await first.ready;
    first.commit();
    const sibling = registry.attach(rootIdentity(failedDirectory, 'second'), auth);
    await sibling.ready;
    sibling.commit();
    const isolated = registry.attach(rootIdentity(isolatedDirectory, 'isolated'), {
      ...auth,
      scopeId: 'worktree_isolated',
    });
    const isolatedRuntime = await isolated.ready;
    isolated.commit();

    expect(
      await registry.retireRuntime?.(failedDirectory, Date.now() + 1_000, {
        runtimeId: runtime.runtimeId ?? '',
        client: runtime.kiloClient,
      })
    ).toBe('unconfirmed');
    expect(first.signal.aborted).toBe(true);
    expect(sibling.signal.aborted).toBe(true);
    expect(registry.getRetained?.(failedDirectory)).toBe(runtime);
    expect(registry.getRetained?.(isolatedDirectory)).toBe(isolatedRuntime);
    expect(() => registry.attach(rootIdentity(failedDirectory, 'retry'), auth)).toThrow(
      'Native runtime retirement is unconfirmed'
    );
  });

  it('re-observes an unconfirmed runtime only for an authorized attach demand', async () => {
    const absent = Promise.withResolvers<boolean>();
    const exited = Promise.withResolvers<void>();
    let launches = 0;
    let observations = 0;
    const harness = createSharedRegistry({
      startServer: async options => {
        const server = createKiloStub();
        servers.push(server);
        const first = launches++ === 0;
        options.onProcessScope?.({
          stop: async () => false,
          verify: async () => {
            observations += 1;
            return first ? absent.promise : true;
          },
        } as unknown as OwnedProcessScope);
        return {
          url: server.url,
          close: () => {},
          ...(first ? { exited: exited.promise } : {}),
        };
      },
    });
    const directory = path.join(tmpDir, 'demand-attach');
    const runtime = await harness.registry.ensure(directory, auth);
    exited.resolve();
    await waitUntil(() => harness.registry.isHealthy() === false);

    expect(() =>
      harness.registry.attach(rootIdentity(directory, 'unauthorized'), {
        ...auth,
        token: 'wrong-token',
      })
    ).toThrow('Kilo worktree auth context mismatch');
    expect(observations).toBe(0);

    expect(() => harness.registry.attach(rootIdentity(directory, 'retry'), auth)).toThrow(
      'Native runtime retirement is unconfirmed'
    );
    await waitUntil(() => observations === 1);
    absent.resolve(true);
    await waitUntil(() => harness.registry.getRetained?.(directory) === undefined);
    expect(harness.registry.isHealthy()).toBe(true);

    const replacement = harness.registry.attach(rootIdentity(directory, 'replacement'), auth);
    expect(await replacement.ready).not.toBe(runtime);
    replacement.commit();
    replacement.release();
  });

  it('awaits the same bounded observation when deleting an unconfirmed runtime', async () => {
    const absent = Promise.withResolvers<boolean>();
    let observations = 0;
    const harness = createSharedRegistry({
      startServer: async options => {
        const server = createKiloStub();
        servers.push(server);
        options.onProcessScope?.({
          stop: async () => false,
          verify: async () => {
            observations += 1;
            return absent.promise;
          },
        } as unknown as OwnedProcessScope);
        return { url: server.url, close: () => {} };
      },
    });
    const directory = path.join(tmpDir, 'demand-delete');
    const runtime = await harness.registry.ensure(directory, auth);
    harness.registry.detach(rootIdentity(directory));
    await waitUntil(() => harness.registry.getRetained?.(directory) === runtime);

    let settled = false;
    const deletion = harness.registry.deleteDirectory(directory).then(() => {
      settled = true;
    });
    await waitUntil(() => observations === 1);
    expect(settled).toBe(false);
    absent.resolve(true);
    await deletion;
    expect(settled).toBe(true);
    expect(harness.registry.getRetained?.(directory)).toBeUndefined();
    expect(fs.existsSync(runtime.env.HOME)).toBe(false);
  });

  it('deletes homes after concurrent attach observation already proved death', async () => {
    const absent = Promise.withResolvers<boolean>();
    let observations = 0;
    const harness = createSharedRegistry({
      startServer: async options => {
        const server = createKiloStub();
        servers.push(server);
        options.onProcessScope?.({
          stop: async () => false,
          verify: async () => {
            observations += 1;
            return observations === 1 ? absent.promise : false;
          },
        } as unknown as OwnedProcessScope);
        return { url: server.url, close: () => {} };
      },
    });
    const directory = path.join(tmpDir, 'demand-delete-after-attach');
    const runtime = await harness.registry.ensure(directory, auth);
    expect(
      await harness.registry.retireRuntime?.(directory, Date.now() + 1_000, {
        runtimeId: runtime.runtimeId ?? '',
        client: runtime.kiloClient,
      })
    ).toBe('unconfirmed');
    expect(harness.registry.getRetained?.(directory)).toBe(runtime);

    expect(() => harness.registry.attach(rootIdentity(directory, 'retry'), auth)).toThrow(
      'Native runtime retirement is unconfirmed'
    );
    await waitUntil(() => observations === 1);

    const deletion = harness.registry.deleteDirectory(directory);
    absent.resolve(true);
    await deletion;
    expect(harness.registry.getRetained?.(directory)).toBeUndefined();
    expect(fs.existsSync(runtime.env.HOME)).toBe(false);
  });

  it('does not treat a stopped parent as native retirement proof without an owned scope', async () => {
    const stopped = Promise.withResolvers<void>();
    const registry = createWorktreeKiloRuntimes({
      homeRoot: path.join(tmpDir, 'homes'),
      inheritedEnv: inherited,
      startServer: async () => {
        const server = createKiloStub();
        servers.push(server);
        return { url: server.url, close: () => {}, stopped: stopped.promise };
      },
      onUnexpectedClose: () => {},
    });
    registries.push(registry);
    const directory = path.join(tmpDir, 'unowned');
    const attachment = registry.attach(rootIdentity(directory), auth);
    const runtime = await attachment.ready;
    attachment.commit();

    expect(
      await registry.retireRuntime?.(directory, Date.now() + 1_000, {
        runtimeId: runtime.runtimeId ?? '',
        client: runtime.kiloClient,
      })
    ).toBe('unconfirmed');
    expect(attachment.signal.aborted).toBe(true);
    stopped.resolve();
  });

  it('defers failed-root retirement behind a pending sibling and uses a fresh deadline when it becomes sole', async () => {
    const stopDeadlines: number[] = [];
    const rootRetirements: string[] = [];
    const registry = createWorktreeKiloRuntimes({
      homeRoot: path.join(tmpDir, 'homes'),
      inheritedEnv: inherited,
      startServer: async options => {
        const server = createKiloStub();
        servers.push(server);
        options.onProcessScope?.({
          stop: async (deadlineAt: number) => {
            stopDeadlines.push(deadlineAt);
            return true;
          },
        } as unknown as OwnedProcessScope);
        return { url: server.url, close: () => {} };
      },
      onRootRetirement: retirement => {
        if (retirement.result === 'retired') rootRetirements.push(retirement.root);
      },
      onUnexpectedClose: () => {},
    });
    registries.push(registry);
    const directory = path.join(tmpDir, 'shared');
    const first = registry.attach(rootIdentity(directory, 'first'), auth);
    const runtime = await first.ready;
    first.commit();
    first.release();
    const pending = registry.attach(rootIdentity(directory, 'pending'), auth);
    await pending.ready;

    const originalDeadline = Date.now() - 1;
    expect(
      await registry.retireRuntimeIfUnshared?.(
        directory,
        { runtimeId: runtime.runtimeId, client: runtime.kiloClient },
        'root_first',
        originalDeadline,
        'event rejected'
      )
    ).toBe('shared');
    expect(registry.get(directory)).toBe(runtime);
    expect(stopDeadlines).toEqual([]);

    pending.release();
    await waitUntil(() => rootRetirements.includes('root_first'));
    expect(stopDeadlines[0]).toBeGreaterThan(originalDeadline);
    expect(stopDeadlines[0]).toBeLessThanOrEqual(Date.now() + SANDBOX_CONTROL_CLEANUP_TIMEOUT_MS);
    expect(registry.get(directory)).toBeUndefined();
  });

  it('rejects a stale target without retiring the current runtime', async () => {
    const harness = createSharedRegistry();
    const { registry } = harness;
    const directory = path.join(tmpDir, 'stale-target');
    const attachment = registry.attach(rootIdentity(directory), auth);
    const runtime = await attachment.ready;
    attachment.commit();
    attachment.release();

    expect(
      await registry.retireRuntimeIfUnshared?.(
        directory,
        { runtimeId: crypto.randomUUID(), client: runtime.kiloClient },
        'root_stale-target',
        Date.now() + 1_000,
        'stale event'
      )
    ).toBe('stale');
    expect(registry.get(directory)).toBe(runtime);
    expect(harness.closes).toBe(0);
  });

  it('reports immediate root retirement with its captured incarnation even without a deferred intent', async () => {
    const reports: string[] = [];
    const attempts: string[] = [];
    const harness = createSharedRegistry({
      onRootRetirementStarted: retirement => attempts.push(retirement.retirementId),
      onRootRetirement: retirement => {
        reports.push(`${retirement.root}:${retirement.nativeRuntimeId}:${retirement.result}`);
        expect(retirement.retirementId).toBe(attempts[0]);
      },
    });
    const directory = path.join(tmpDir, 'immediate-root-retirement');
    const attachment = harness.registry.attach(rootIdentity(directory), auth);
    const runtime = await attachment.ready;
    attachment.commit();
    attachment.release();
    const target = { runtimeId: runtime.runtimeId, client: runtime.kiloClient };

    expect(
      await harness.registry.retireRuntimeIfUnshared?.(
        directory,
        target,
        'root_immediate-root-retirement',
        Date.now() + 1_000,
        'event rejected'
      )
    ).toBe('retired');
    expect(reports).toEqual([`root_immediate-root-retirement:${runtime.runtimeId}:retired`]);
    expect(attempts).toHaveLength(1);
    expect(harness.closes).toBe(1);
  });

  it('does not settle a current N2 deferred failure from a stale N1 cleanup callback', async () => {
    const harness = createSharedRegistry();
    const { registry } = harness;
    const directory = path.join(tmpDir, 'stale-deferred-target');
    const first = registry.attach(rootIdentity(directory, 'first'), auth);
    const sibling = registry.attach(rootIdentity(directory, 'sibling'), auth);
    const runtime = await first.ready;
    await sibling.ready;
    first.commit();
    sibling.commit();
    first.release();
    sibling.release();
    const currentTarget = { runtimeId: runtime.runtimeId, client: runtime.kiloClient };
    expect(
      await registry.retireRuntimeIfUnshared?.(
        directory,
        currentTarget,
        'root_first',
        Date.now() + 1_000,
        'N2 publication failure'
      )
    ).toBe('shared');
    if (!registry.retireRuntime) throw new Error('Missing runtime retirement API');
    expect(
      await registry.retireRuntime(directory, Date.now() + 1_000, {
        runtimeId: 'N1',
        client: runtime.kiloClient,
      })
    ).toBe('stale');
    expect(registry.get(directory)).toBe(runtime);

    registry.detach(rootIdentity(directory, 'sibling'));
    await waitUntil(() => registry.get(directory) === undefined);
    expect(harness.closes).toBe(1);
  });

  it('does not report physical unconfirmed unregistration as explicit root disappearance', async () => {
    const rootRetirements: NativeRetirement[] = [];
    const disappearedRoots: string[] = [];
    const server = createKiloStub();
    servers.push(server);
    const harness = createSharedRegistry({
      startServer: async options => {
        options.onProcessScope?.({
          stop: async (_deadlineAt: number) => false,
        } as unknown as OwnedProcessScope);
        return { url: server.url, close: () => {} };
      },
      onRootRetirement: retirement => rootRetirements.push(retirement.result),
      onRootDisappeared: disappearance => disappearedRoots.push(disappearance.root),
    });
    const directory = path.join(tmpDir, 'unconfirmed-unregistration');
    const first = harness.registry.attach(rootIdentity(directory, 'first'), auth);
    const sibling = harness.registry.attach(rootIdentity(directory, 'sibling'), auth);
    const runtime = await first.ready;
    await sibling.ready;
    first.commit();
    sibling.commit();
    first.release();
    sibling.release();
    expect(
      await harness.registry.retireRuntimeIfUnshared?.(
        directory,
        { runtimeId: runtime.runtimeId, client: runtime.kiloClient },
        'root_first',
        Date.now() + 1_000,
        'event rejected'
      )
    ).toBe('shared');
    harness.registry.detach(rootIdentity(directory, 'sibling'));
    await waitUntil(() => rootRetirements.length > 0);
    expect(rootRetirements).toEqual(['unconfirmed']);
    expect(disappearedRoots).toEqual(['root_sibling']);
  });

  it('does not retire a healthy survivor when multiple failed roots disappear', async () => {
    const harness = createSharedRegistry();
    const { registry } = harness;
    const directory = path.join(tmpDir, 'multiple-failures');
    const roots = ['first', 'second', 'healthy'].map(name => rootIdentity(directory, name));
    const attachments = roots.map(root => registry.attach(root, auth));
    const runtime = await attachments[0]?.ready;
    if (!runtime) throw new Error('Missing native runtime');
    for (const attachment of attachments) {
      attachment.commit();
      attachment.release();
    }
    const target = { runtimeId: runtime.runtimeId, client: runtime.kiloClient };
    expect(
      await registry.retireRuntimeIfUnshared?.(
        directory,
        target,
        roots[0]?.kiloSessionId ?? 'root_first',
        Date.now() + 1_000,
        'first event rejected'
      )
    ).toBe('shared');
    expect(
      await registry.retireRuntimeIfUnshared?.(
        directory,
        target,
        roots[1]?.kiloSessionId ?? 'root_second',
        Date.now() + 1_000,
        'second event rejected'
      )
    ).toBe('shared');

    registry.detach(roots[0]!);
    await Promise.resolve();
    expect(registry.get(directory)).toBe(runtime);
    registry.detach(roots[1]!);
    await Promise.resolve();
    expect(registry.get(directory)).toBe(runtime);
    expect(harness.closes).toBe(0);
  });

  it.each([{ order: ['first', 'second'] as const }, { order: ['second', 'first'] as const }])(
    'retires either failed root when the other failed root detaches first',
    async ({ order }) => {
      const harness = createSharedRegistry();
      const { registry } = harness;
      const directory = path.join(tmpDir, `failed-order-${order[0]}`);
      const first = registry.attach(rootIdentity(directory, 'first'), auth);
      const second = registry.attach(rootIdentity(directory, 'second'), auth);
      const runtime = await first.ready;
      await second.ready;
      first.commit();
      second.commit();
      first.release();
      second.release();
      const target = { runtimeId: runtime.runtimeId, client: runtime.kiloClient };
      expect(
        await registry.retireRuntimeIfUnshared?.(
          directory,
          target,
          'root_first',
          Date.now() + 1_000,
          'first event rejected'
        )
      ).toBe('shared');
      expect(
        await registry.retireRuntimeIfUnshared?.(
          directory,
          target,
          'root_second',
          Date.now() + 1_000,
          'second event rejected'
        )
      ).toBe('shared');

      expect(registry.detach(rootIdentity(directory, order[0]))).toBe(true);
      await waitUntil(() => registry.get(directory) === undefined);
      expect(harness.closes).toBe(1);
    }
  );
});

describe('runtime-to-registry root settlement', () => {
  it('observes and replaces only the failed isolated runtime and clears its stale publication failure', async () => {
    let absent = false;
    let observations = 0;
    let launches = 0;
    const harness = createRegistry({
      startServer: async options => {
        const first = launches++ === 0;
        const server = createKiloStub();
        servers.push(server);
        options.onProcessScope?.({
          stop: async () => !first,
          verify: async () => {
            observations += 1;
            return absent;
          },
        } as unknown as OwnedProcessScope);
        return { url: server.url, close: () => {} };
      },
    });
    const directory = path.join(tmpDir, 'isolated-observation');
    const identityA = rootIdentity(directory, 'a');
    const identityB = rootIdentity(directory, 'b');
    const attachmentA = harness.registry.attach(identityA, auth);
    const runtimeA = await attachmentA.ready;
    attachmentA.commit();
    const attachmentB = harness.registry.attach(identityB, auth);
    const runtimeB = await attachmentB.ready;
    attachmentB.commit();
    const dependencies = createHandlerDeps(harness.registry);
    const failure = {
      directory,
      root: identityA.kiloSessionId,
      nativeRuntimeId: runtimeA.runtimeId,
      target: { runtimeId: runtimeA.runtimeId, client: runtimeA.kiloClient },
      reason: 'isolated publication failure',
      deadlineAt: Date.now() + 1_000,
    };
    const originalCleanup = dependencies.operations.retireRootPublication(failure);
    expect(await originalCleanup).toBe('unconfirmed');
    expect(
      harness.registry.rootRetirementScope?.(directory, failure.target, identityA.kiloSessionId)
    ).toBe('sole');
    expect(
      await harness.registry.retireRuntimeIfUnshared?.(
        directory,
        failure.target,
        identityA.kiloSessionId,
        Date.now() + 1_000
      )
    ).toBe('unconfirmed');
    dependencies.operations.prune();
    expect(dependencies.operations.retireRootPublication(failure)).toBe(originalCleanup);
    expect(harness.registry.get(identityB)).toBe(runtimeB);
    expect(runtimeB.signal.aborted).toBe(false);
    expect(() => harness.registry.attach(identityA, { ...auth, token: 'unauthorized' })).toThrow(
      'Kilo worktree auth context mismatch'
    );
    expect(observations).toBe(0);
    absent = true;
    expect(() => harness.registry.attach(identityA, auth)).toThrow(
      'Native runtime retirement is unconfirmed'
    );
    await waitUntil(
      () => harness.registry.getRetained?.(directory, runtimeA.runtimeId) === undefined
    );
    const replacement = harness.registry.attach(identityA, auth);
    const replacementRuntime = await replacement.ready;
    replacement.commit();
    expect(harness.registry.getEntryRuntimeId?.(directory, identityA.kiloSessionId)).toBe(
      replacementRuntime.runtimeId
    );
    expect(harness.registry.getEntryRuntimeId?.(directory, identityB.kiloSessionId)).toBe(
      runtimeB.runtimeId
    );
    dependencies.operations.prune();
    // A repeated failure can no longer reuse the old runtime's retained claim.
    expect(dependencies.operations.retireRootPublication(failure)).not.toBe(originalCleanup);
    expect(dependencies.operations.admission('session.prompt', identityA, undefined).kind).toBe(
      'continue'
    );
    expect(harness.registry.get(identityB)).toBe(runtimeB);
    expect(runtimeB.signal.aborted).toBe(false);
  });

  it('allows A to reattach after a retained completed operation retires its runtime', async () => {
    const harness = createSharedRegistry();
    const handlerDeps = createHandlerDeps(harness.registry);
    const identity = rootIdentity(path.join(tmpDir, 'retained-abort-reattach'), 'a');
    const prompt = {
      messageId: 'retained_abort_a1',
      turn: { type: 'prompt' as const, prompt: 'completed A work' },
      agent: { mode: 'code', model: 'test' },
    };
    const authorization = operationAuthorization('session.prompt', prompt.messageId, identity);

    expect(
      await handleControlRequest('session.attach', identity, { kilo: auth }, handlerDeps)
    ).toEqual({ ok: true, result: { attached: true } });
    const runtime = harness.registry.get(identity.directory);
    if (!runtime) throw new Error('Missing attached runtime');

    try {
      expect(
        await handleControlRequest('session.prompt', identity, prompt, handlerDeps, authorization)
      ).toMatchObject({
        ok: true,
        result: { messageId: prompt.messageId, status: 'accepted' },
      });
      await waitUntil(() =>
        handlerDeps.operations
          .retained()
          .some(operation => operation.messageId === prompt.messageId)
      );
      const task = handlerDeps.operations
        .retained()
        .find(operation => operation.messageId === prompt.messageId);
      if (!task) throw new Error('Missing retained operation');
      await task.done;
      expect(task.locallyComplete).toBe(true);
      expect(handlerDeps.operations.active(identity.kiloSessionId)).toBeUndefined();
      task.markPublicationScoped('retained publication failure', Date.now() + 1_000);

      expect(
        await handleControlRequest(
          'session.abort',
          identity,
          {
            messageId: prompt.messageId,
            operationId: '33333333-3333-4333-8333-333333333333',
            cleanupDeadlineAt: Date.now() + 1_000,
          },
          handlerDeps
        )
      ).toMatchObject({
        ok: true,
        result: {
          status: 'aborted',
          quiescent: true,
          runtimeRetired: true,
          nativeRuntimeId: runtime.runtimeId,
        },
      });
      expect(harness.registry.get(identity.directory)).toBeUndefined();

      expect(
        await handleControlRequest('session.attach', identity, { kilo: auth }, handlerDeps)
      ).toEqual({ ok: true, result: { attached: true } });
      const replacement = harness.registry.get(identity.directory);
      expect(replacement).toBeDefined();
      expect(replacement).not.toBe(runtime);
      expect(
        (
          await handleControlRequest(
            'session.terminal.create',
            identity,
            { operationId: crypto.randomUUID() },
            handlerDeps
          )
        ).ok
      ).toBe(true);
    } finally {
      await Promise.allSettled(
        handlerDeps.operations.activeOperations().map(operation => operation.done)
      );
    }
  });

  it('allows A to reattach after a sole active abort replaces its runtime', async () => {
    const harness = createSharedRegistry();
    const handlerDeps = createHandlerDeps(harness.registry);
    const identity = rootIdentity(path.join(tmpDir, 'abort-reattach'), 'a');
    expect(
      await handleControlRequest('session.attach', identity, { kilo: auth }, handlerDeps)
    ).toEqual({ ok: true, result: { attached: true } });
    const runtime = harness.registry.get(identity.directory);
    const server = servers.at(-1);
    if (!runtime || !server) throw new Error('Missing attached runtime');
    server.holdPrompts(identity.kiloSessionId);
    const prompt = {
      messageId: 'abort_reattach_a1',
      turn: { type: 'prompt' as const, prompt: 'active A work' },
      agent: { mode: 'code', model: 'test' },
    };
    const promptRequest = handleControlRequest('session.prompt', identity, prompt, handlerDeps);

    try {
      expect(await promptRequest).toEqual({
        ok: true,
        result: { messageId: prompt.messageId, status: 'accepted' },
      });
      await waitUntil(() =>
        server.requests.some(
          request => request.pathname === `/session/${identity.kiloSessionId}/message`
        )
      );
      const task = handlerDeps.operations.active(identity.kiloSessionId);
      if (!task) throw new Error('Missing active operation');
      task.markPublicationScoped('sole publication failure', Date.now() + 1_000);

      expect(
        await handleControlRequest(
          'session.abort',
          identity,
          {
            messageId: prompt.messageId,
            operationId: '11111111-1111-4111-8111-111111111111',
          },
          handlerDeps
        )
      ).toMatchObject({
        ok: true,
        result: {
          status: 'aborted',
          quiescent: true,
          runtimeRetired: true,
          nativeRuntimeId: runtime.runtimeId,
        },
      });
      expect(harness.registry.get(identity.directory)).toBeUndefined();

      expect(
        await handleControlRequest('session.attach', identity, { kilo: auth }, handlerDeps)
      ).toEqual({ ok: true, result: { attached: true } });
      const replacement = harness.registry.get(identity.directory);
      expect(replacement).toBeDefined();
      expect(replacement).not.toBe(runtime);
      expect(
        (
          await handleControlRequest(
            'session.terminal.create',
            identity,
            { operationId: crypto.randomUUID() },
            handlerDeps
          )
        ).ok
      ).toBe(true);
    } finally {
      server.releasePrompts(identity.kiloSessionId);
      await Promise.allSettled([promptRequest]);
    }
  });

  it('detaches A before returning a failed non-scoped abort so A can reattach', async () => {
    const harness = createSharedRegistry({
      startServer: async options => {
        const server = createKiloStub();
        servers.push(server);
        options.onProcessScope?.({
          stop: async () => true,
          verify: async () => true,
        } as unknown as OwnedProcessScope);
        return { url: server.url, close: () => {} };
      },
    });
    const handlerDeps = createHandlerDeps(harness.registry);
    handlerDeps.emitSessionEvent = () => false;
    const identity = rootIdentity(path.join(tmpDir, 'failed-abort-reattach'), 'a');
    expect(
      await handleControlRequest('session.attach', identity, { kilo: auth }, handlerDeps)
    ).toEqual({ ok: true, result: { attached: true } });
    const runtime = harness.registry.get(identity.directory);
    const server = servers.at(-1);
    if (!runtime || !server) throw new Error('Missing attached runtime');
    server.holdPrompts(identity.kiloSessionId);
    const prompt = {
      messageId: 'failed_abort_a1',
      turn: { type: 'prompt' as const, prompt: 'active A work' },
      agent: { mode: 'code', model: 'test' },
    };
    const promptRequest = handleControlRequest('session.prompt', identity, prompt, handlerDeps);

    try {
      expect(await promptRequest).toEqual({
        ok: true,
        result: { messageId: prompt.messageId, status: 'accepted' },
      });
      await waitUntil(() =>
        server.requests.some(
          request => request.pathname === `/session/${identity.kiloSessionId}/message`
        )
      );

      expect(
        await handleControlRequest(
          'session.abort',
          identity,
          { messageId: prompt.messageId },
          handlerDeps
        )
      ).toEqual({
        ok: false,
        error: { code: 'not_ready', message: 'Session outcome delivery failed', retryable: false },
      });
      expect(
        server.requests.some(
          request => request.pathname === `/session/${identity.kiloSessionId}/abort`
        )
      ).toBe(true);
      expect(
        await harness.registry.retireRuntime?.(identity.directory, Date.now() + 1_000, {
          runtimeId: runtime.runtimeId,
          client: runtime.kiloClient,
        })
      ).toBe('retired');
      expect(harness.registry.get(identity.directory)).toBeUndefined();

      expect(
        await handleControlRequest('session.attach', identity, { kilo: auth }, handlerDeps)
      ).toEqual({ ok: true, result: { attached: true } });
      const replacement = harness.registry.get(identity.directory);
      expect(replacement).toBeDefined();
      expect(replacement).not.toBe(runtime);
      expect(
        (
          await handleControlRequest(
            'session.terminal.create',
            identity,
            { operationId: crypto.randomUUID() },
            handlerDeps
          )
        ).ok
      ).toBe(true);
    } finally {
      server.releasePrompts(identity.kiloSessionId);
      await Promise.allSettled([promptRequest]);
    }
  });

  it('keeps B attached while A aborts and reattaches on a shared runtime', async () => {
    const harness = createSharedRegistry();
    const handlerDeps = createHandlerDeps(harness.registry);
    handlerDeps.scopedCleanupResult = true;
    const directory = path.join(tmpDir, 'shared-abort-reattach');
    const identityA = rootIdentity(directory, 'a');
    const identityB = rootIdentity(directory, 'b');
    for (const identity of [identityA, identityB]) {
      expect(
        await handleControlRequest('session.attach', identity, { kilo: auth }, handlerDeps)
      ).toEqual({ ok: true, result: { attached: true } });
    }
    const runtime = harness.registry.get(directory);
    const server = servers.at(-1);
    if (!runtime || !server) throw new Error('Missing shared runtime');
    server.holdPrompts(identityA.kiloSessionId);
    const prompt = {
      messageId: 'shared_abort_a1',
      turn: { type: 'prompt' as const, prompt: 'active A work' },
      agent: { mode: 'code', model: 'test' },
    };
    const promptRequest = handleControlRequest('session.prompt', identityA, prompt, handlerDeps);

    try {
      expect(await promptRequest).toEqual({
        ok: true,
        result: { messageId: prompt.messageId, status: 'accepted' },
      });
      await waitUntil(() =>
        server.requests.some(
          request => request.pathname === `/session/${identityA.kiloSessionId}/message`
        )
      );
      const taskA = handlerDeps.operations.active(identityA.kiloSessionId);
      if (!taskA) throw new Error('Missing A operation');
      taskA.markPublicationScoped('shared publication failure', Date.now() + 1_000);

      expect(
        await handleControlRequest(
          'session.abort',
          identityA,
          {
            messageId: prompt.messageId,
            operationId: '22222222-2222-4222-8222-222222222222',
            cleanupDeadlineAt: Date.now() + 1_000,
          },
          handlerDeps
        )
      ).toMatchObject({
        ok: true,
        result: { status: 'unconfirmed', quiescent: false, cleanupScope: 'root' },
      });
      expect(rootForSession(identityB.kiloSessionId, directory)).toBe(identityB.kiloSessionId);
      expect(harness.registry.get(directory)).toBe(runtime);

      await Promise.all(handlerDeps.operations.activeOperations().map(operation => operation.done));
      expect(
        (
          await handleControlRequest(
            'session.terminal.create',
            identityB,
            { operationId: crypto.randomUUID() },
            handlerDeps
          )
        ).ok
      ).toBe(true);
      expect(
        await handleControlRequest('session.attach', identityA, { kilo: auth }, handlerDeps)
      ).toEqual({ ok: true, result: { attached: true } });
      expect(harness.registry.get(directory)).toBe(runtime);
      expect(
        (
          await handleControlRequest(
            'session.terminal.create',
            identityA,
            { operationId: crypto.randomUUID() },
            handlerDeps
          )
        ).ok
      ).toBe(true);
    } finally {
      server.releasePrompts(identityA.kiloSessionId);
      await Promise.allSettled([promptRequest]);
      await Promise.allSettled(
        handlerDeps.operations.activeOperations().map(operation => operation.done)
      );
    }
  });

  it('isolates a user Stop from B when both shared roots have active prompts', async () => {
    const integrated = createIntegratedRegistry();
    const directory = path.join(tmpDir, 'shared-user-stop');
    const identityA = rootIdentity(directory, 'a');
    const identityB = rootIdentity(directory, 'b');
    for (const identity of [identityA, identityB]) {
      expect(
        await handleControlRequest(
          'session.attach',
          identity,
          { kilo: auth },
          integrated.handlerDeps
        )
      ).toEqual({ ok: true, result: { attached: true } });
    }
    const runtime = integrated.registry.get(directory);
    const server = servers.at(-1);
    if (!runtime || !server) throw new Error('Missing shared runtime');
    for (const identity of [identityA, identityB]) {
      expect(
        (
          await handleControlRequest(
            'session.terminal.create',
            identity,
            { operationId: crypto.randomUUID() },
            integrated.handlerDeps
          )
        ).ok
      ).toBe(true);
    }

    integrated.handlerDeps.scopedCleanupResult = true;
    server.holdPrompts(identityA.kiloSessionId);
    server.holdPrompts(identityB.kiloSessionId);
    server.sessionStatuses[identityA.kiloSessionId] = { type: 'busy' };
    server.sessionStatuses[identityB.kiloSessionId] = { type: 'busy' };
    const promptA = {
      messageId: 'user_stop_a1',
      turn: { type: 'prompt' as const, prompt: 'active A work' },
      agent: { mode: 'code', model: 'test' },
    };
    const promptB = {
      ...promptA,
      messageId: 'user_stop_b1',
      turn: { type: 'prompt' as const, prompt: 'active B work' },
    };
    const promptARequest = handleControlRequest(
      'session.prompt',
      identityA,
      promptA,
      integrated.handlerDeps
    );
    const promptBRequest = handleControlRequest(
      'session.prompt',
      identityB,
      promptB,
      integrated.handlerDeps
    );
    let taskA: ReturnType<typeof integrated.handlerDeps.operations.active>;
    let taskB: ReturnType<typeof integrated.handlerDeps.operations.active>;
    try {
      expect(await promptARequest).toMatchObject({
        ok: true,
        result: { messageId: promptA.messageId, status: 'accepted' },
      });
      expect(await promptBRequest).toMatchObject({
        ok: true,
        result: { messageId: promptB.messageId, status: 'accepted' },
      });
      await waitUntil(
        () =>
          server.requests.some(
            request => request.pathname === `/session/${identityA.kiloSessionId}/message`
          ) &&
          server.requests.some(
            request => request.pathname === `/session/${identityB.kiloSessionId}/message`
          )
      );
      taskA = integrated.handlerDeps.operations.active(identityA.kiloSessionId);
      taskB = integrated.handlerDeps.operations.active(identityB.kiloSessionId);
      if (!taskA || !taskB) throw new Error('Missing active shared-root operations');
      expect(taskA.signal.aborted).toBe(false);
      expect(taskB.signal.aborted).toBe(false);

      const stopped = await handleControlRequest(
        'session.abort',
        identityA,
        {
          messageId: promptA.messageId,
          operationId: '44444444-4444-4444-8444-444444444444',
          cleanupDeadlineAt: Date.now() + 1_000,
        },
        integrated.handlerDeps
      );
      await taskA.done;
      expect(stopped).toMatchObject({
        ok: true,
        result: { status: 'unconfirmed', quiescent: false, cleanupScope: 'root' },
      });
      expect(stopped).not.toHaveProperty('result.runtimeRetired');
      expect(taskA.cleanup).toBe('unconfirmed');
      expect(taskB.signal.aborted).toBe(false);
      expect(integrated.handlerDeps.operations.active(identityB.kiloSessionId)).toBe(taskB);
      expect(taskB.snapshot().native.state).toBe('pending');
      server.releasePrompts(identityB.kiloSessionId);
      expect(await taskB.done).toMatchObject({ ok: true });
      expect(rootForSession(identityB.kiloSessionId, directory)).toBe(identityB.kiloSessionId);
      expect(integrated.registry.get(directory)).toBe(runtime);
      expect(runtime.signal.aborted).toBe(false);
      expect(integrated.settlements).toEqual([]);

      expect(
        await handleControlRequest(
          'session.attach',
          identityA,
          { kilo: auth },
          integrated.handlerDeps
        )
      ).toEqual({ ok: true, result: { attached: true } });
      for (const identity of [identityB, identityA]) {
        expect(
          (
            await handleControlRequest(
              'session.terminal.create',
              identity,
              { operationId: crypto.randomUUID() },
              integrated.handlerDeps
            )
          ).ok
        ).toBe(true);
      }
      await Promise.resolve();
      expect(integrated.settlements).toEqual([]);
    } finally {
      server.releasePrompts(identityA.kiloSessionId);
      server.releasePrompts(identityB.kiloSessionId);
      await Promise.allSettled([promptARequest, promptBRequest]);
      if (taskA) await Promise.allSettled([taskA.done]);
      if (taskB) await Promise.allSettled([taskB.done]);
    }
  });

  it('does not detach a replacement attachment for a stale native runtime abort', async () => {
    const harness = createSharedRegistry();
    const handlerDeps = createHandlerDeps(harness.registry);
    const identity = rootIdentity(path.join(tmpDir, 'stale-abort-attachment'), 'a');
    expect(
      await handleControlRequest('session.attach', identity, { kilo: auth }, handlerDeps)
    ).toEqual({ ok: true, result: { attached: true } });
    const initial = harness.registry.get(identity.directory);
    if (!initial) throw new Error('Missing initial runtime');

    expect(
      await handleControlRequest(
        'session.abort',
        identity,
        { nativeRuntimeId: initial.runtimeId },
        handlerDeps
      )
    ).toMatchObject({
      ok: true,
      result: {
        status: 'aborted',
        quiescent: true,
        runtimeRetired: true,
        nativeRuntimeId: initial.runtimeId,
      },
    });
    expect(
      await handleControlRequest('session.attach', identity, { kilo: auth }, handlerDeps)
    ).toEqual({ ok: true, result: { attached: true } });
    const replacement = harness.registry.get(identity.directory);
    if (!replacement) throw new Error('Missing replacement runtime');
    expect(replacement).not.toBe(initial);

    expect(
      await handleControlRequest(
        'session.abort',
        identity,
        { nativeRuntimeId: initial.runtimeId },
        handlerDeps
      )
    ).toEqual({
      ok: true,
      result: {
        status: 'aborted',
        quiescent: true,
        runtimeRetired: true,
        nativeRuntimeId: initial.runtimeId,
      },
    });
    expect(
      (
        await handleControlRequest(
          'session.terminal.create',
          identity,
          { operationId: crypto.randomUUID() },
          handlerDeps
        )
      ).ok
    ).toBe(true);
  });

  it('keeps a shared runtime alive after confirmed A cleanup, fresh A work, and B detach', async () => {
    const integrated = createIntegratedRegistry();
    const directory = path.join(tmpDir, 'confirmed-shared-runtime');
    const identityA = rootIdentity(directory, 'a');
    const identityB = rootIdentity(directory, 'b');
    expect(
      await handleControlRequest(
        'session.attach',
        identityA,
        { kilo: auth },
        integrated.handlerDeps
      )
    ).toMatchObject({
      ok: true,
    });
    expect(
      await handleControlRequest(
        'session.attach',
        identityB,
        { kilo: auth },
        integrated.handlerDeps
      )
    ).toMatchObject({
      ok: true,
    });
    const runtime = integrated.registry.get(directory);
    const server = servers.at(-1);
    if (!runtime || !server) throw new Error('Missing shared runtime');
    server.holdPrompts(identityA.kiloSessionId);
    const prompt = {
      messageId: 'confirmed_a1',
      turn: { type: 'prompt' as const, prompt: 'confirm root cleanup' },
      agent: { mode: 'code', model: 'test' },
    };
    const promptRequest = handleControlRequest(
      'session.prompt',
      identityA,
      prompt,
      integrated.handlerDeps
    );
    const waitForTasks = () =>
      Promise.all(integrated.handlerDeps.operations.activeOperations().map(task => task.done));
    try {
      await waitUntil(
        () =>
          integrated.handlerDeps.operations.active(identityA.kiloSessionId)?.snapshot().native
            .state === 'pending'
      );
      const escalation = integrated.handlerDeps.operations.escalateRootPublication({
        directory,
        root: identityA.kiloSessionId,
        nativeRuntimeId: runtime.runtimeId,
        target: { runtimeId: runtime.runtimeId, client: runtime.kiloClient },
        reason: 'confirmed publication cleanup',
        deadlineAt: Date.now() + 1_000,
      });
      expect(await escalation.physical).toMatchObject({
        scope: 'root',
        status: 'aborted',
        cleanup: 'confirmed',
        physical: 'not_attempted',
        quiescent: false,
        runtimeRetired: false,
      });
      expect(integrated.registry.get(directory)).toBe(runtime);
      await promptRequest;
      await waitForTasks();

      const freshPrompt = {
        ...prompt,
        messageId: 'confirmed_a2',
        turn: { type: 'prompt' as const, prompt: 'fresh A work' },
      };
      expect(
        await handleControlRequest('session.prompt', identityA, freshPrompt, integrated.handlerDeps)
      ).toMatchObject({ ok: true, result: { status: 'accepted' } });
      await waitForTasks();
      expect(integrated.registry.get(directory)).toBe(runtime);

      expect(integrated.registry.detach(identityB)).toBe(true);
      expect(integrated.registry.get(directory)).toBe(runtime);
      expect(runtime.signal.aborted).toBe(false);
      expect(integrated.closes).toBe(0);
    } finally {
      server.releasePrompts(identityA.kiloSessionId);
      await Promise.allSettled([promptRequest]);
      await waitForTasks();
    }
  });

  it('uses current membership when B attaches while sole-root cleanup is polling', async () => {
    const integrated = createIntegratedRegistry();
    const directory = path.join(tmpDir, 'membership-interleaving');
    const identityA = rootIdentity(directory, 'a');
    const identityB = rootIdentity(directory, 'b');
    expect(
      await handleControlRequest(
        'session.attach',
        identityA,
        { kilo: auth },
        integrated.handlerDeps
      )
    ).toMatchObject({ ok: true });
    const runtime = integrated.registry.get(directory);
    const server = servers.at(-1);
    if (!runtime || !server) throw new Error('Missing sole runtime');
    server.holdPrompts(identityA.kiloSessionId);
    server.sessionStatuses[identityA.kiloSessionId] = { type: 'busy' };
    const promptRequest = handleControlRequest(
      'session.prompt',
      identityA,
      {
        messageId: 'interleave_a',
        turn: { type: 'prompt' as const, prompt: 'A cleanup' },
        agent: { mode: 'code', model: 'test' },
      },
      integrated.handlerDeps
    );
    try {
      await waitUntil(
        () =>
          integrated.handlerDeps.operations.active(identityA.kiloSessionId)?.snapshot().native
            .state === 'pending'
      );
      const escalation = integrated.handlerDeps.operations.escalateRootPublication({
        directory,
        root: identityA.kiloSessionId,
        nativeRuntimeId: runtime.runtimeId,
        target: { runtimeId: runtime.runtimeId, client: runtime.kiloClient },
        reason: 'interleaved publication failure',
        deadlineAt: Date.now() + 1_000,
      });
      const attachmentB = integrated.registry.attach(identityB, auth);
      await attachmentB.ready;
      attachmentB.commit();
      attachmentB.release();
      server.sessionStatuses[identityA.kiloSessionId] = { type: 'idle' };

      const disposition = await escalation.physical;
      expect(disposition).toMatchObject({
        scope: 'root',
        physical: 'not_attempted',
        runtimeRetired: false,
        quiescent: false,
      });
      expect(integrated.registry.get(directory)).toBe(runtime);
      expect(runtime.signal.aborted).toBe(false);
    } finally {
      server.releasePrompts(identityA.kiloSessionId);
      await Promise.allSettled([promptRequest]);
    }
  });

  it('settles a non-deferred scoped record when failRuntime retires the runtime', async () => {
    const exited = Promise.withResolvers<void>();
    const server = createKiloStub();
    servers.push(server);
    const integrated = createIntegratedRegistry({
      startServer: async options => {
        options.onProcessScope?.({ stop: async () => true } as unknown as OwnedProcessScope);
        return { url: server.url, close: () => {}, exited: exited.promise };
      },
    });
    const directory = path.join(tmpDir, 'settled-failure-record');
    const attachment = integrated.registry.attach(rootIdentity(directory), auth);
    const runtime = await attachment.ready;
    attachment.commit();
    attachment.release();
    const input = {
      directory,
      root: `root_${path.basename(directory)}`,
      nativeRuntimeId: runtime.runtimeId,
      target: { runtimeId: runtime.runtimeId, client: runtime.kiloClient },
      reason: 'event rejected',
      deadlineAt: Date.now() + 1_000,
    };
    expect(await integrated.handlerDeps.operations.retireRootPublication(input)).toBe(
      'unconfirmed'
    );

    exited.resolve();
    await waitUntil(() =>
      integrated.settlements.some(
        settlement => settlement.root === input.root && settlement.result === 'retired'
      )
    );
    expect(integrated.registry.get(directory)).toBeUndefined();
    rememberAttachedRoot(input.root, directory);
    expect(
      integrated.handlerDeps.operations.admission(
        'session.prompt',
        rootIdentity(directory),
        undefined
      ).kind
    ).toBe('continue');
  });

  it('preserves a non-deferred scoped record when failRuntime retirement is unconfirmed', async () => {
    const exited = Promise.withResolvers<void>();
    const server = createKiloStub();
    servers.push(server);
    const integrated = createIntegratedRegistry({
      startServer: async options => {
        options.onProcessScope?.({ stop: async () => false } as unknown as OwnedProcessScope);
        return { url: server.url, close: () => {}, exited: exited.promise };
      },
    });
    const directory = path.join(tmpDir, 'unconfirmed-failure-record');
    const attachment = integrated.registry.attach(rootIdentity(directory), auth);
    const runtime = await attachment.ready;
    attachment.commit();
    attachment.release();
    const sessionA = rootIdentity(directory);
    const input = {
      directory,
      root: sessionA.kiloSessionId,
      nativeRuntimeId: runtime.runtimeId,
      target: { runtimeId: runtime.runtimeId, client: runtime.kiloClient },
      reason: 'event rejected',
      deadlineAt: Date.now() + 1_000,
    };
    expect(await integrated.handlerDeps.operations.retireRootPublication(input)).toBe(
      'unconfirmed'
    );

    exited.resolve();
    await waitUntil(() =>
      integrated.settlements.some(
        settlement => settlement.root === input.root && settlement.result === 'unconfirmed'
      )
    );
    integrated.handlerDeps.operations.prune();
    rememberAttachedRoot(sessionA.kiloSessionId, directory);
    expect(
      integrated.handlerDeps.operations.admission('session.prompt', sessionA, undefined).kind
    ).toBe('reply');
  });
});
