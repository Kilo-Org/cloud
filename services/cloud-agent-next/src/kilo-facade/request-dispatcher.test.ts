import type { KiloSdkStoredMessage } from '../session-ingest-binding.js';
import type { Env } from '../types.js';
import { describe, expect, it, vi } from 'vitest';
import type { KiloFacadeRequestDeps } from './contracts.js';
import { handleKiloFacadeRequest } from './request-dispatcher.js';

vi.mock('@cloudflare/sandbox', () => ({
  getSandbox: vi.fn(),
  Sandbox: class Sandbox {},
}));

vi.mock('../session/model-preflight.js', () => ({
  preflightExistingPromptModel: vi.fn().mockResolvedValue(undefined),
}));

const kiloSessionId = 'ses_12345678901234567890123456';
const directory = `/cloud-agent/sessions/${kiloSessionId}`;
const messageId = 'msg_exact_01';

const exactMessage: KiloSdkStoredMessage = {
  info: {
    id: messageId,
    sessionID: kiloSessionId,
    role: 'user',
    time: { created: 100 },
    agent: 'build',
    model: { providerID: 'test', modelID: 'fake' },
  },
  parts: [
    {
      id: 'prt_exact_01',
      sessionID: kiloSessionId,
      messageID: messageId,
      type: 'text',
      text: 'existing message',
    },
  ],
};

const question = {
  id: 'que_root',
  sessionID: kiloSessionId,
  questions: [
    {
      question: 'Proceed?',
      header: 'Proceed',
      options: [{ label: 'Yes', description: 'Proceed with the operation' }],
    },
  ],
};
const permission = {
  id: 'per_root',
  sessionID: kiloSessionId,
  permission: 'bash',
  patterns: ['git status'],
  metadata: { command: 'git status' },
  always: ['git status'],
};
const suggestion = {
  id: 'sug_root',
  sessionID: kiloSessionId,
  text: 'Choose an approach',
  actions: [{ label: 'First', prompt: 'Use the first approach' }],
};

const interactionLists = new Map<string, unknown[]>([
  ['/kilo-proxy/question', [question]],
  ['/kilo-proxy/permission', [permission]],
  ['/kilo-proxy/suggestion', [suggestion]],
]);

type WrapperDispatch = {
  method: string;
  path: string;
  search: string;
  body?: unknown;
};

function request(path: string, init?: RequestInit, includeDirectory = true): Request {
  const url = new URL(`https://facade.test/kilo${path}`);
  if (includeDirectory) url.searchParams.set('directory', directory);
  return new Request(url, init);
}

function jsonRequest(path: string, body: unknown): Request {
  return request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function acceptanceHarness(): {
  dispatch: (request: Request) => Promise<Response>;
  wrapperDispatches: WrapperDispatch[];
  resolveRoot: ReturnType<typeof vi.fn>;
  resolveLiveWrapper: ReturnType<typeof vi.fn>;
  getAvailableCommands: ReturnType<typeof vi.fn>;
  admitCommand: ReturnType<typeof vi.fn>;
} {
  const wrapperDispatches: WrapperDispatch[] = [];
  const containerFetch = vi.fn(async (upstreamRequest: Request) => {
    const url = new URL(upstreamRequest.url);
    const bodyText = await upstreamRequest.clone().text();
    wrapperDispatches.push({
      method: upstreamRequest.method,
      path: url.pathname,
      search: url.search,
      ...(bodyText ? { body: JSON.parse(bodyText) } : {}),
    });
    if (url.pathname === `/kilo-proxy/session/${kiloSessionId}/message/${messageId}`) {
      return Response.json(exactMessage);
    }
    const list = interactionLists.get(url.pathname);
    return list ? Response.json(list) : Response.json(true);
  });
  const resolveRoot = vi.fn().mockResolvedValue({ cloudAgentSessionId: 'cloud-root' });
  const resolveLiveWrapper = vi.fn().mockResolvedValue({
    port: 4312,
    sandbox: { containerFetch },
  });
  const getAvailableCommands = vi.fn().mockResolvedValue([
    {
      name: 'init',
      description: 'initialize repository instructions',
      source: 'command',
      hints: [],
    },
  ]);
  const admitCommand = vi.fn().mockResolvedValue({
    success: true,
    outcome: 'queued',
    messageId: 'msg_018f1e2d3c4bDispatchCmdAAA',
    compatibilityDelivery: 'queued',
  });
  const deps: KiloFacadeRequestDeps = {
    resolveRootSessionForKiloSession: resolveRoot,
    resolveLiveWrapper,
    getAvailableCommands,
    validateCommandBalance: vi.fn().mockResolvedValue({ success: true }),
    admitCommand,
  };
  const env = {
    CLOUD_AGENT_SESSION: {
      idFromName: vi.fn(() => 'session-do-id'),
      get: vi.fn(() => ({ hasMessageAdmission: vi.fn().mockResolvedValue(false) })),
    },
  } as unknown as Env;

  return {
    dispatch: facadeRequest =>
      handleKiloFacadeRequest({
        request: facadeRequest,
        env,
        userId: 'user-1',
        authToken: 'validated-token',
        deps,
      }),
    wrapperDispatches,
    resolveRoot,
    resolveLiveWrapper,
    getAvailableCommands,
    admitCommand,
  };
}

describe('Kilo facade request dispatcher acceptance', () => {
  it('dispatches exact-message and selected-root interaction lists to the live wrapper', async () => {
    const harness = acceptanceHarness();

    const exactResponse = await harness.dispatch(
      request(`/session/${kiloSessionId}/message/${messageId}`)
    );
    expect(exactResponse.status).toBe(200);
    await expect(exactResponse.json()).resolves.toEqual(exactMessage);

    for (const [path, expected] of [
      ['/question', question],
      ['/permission', permission],
      ['/suggestion', suggestion],
    ] as const) {
      const response = await harness.dispatch(request(path));
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual([expected]);
    }

    expect(harness.wrapperDispatches).toEqual([
      {
        method: 'GET',
        path: `/kilo-proxy/session/${kiloSessionId}/message/${messageId}`,
        search: '',
      },
      { method: 'GET', path: '/kilo-proxy/question', search: '' },
      { method: 'GET', path: '/kilo-proxy/permission', search: '' },
      { method: 'GET', path: '/kilo-proxy/suggestion', search: '' },
    ]);
  });

  it('preflights and dispatches every supported interaction mutation', async () => {
    const harness = acceptanceHarness();
    const cases = [
      {
        request: jsonRequest('/question/que_root/reply', { answers: [['Yes']] }),
        listPath: '/kilo-proxy/question',
        mutationPath: '/kilo-proxy/question/que_root/reply',
        body: { answers: [['Yes']] },
      },
      {
        request: request('/question/que_root/reject', { method: 'POST' }),
        listPath: '/kilo-proxy/question',
        mutationPath: '/kilo-proxy/question/que_root/reject',
      },
      {
        request: jsonRequest('/permission/per_root/reply', { reply: 'once' }),
        listPath: '/kilo-proxy/permission',
        mutationPath: '/kilo-proxy/permission/per_root/reply',
        body: { reply: 'once' },
      },
      {
        request: jsonRequest('/permission/per_root/always-rules', {
          approvedAlways: ['git status'],
        }),
        listPath: '/kilo-proxy/permission',
        mutationPath: '/kilo-proxy/permission/per_root/always-rules',
        body: { approvedAlways: ['git status'] },
      },
      {
        request: jsonRequest('/suggestion/sug_root/accept', { index: 0 }),
        listPath: '/kilo-proxy/suggestion',
        mutationPath: '/kilo-proxy/suggestion/sug_root/accept',
        body: { index: 0 },
      },
      {
        request: request('/suggestion/sug_root/dismiss', { method: 'POST' }),
        listPath: '/kilo-proxy/suggestion',
        mutationPath: '/kilo-proxy/suggestion/sug_root/dismiss',
      },
    ];

    for (const testCase of cases) {
      const dispatchOffset = harness.wrapperDispatches.length;
      const response = await harness.dispatch(testCase.request);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toBe(true);
      expect(harness.wrapperDispatches.slice(dispatchOffset)).toEqual([
        { method: 'GET', path: testCase.listPath, search: '' },
        {
          method: 'POST',
          path: testCase.mutationPath,
          search: '',
          ...(testCase.body ? { body: testCase.body } : {}),
        },
      ]);
    }
  });

  it('serves command metadata and durably admits commands without wrapper dispatch', async () => {
    const harness = acceptanceHarness();

    const listResponse = await harness.dispatch(request('/command'));
    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toEqual([
      {
        name: 'init',
        description: 'initialize repository instructions',
        source: 'command',
        hints: [],
        template: '',
      },
    ]);

    const commandResponse = await harness.dispatch(
      jsonRequest(`/session/${kiloSessionId}/command`, {
        messageID: 'msg_018f1e2d3c4bDispatchCmdAAA',
        command: 'init',
        arguments: '',
      })
    );
    expect(commandResponse.status).toBe(200);
    await expect(commandResponse.json()).resolves.toMatchObject({
      info: {
        sessionID: kiloSessionId,
        parentID: 'msg_018f1e2d3c4bDispatchCmdAAA',
        role: 'assistant',
      },
      parts: [],
    });
    expect(harness.getAvailableCommands).toHaveBeenCalledOnce();
    expect(harness.admitCommand).toHaveBeenCalledOnce();
    expect(harness.wrapperDispatches).toEqual([]);
  });

  it('rejects wrong methods as unsupported without dispatching to a wrapper', async () => {
    const harness = acceptanceHarness();
    const wrongMethods = [
      request(`/session/${kiloSessionId}/message/${messageId}`, { method: 'POST' }),
      request('/command', { method: 'POST' }),
      request(`/session/${kiloSessionId}/command`),
      request('/question', { method: 'POST' }),
      request('/question/que_root/reply'),
      request('/permission', { method: 'POST' }),
      request('/permission/per_root/always-rules'),
      request('/suggestion', { method: 'POST' }),
      request('/suggestion/sug_root/dismiss'),
    ];

    for (const wrongMethod of wrongMethods) {
      const response = await harness.dispatch(wrongMethod);
      expect(response.status).toBe(501);
      await expect(response.json()).resolves.toMatchObject({ error: 'KILO_ROUTE_UNSUPPORTED' });
    }
    expect(harness.resolveLiveWrapper).not.toHaveBeenCalled();
    expect(harness.wrapperDispatches).toEqual([]);
  });

  it('requires a selected public directory for interaction routes before ownership resolution', async () => {
    const harness = acceptanceHarness();

    for (const path of ['/question', '/permission', '/suggestion']) {
      const response = await harness.dispatch(request(path, undefined, false));
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: 'KILO_SESSION_SELECTOR_UNSUPPORTED',
      });
    }
    expect(harness.resolveRoot).not.toHaveBeenCalled();
    expect(harness.resolveLiveWrapper).not.toHaveBeenCalled();
    expect(harness.wrapperDispatches).toEqual([]);
  });
});
