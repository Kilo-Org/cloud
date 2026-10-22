import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  encodeKiloSdkMessagesCursor,
  type CloudAgentRootSessionSummary,
  type KiloSdkSessionInfo,
  type KiloSdkStoredMessage,
} from '@kilocode/session-ingest-contracts';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/db/pg.js', () => ({ getPgDb: vi.fn() }));
vi.mock('../../src/session/model-preflight.js', () => ({
  preflightSessionRuntime: vi.fn().mockResolvedValue(undefined),
  preflightExistingPromptModel: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
vi.mock('@cloudflare/sandbox', () => ({ getSandbox: vi.fn(), Sandbox: class {} }));

import type { Env } from '../../src/types.js';
import {
  handleKiloFacadeRequest,
  type KiloFacadeRequestDeps,
} from '../../src/kilo-facade/user-kilo-facade.js';
import {
  projectPublicListedSession,
  publicCloudAgentDirectory,
} from '../../src/kilo-facade/public-sdk-projection.js';
import {
  NATIVE_DELIVERY_LIMITS,
  NATIVE_FACADE_FENCE_EVENT,
  NATIVE_FACADE_RESNAPSHOT_EVENT,
} from '../../src/kilo-facade/native-event-source.js';

const fixtureDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../fixtures/kilo-native-contract'
);
const facadeSource = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../src/kilo-facade/user-kilo-facade.ts'
);

type ContractRoute = {
  method: string;
  path: string;
  query?: Record<string, string>;
  response: string;
};

type PageFixture<T> = { request: string; response: T[]; headers: Record<string, string> };

type Contract = {
  contractVersion: number;
  basePath: string;
  publicDirectory: string;
  headers: Record<string, string>;
  sse: { contentType: string; frames: string[]; resnapshot: { reasons: string[] } };
  routes: ContractRoute[];
  errors: { code: string; status: number }[];
  limits: { nativeDelivery: Record<string, number> };
  fixtures: {
    sessionListPage: PageFixture<KiloSdkSessionInfo>;
    messagePage: PageFixture<KiloSdkStoredMessage>;
    liveRuntimeUnavailable: { status: number; body: { error: string; message: string } };
  };
};

async function loadContract(): Promise<{
  contract: Contract;
  source: string;
}> {
  const [raw, source] = await Promise.all([
    readFile(path.join(fixtureDir, 'v1.json'), 'utf8'),
    readFile(facadeSource, 'utf8'),
  ]);
  return { contract: JSON.parse(raw) as Contract, source };
}

const kiloSessionId = 'ses_12345678901234567890123456';
const cloudAgentSessionId = 'workspace_12345678-1234-4234-8234-123456789abc';
const userId = 'usr_fixture';
const listedSession: CloudAgentRootSessionSummary = {
  kiloSessionId,
  cloudAgentSessionId,
  userId,
  organizationId: null,
  title: 'Example',
  gitUrl: null,
  gitBranch: null,
  profileId: null,
  createdOnPlatform: 'unknown',
  created: 100,
  updated: 200,
};
const messages: KiloSdkStoredMessage[] = [
  {
    info: {
      id: 'msg_user_1',
      sessionID: kiloSessionId,
      role: 'user',
      time: { created: 110 },
      agent: 'build',
      model: { providerID: 'test', modelID: 'fake' },
    },
    parts: [],
  },
];
const nextCursor = encodeKiloSdkMessagesCursor({ id: 'msg_user_1', time: 110 });

function facadeFixture() {
  const answer = vi.fn(async () => 'delivered' as const);
  const listCloudAgentRootSessions = vi.fn(async () => ({
    items: [listedSession],
    nextCursor: 'internal-list-cursor',
  }));
  const getCloudAgentRootSessionMessages = vi.fn<
    Env['SESSION_INGEST']['getCloudAgentRootSessionMessages']
  >(async () => ({
    kiloSessionId,
    cloudAgentSessionId,
    history: { messages, nextCursor, omittedItemCount: 0 },
  }));
  const env = {
    SESSION_INGEST: {
      listCloudAgentRootSessions,
      getCloudAgentRootSessionMessages,
      getCloudAgentRootSessionSnapshot: vi.fn(async () => ({
        kiloSessionId,
        cloudAgentSessionId,
        snapshot: {
          kind: 'value',
          info: projectPublicListedSession(listedSession),
          byteLength: 256,
        },
      })),
    },
    SANDBOX_SESSION: { idFromName: vi.fn(), get: vi.fn(() => ({ answer })) },
  } as unknown as Env;
  const deps = {
    resolveRootSessionForKiloSession: vi.fn(async () => ({ cloudAgentSessionId })),
    nativeLiveRead: vi.fn<NonNullable<KiloFacadeRequestDeps['nativeLiveRead']>>(
      async ({ operation }) => ({
        ok: true,
        result: operation.name === 'session.status' ? {} : [],
      })
    ),
    validatePromptBalance: vi.fn<NonNullable<KiloFacadeRequestDeps['validatePromptBalance']>>(
      async () => ({ success: true })
    ),
    admitPrompt: vi.fn<NonNullable<KiloFacadeRequestDeps['admitPrompt']>>(async () => ({
      success: true,
      outcome: 'queued',
      compatibilityDelivery: 'queued',
      messageId: 'msg_user_1',
    })),
    interruptPrompt: vi.fn(async () => ({ success: true })),
    openNativeAttachment: vi.fn<NonNullable<KiloFacadeRequestDeps['openNativeAttachment']>>(
      async () => ({ kind: 'resnapshot' })
    ),
    globalEvents: {
      openPublicGlobalEventStream: vi.fn(
        () => new Response('', { headers: { 'Content-Type': 'text/event-stream' } })
      ),
      openPublicSessionEventStream: vi.fn(
        () => new Response('', { headers: { 'Content-Type': 'text/event-stream' } })
      ),
    },
  } satisfies KiloFacadeRequestDeps;
  return {
    env,
    deps,
    answer,
    listCloudAgentRootSessions,
    getCloudAgentRootSessionMessages,
    handle: (request: Request) =>
      handleKiloFacadeRequest({ request, env, userId, authToken: 'token', deps }),
  };
}

function expandParameters(value: string): string {
  return value.replaceAll('{sessionID}', kiloSessionId).replaceAll('{requestID}', 'req_fixture');
}

function routeRequest(contract: Contract, route: ContractRoute): Request {
  const url = new URL(`${contract.basePath}${expandParameters(route.path)}`, 'http://worker.test');
  for (const [key, value] of Object.entries(route.query ?? {})) {
    url.searchParams.set(key, expandParameters(value));
  }
  const body = route.path.endsWith('/prompt_async')
    ? { parts: [{ type: 'text', text: 'hello' }] }
    : route.path.endsWith('/command')
      ? { command: 'commit', messageID: 'msg_user_1' }
      : route.path.startsWith('/permission/')
        ? { reply: 'once' }
        : { answers: [['yes']] };
  return new Request(url, {
    method: route.method,
    ...(route.method === 'POST' ? { body: JSON.stringify(body) } : {}),
  });
}

async function validateRoute(contract: Contract, route: ContractRoute): Promise<void> {
  const response = await facadeFixture().handle(routeRequest(contract, route));
  expect(response.status, `${route.method} ${route.path}`).toBe(
    route.response === '204' ? 204 : 200
  );
  if (route.response === '204') {
    expect(await response.text()).toBe('');
  } else if (route.response === 'true') {
    await expect(response.json()).resolves.toBe(true);
  } else if (route.response === 'text/event-stream') {
    expect(response.headers.get('content-type')).toBe(contract.sse.contentType);
  }
}

function pageRequest(page: PageFixture<unknown>): Request {
  const [method, url] = page.request.split(' ');
  return new Request(new URL(url, 'http://worker.test'), { method });
}

function paginationHeaders(contract: Contract, response: Response): Record<string, string> {
  return Object.fromEntries(
    Object.values(contract.headers).flatMap(name => {
      const value = response.headers.get(name);
      return value === null ? [] : [[name, value]];
    })
  );
}

describe('kilo native contract fixture', () => {
  it('pins delivery limits to the implementation', async () => {
    const { contract } = await loadContract();
    expect(contract.limits.nativeDelivery).toEqual({ ...NATIVE_DELIVERY_LIMITS });
  });

  it('pins the fence and resnapshot frame names to the implementation', async () => {
    const { contract } = await loadContract();
    expect(contract.sse.frames).toContain(NATIVE_FACADE_FENCE_EVENT);
    expect(contract.sse.frames).toContain(NATIVE_FACADE_RESNAPSHOT_EVENT);
  });

  it('only lists error codes the facade can emit', async () => {
    const { contract, source } = await loadContract();
    expect(contract.errors.length).toBeGreaterThan(0);
    const missing = contract.errors
      .map(error => error.code)
      .filter(code => !source.includes(`'${code}'`));
    expect(missing).toEqual([]);
  });

  it('serves every documented route, including parameterized paths and response statuses', async () => {
    const { contract } = await loadContract();
    for (const route of contract.routes) await validateRoute(contract, route);
    expect(contract.routes.some(route => route.path === '/session')).toBe(true);
    expect(contract.routes.some(route => route.path === '/event')).toBe(true);
  });

  it.each([
    ['GET', '/session/{sessionID}/question'],
    ['GET', '/session/{sessionID}/permission'],
    ['POST', '/session/{sessionID}/question/{requestID}/reply'],
    ['POST', '/session/{sessionID}/question/{requestID}/reject'],
    ['POST', '/session/{sessionID}/permission/{requestID}/reply'],
  ])('fails drift validation for the reviewed incorrect route %s %s', async (method, routePath) => {
    const { contract } = await loadContract();
    await expect(
      validateRoute(contract, { method, path: routePath, response: 'true' })
    ).rejects.toThrow(`${method} ${routePath}`);
  });

  it('fails drift validation for incorrect HTTP methods on every documented path', async () => {
    const { contract } = await loadContract();
    for (const route of contract.routes) {
      const method = route.method === 'GET' ? 'POST' : 'GET';
      await expect(validateRoute(contract, { ...route, method })).rejects.toThrow(
        `${method} ${route.path}`
      );
    }
  });

  it('requires exactly one public directory on collection and interaction routes', async () => {
    const { contract } = await loadContract();
    for (const route of contract.routes.filter(route => route.query)) {
      const fixture = facadeFixture();
      const request = routeRequest(contract, route);
      await fixture.handle(request);
      expect(fixture.deps.resolveRootSessionForKiloSession).toHaveBeenCalledWith({
        env: fixture.env,
        userId,
        kiloSessionId,
      });
      if (route.path.includes('{requestID}')) {
        expect(fixture.answer).toHaveBeenCalledWith({
          sessionId: cloudAgentSessionId,
          reply: route.path.startsWith('/permission/')
            ? { action: 'permission', permissionId: 'req_fixture', response: 'once' }
            : route.path.endsWith('/reject')
              ? { action: 'reject', questionId: 'req_fixture' }
              : { action: 'answer', questionId: 'req_fixture', answers: [['yes']] },
        });
      }
      for (const query of [
        '',
        '?directory=%2Fworkspace%2Fprivate',
        `?directory=${encodeURIComponent(publicCloudAgentDirectory(kiloSessionId))}&workspace=private`,
        `?directory=${encodeURIComponent(publicCloudAgentDirectory(kiloSessionId))}&directory=duplicate`,
      ]) {
        const invalid = facadeFixture();
        const url = new URL(request.url);
        url.search = query;
        const response = await invalid.handle(new Request(url, { method: route.method }));
        expect(response.status, `${route.path}${query}`).toBe(400);
        expect(invalid.deps.resolveRootSessionForKiloSession).not.toHaveBeenCalled();
        expect(invalid.deps.nativeLiveRead).not.toHaveBeenCalled();
        expect(invalid.answer).not.toHaveBeenCalled();
      }
    }
  });

  it('rejects a mismatched directory on every ID-scoped route', async () => {
    const { contract } = await loadContract();
    for (const route of contract.routes.filter(route => route.path.includes('{sessionID}'))) {
      const request = routeRequest(contract, route);
      const url = new URL(request.url);
      url.searchParams.set('directory', '/cloud-agent/sessions/ses_abcdefghijklmnopqrstuvwxyz');
      const response = await facadeFixture().handle(new Request(url, { method: route.method }));
      expect(response.status, route.path).toBe(400);
    }
  });

  it('rejects directory selectors on the global event route', async () => {
    const fixture = facadeFixture();
    const response = await fixture.handle(
      new Request(
        `http://worker.test/kilo/global/event?directory=${encodeURIComponent(publicCloudAgentDirectory(kiloSessionId))}`
      )
    );
    expect(response.status).toBe(400);
    expect(fixture.deps.globalEvents.openPublicGlobalEventStream).not.toHaveBeenCalled();
  });

  it('records the real list projection and emits no pagination headers even with an internal cursor', async () => {
    const { contract } = await loadContract();
    const page = contract.fixtures.sessionListPage;
    expect(page.response).toEqual([projectPublicListedSession(listedSession)]);
    const fixture = facadeFixture();
    const response = await fixture.handle(pageRequest(page));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(page.response);
    expect(fixture.listCloudAgentRootSessions).toHaveBeenCalledWith({
      kiloUserId: userId,
      limit: 2,
      start: 200,
    });
    expect(paginationHeaders(contract, response)).toEqual(page.headers);
    expect(page.headers).toEqual({});
    const invalid = await fixture.handle(
      new Request(`http://worker.test/kilo/session?limit=2&before=${nextCursor}`)
    );
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({
      error: 'KILO_SESSION_LIST_SELECTOR_UNSUPPORTED',
    });
    expect(fixture.listCloudAgentRootSessions).toHaveBeenCalledOnce();
  });

  it('records message pagination headers and follows the before cursor on the message route', async () => {
    const { contract } = await loadContract();
    const page = contract.fixtures.messagePage;
    const fixture = facadeFixture();
    const response = await fixture.handle(pageRequest(page));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(page.response);
    expect(paginationHeaders(contract, response)).toEqual(page.headers);
    expect(page.headers[contract.headers.nextCursor]).toBe(nextCursor);
    const nextLink = page.headers[contract.headers.linkNext].match(/^<([^>]+)>; rel="next"$/);
    expect(nextLink).not.toBeNull();
    if (!nextLink) throw new Error('Expected a next message page link');
    fixture.getCloudAgentRootSessionMessages.mockResolvedValue({
      kiloSessionId,
      cloudAgentSessionId,
      history: { messages: [], nextCursor: null, omittedItemCount: 0 },
    });
    const lastPage = await fixture.handle(new Request(nextLink[1]));
    expect(lastPage.status).toBe(200);
    await expect(lastPage.json()).resolves.toEqual([]);
    expect(fixture.getCloudAgentRootSessionMessages).toHaveBeenLastCalledWith({
      kiloUserId: userId,
      kiloSessionId,
      limit: 1,
      before: nextCursor,
    });
    expect(paginationHeaders(contract, lastPage)).toEqual({
      [contract.headers.omittedItemCount]: '0',
    });
  });

  it('records the real stopped-runtime error body', async () => {
    const { contract } = await loadContract();
    const fixture = facadeFixture();
    fixture.deps.nativeLiveRead.mockRejectedValue(new Error('Runtime stopped'));
    const response = await fixture.handle(
      new Request(`http://worker.test/kilo/session/${kiloSessionId}/todo`)
    );
    expect(response.status).toBe(contract.fixtures.liveRuntimeUnavailable.status);
    await expect(response.json()).resolves.toEqual(contract.fixtures.liveRuntimeUnavailable.body);
  });

  it('describes the public directory and base path the facade uses', async () => {
    const { contract } = await loadContract();
    expect(contract.basePath).toBe('/kilo');
    expect(expandParameters(contract.publicDirectory)).toBe(
      publicCloudAgentDirectory(kiloSessionId)
    );
  });

  it('keeps v1 explicitly unreleased and released versions append-only', async () => {
    const { contract } = await loadContract();
    expect(contract.contractVersion).toBe(1);
    const files = await readFile(path.join(fixtureDir, 'README.md'), 'utf8');
    expect(files).toContain('Never edit a released version in place');
    expect(files).toContain('`v1` is unreleased');
  });
});
