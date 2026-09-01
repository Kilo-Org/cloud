import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildWorktreeKiloEnvironment,
  createWorktreeKiloRuntimes,
  startWorktreeKiloServer,
  type WorktreeKiloAuth,
  type WorktreeKiloRuntimes,
} from './worktree-runtime';
import {
  sessionMessageOutcomeSchema,
  type SessionEventIdentity,
  type SessionRequestIdentity,
} from '../../../src/shared/sandbox-control-protocol';
import { handleControlRequest, type HandlerDeps } from './sandbox-control-handlers';
import type { WrapperKiloClient } from '../kilo-api';
import {
  ControlTerminalRuntimeError,
  createControlTerminalRuntime,
  type ControlTerminalRuntime,
} from './terminal-runtime';
import { applySessionAttach, type ApplyAttachDeps } from './apply-attach';
import { childFromSessionCreated, eventKiloSessionId, sessionEventIdentity } from './feed';
import {
  directoryForSession,
  rememberChildSession,
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

function createKiloStub() {
  const requests: Array<{ pathname: string; directory: string | null; body?: unknown }> = [];
  const permissions: Awaited<ReturnType<WrapperKiloClient['getPermissions']>> = [];
  const feeds = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const encoder = new TextEncoder();
  let feedConnections = 0;
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
      if (request.method === 'GET' && url.pathname === '/permission') {
        return Response.json(permissions);
      }
      if (request.method === 'POST' && url.pathname.startsWith('/permission/')) {
        const id = decodeURIComponent(url.pathname.split('/')[2]);
        const index = permissions.findIndex(permission => permission.id === id);
        if (index === -1) return new Response('Permission not pending', { status: 404 });
        permissions.splice(index, 1);
        return Response.json(true);
      }
      if (request.method === 'POST' && url.pathname.endsWith('/abort')) {
        return Response.json(true);
      }
      if (request.method === 'POST' && /\/session\/[^/]+\/(message|command)$/.test(url.pathname)) {
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
        return Response.json(completion);
      }
      if (request.method === 'GET' && url.pathname.startsWith('/session/')) {
        return Response.json({ id: decodeURIComponent(url.pathname.slice('/session/'.length)) });
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
    get feedConnections() {
      return feedConnections;
    },
    emit(event: unknown) {
      for (const feed of feeds) feed.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
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

function createRegistry(overrides: Partial<Parameters<typeof createWorktreeKiloRuntimes>[0]> = {}) {
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
      async ensure(directory: string, kilo: WorktreeKiloAuth, env?: Record<string, string>) {
        const attachment = registry.attach(rootIdentity(directory), kilo, env);
        try {
          const runtime = await attachment.ready;
          attachment.commit();
          return runtime;
        } finally {
          attachment.release();
        }
      },
    },
    launches,
    get closes() {
      return closes;
    },
    get unexpectedCloses() {
      return unexpectedCloses;
    },
  };
}

function createHandlerDeps(registry: WorktreeKiloRuntimes): HandlerDeps {
  const terminalRuntime = createControlTerminalRuntime({
    controlUrl: 'ws://127.0.0.1:1/sandbox-control/test',
    wrapperInstanceId: crypto.randomUUID(),
    getKiloRuntime: directory => registry.get(directory),
  });
  terminalRuntimes.push(terminalRuntime);
  return {
    kiloRuntimes: registry,
    terminalRuntime,
    version: 'test',
    kiloReady: true,
    sessions: [],
    tasks: new Map(),
    emitSessionEvent: () => {},
    retireRuntime: () => {},
  };
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

describe('worktree Kilo environments', () => {
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
  it('starts lazily and reuses one server and feed for concurrent same-worktree roots', async () => {
    const { registry, launches } = createRegistry();
    const directory = path.join(tmpDir, 'worktree-a');
    expect(launches).toEqual([]);
    expect(registry.get(directory)).toBeUndefined();

    const [first, second, third] = await Promise.all([
      registry.ensure(directory, auth),
      registry.ensure(directory, auth),
      registry.ensure(directory, { ...auth, targets: { ...auth.targets } }),
    ]);
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(await registry.ensure(directory, auth)).toBe(first);
    expect(registry.get(directory)).toBe(first);
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

  it('routes separate SandboxSession roots sharing a worktree through one SDK runtime', async () => {
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
      getKiloRuntime: directory => harness.registry.get(directory),
    });
    const deps: HandlerDeps = {
      kiloRuntimes: harness.registry,
      terminalRuntime: terminals,
      version: 'test',
      kiloReady: true,
      sessions: [],
      tasks: new Map(),
      emitSessionEvent: (identity, event) => {
        if (event.type === 'session.message.outcome') {
          const { messageId, status } = sessionMessageOutcomeSchema.parse(event.properties);
          outcomes.push({ identity, messageId, status });
        }
      },
      retireRuntime: () => {},
    };
    const waitForTasks = () => Promise.all([...deps.tasks.values()].map(task => task.done));
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
      expect(harness.launches).toHaveLength(2);
      expect(servers.map(server => server.feedConnections)).toEqual([1, 1]);

      for (const identity of identities) {
        const runtime = harness.registry.get(identity.directory);
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
      const runtime = harness.registry.get(first.directory);
      expect(await handleControlRequest('session.detach', second, {}, deps)).toEqual({
        ok: true,
        result: { detached: true },
      });
      expect(harness.registry.get(first.directory)).toBe(runtime);
      expect(harness.closes).toBe(0);
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
      expect(harness.launches).toHaveLength(2);

      expect(await handleControlRequest('session.detach', first, {}, deps)).toEqual({
        ok: true,
        result: { detached: true },
      });
      expect(runtime?.signal.aborted).toBe(true);
      expect(harness.registry.get(first.directory)).toBeUndefined();
      expect(harness.closes).toBe(1);
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
      expect(harness.registry.get(first.directory)).not.toBe(runtime);
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
      expect(harness.launches).toHaveLength(3);
      expect(harness.unexpectedCloses).toBe(0);
    } finally {
      terminals.shutdown();
    }
  });

  it('retires only the final root runtime and permits reuse without affecting another worktree', async () => {
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
    expect(harness.registry.get(directory)).toBe(first);
    expect(sibling.signal.aborted).toBe(false);
    expect(await sibling.ready).toBe(first);
    sibling.commit();
    sibling.release();
    expect(harness.closes).toBe(0);

    expect(harness.registry.detach(siblingIdentity)).toBe(true);
    expect(first.signal.aborted).toBe(true);
    expect(harness.registry.get(directory)).toBeUndefined();
    expect(harness.closes).toBe(1);
    expect(harness.registry.get(other.directory)).toBe(other);
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
    expect(harness.registry.get(other.directory)).toBe(other);
    expect(harness.unexpectedCloses).toBe(0);
    expect(harness.launches).toHaveLength(3);
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

    expect(harness.registry.get(identity.directory)).toBe(runtime);
    expect(harness.closes).toBe(0);
    expect(harness.launches).toHaveLength(1);
    expect(harness.registry.detach(identity)).toBe(true);
    expect(harness.registry.detach(identity)).toBe(false);
    expect(harness.closes).toBe(1);
    expect(runtime.signal.aborted).toBe(true);
  });

  it('rejects mismatched root identities while startup is pending without disturbing ownership', async () => {
    const harness = createRegistry();
    const identity = rootIdentity(path.join(tmpDir, 'shared'));
    const attachment = harness.registry.attach(identity, auth);
    for (const mismatch of [
      { ...identity, directory: path.join(tmpDir, 'other') },
      { ...identity, sessionId: 'workspace_foreign' },
      { ...identity, kiloSessionId: 'root_foreign' },
    ]) {
      expect(() => harness.registry.attach(mismatch, auth)).toThrow('Session identity mismatch');
      expect(() => harness.registry.detach(mismatch)).toThrow('Session identity mismatch');
    }
    const runtime = await attachment.ready;
    attachment.commit();
    expect(harness.registry.get(identity.directory)).toBe(runtime);
    expect(harness.registry.detach(rootIdentity(identity.directory, 'unknown'))).toBe(false);
    expect(harness.closes).toBe(0);
  });

  it('keeps a pending sibling startup alive while cancelling only the detached root', async () => {
    const launched = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const server = createKiloStub();
    servers.push(server);
    let closes = 0;
    const { registry } = createRegistry({
      startServer: async () => {
        launched.resolve();
        await release.promise;
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
    const siblingIdentity = rootIdentity(directory, 'sibling');
    const sibling = registry.attach(siblingIdentity, auth);
    try {
      await launched.promise;
      expect(registry.detach(firstIdentity)).toBe(true);
      expect(first.signal.aborted).toBe(true);
      expect(sibling.signal.aborted).toBe(false);
      release.resolve();
      const runtime = await sibling.ready;
      await first.ready;
      expect(() => first.commit()).toThrow();
      first.release();
      sibling.commit();
      expect(registry.get(directory)).toBe(runtime);
      expect(closes).toBe(0);
      expect(registry.detach(siblingIdentity)).toBe(true);
      expect(closes).toBe(1);
    } finally {
      release.resolve();
      await Promise.allSettled([first.ready, sibling.ready]);
    }
  });

  it('fences late startup and cleanup from a replacement lifetime and its auth files', async () => {
    const launched = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const oldServer = createKiloStub();
    const newServer = createKiloStub();
    servers.push(oldServer, newServer);
    const steps: string[] = [];
    const harness = createRegistry({
      startServer: async options => {
        const old = options.env.KILOCODE_TOKEN === auth.token;
        steps.push(old ? 'start-old' : 'start-new');
        if (old) {
          launched.resolve();
          await release.promise;
        }
        return {
          url: old ? oldServer.url : newServer.url,
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
      old.release();
      await Promise.resolve();
      expect(steps).toEqual(['start-old']);
      release.resolve();
      expect(await oldResult).toMatchObject({ code: 'not_ready' });
      const runtime = await replacement.ready;
      replacement.commit();
      old.release();
      expect(steps).toEqual(['start-old', 'close-old', 'start-new']);
      expect(oldServer.feedConnections).toBe(0);
      expect(newServer.feedConnections).toBe(1);
      expect(harness.registry.get(identity.directory)).toBe(runtime);
      expect(
        JSON.parse(
          fs.readFileSync(path.join(runtime.env.XDG_DATA_HOME, 'kilo', 'auth.json'), 'utf8')
        )
      ).toEqual({
        kilo: { type: 'api', key: 'replacement' },
      });
      expect(() =>
        harness.registry.attach(rootIdentity(path.join(tmpDir, 'other')), {
          ...auth,
          token: 'replacement',
        })
      ).toThrow('Kilo worktree auth context mismatch');
      expect(harness.unexpectedCloses).toBe(0);
    } finally {
      release.resolve();
      await oldResult;
    }
  });

  it('rejects scope, directory, token, and target changes without launching another server', async () => {
    const { registry, launches } = createRegistry();
    const directory = path.join(tmpDir, 'worktree-a');
    await registry.ensure(directory, auth);
    const conflicts = [
      { ...auth, scopeId: 'different-scope' },
      { ...auth, token: 'different-token' },
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
    expect(await rejected(registry.ensure(path.join(tmpDir, 'worktree-b'), auth))).toMatchObject({
      code: 'unauthorized',
    });
    expect(launches).toHaveLength(1);
  });

  it('releases a failed sole attachment and permits retry with fresh auth', async () => {
    let attempts = 0;
    const stub = createKiloStub();
    servers.push(stub);
    const { registry } = createRegistry({
      startServer: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('actual-managed-token');
        return { url: stub.url, close: () => {} };
      },
    });
    const directory = path.join(tmpDir, 'worktree-a');
    expect(await rejected(registry.ensure(directory, auth))).toMatchObject({
      message: 'Kilo worktree failed to start',
    });
    expect(registry.get(directory)).toBeUndefined();
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
    harness.registry.shutdown();
    harness.registry.shutdown();
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);
    expect(harness.closes).toBe(2);
    expect(harness.registry.get(first.directory)).toBeUndefined();
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
      startServer: async () => {
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

  it('invalidates a runtime and reports an unexpected event-feed closure', async () => {
    const harness = createRegistry();
    const runtime = await harness.registry.ensure(path.join(tmpDir, 'a'), auth);
    servers[0]?.endFeeds();
    await waitUntil(() => harness.unexpectedCloses === 1);
    expect(runtime.signal.aborted).toBe(true);
    expect(harness.registry.get(runtime.directory)).toBeUndefined();
    expect(harness.closes).toBe(1);
  });
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
      expect(harness.registry.get(identity.directory)).toBeUndefined();
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
      expect(harness.registry.get(identity.directory)?.env.KILOCODE_TOKEN).toBe('replacement');
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

  it('keeps a restoring sibling alive after the last committed root detaches', async () => {
    const harness = createRegistry();
    const deps = createHandlerDeps(harness.registry);
    const first = rootIdentity(path.join(tmpDir, 'shared'), 'first');
    const sibling = rootIdentity(first.directory, 'sibling');
    expect((await handleControlRequest('session.attach', first, { kilo: auth }, deps)).ok).toBe(
      true
    );
    const runtime = harness.registry.get(first.directory);
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
      expect(runtime?.signal.aborted).toBe(false);
      expect(harness.closes).toBe(0);
      release.resolve();
      expect(await pending).toEqual({ ok: true, result: { attached: true } });
      expect(harness.registry.get(first.directory)).toBe(runtime);
      expect(rootForSession(first.kiloSessionId)).toBeUndefined();
      expect(rootForSession(sibling.kiloSessionId)).toBe(sibling.kiloSessionId);
      expect((await handleControlRequest('session.detach', sibling, {}, deps)).ok).toBe(true);
      expect(runtime?.signal.aborted).toBe(true);
      expect(harness.closes).toBe(1);
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
      const runtime = harness.registry.get(identity.directory);
      release.resolve();
      expect((await pending).ok).toBe(false);
      expect(harness.registry.get(identity.directory)).toBe(runtime);
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
    const runtime = harness.registry.get(identity.directory);
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
      expect(rootForSession(identity.kiloSessionId)).toBeUndefined();
      expect((await handleControlRequest('session.detach', identity, {}, deps)).ok).toBe(true);
      expect(signal.aborted).toBe(true);
      expect(runtime?.signal.aborted).toBe(false);
      expect(
        (await handleControlRequest('session.attach', identity, { kilo: auth }, deps)).ok
      ).toBe(true);
      release.resolve();
      expect((await pending).ok).toBe(false);
      expect(harness.registry.get(identity.directory)).toBe(runtime);
      expect(rootForSession(identity.kiloSessionId)).toBe(identity.kiloSessionId);
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
      expect(harness.closes).toBe(0);
      expect(harness.launches).toHaveLength(1);
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
      expect(harness.registry.get(identity.directory)?.env.KILOCODE_TOKEN).toBe('replacement');
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
});
