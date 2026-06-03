import {
  encodeKiloSdkMessagesCursor,
  MAX_KILO_SDK_MESSAGE_HISTORY_PAGE_SIZE,
} from '@kilocode/session-ingest-contracts';
import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { preflightExistingPromptModelMock } = vi.hoisted(() => ({
  preflightExistingPromptModelMock: vi.fn(),
}));

vi.mock('../session/model-preflight.js', () => ({
  preflightExistingPromptModel: preflightExistingPromptModelMock,
}));

vi.mock('cloudflare:workers', () => ({
  DurableObject: class DurableObject {
    ctx: unknown;
    env: unknown;

    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

vi.mock('@cloudflare/sandbox', () => ({
  getSandbox: vi.fn(),
  Sandbox: class Sandbox {},
}));

import type { KiloSdkStoredMessage } from '../session-ingest-binding';
import type { Env } from '../types';
import {
  handleKiloFacadeRequest,
  isSyntheticGlobalEvent,
  publicCloudAgentDirectory,
  rewriteGlobalEventDirectory,
  UserKiloFacade,
} from './user-kilo-facade';
import type { LiveWrapperTarget, SessionKiloFacadeDecision } from './session-proxy';

const kiloSessionId = 'ses_12345678901234567890123456';
type ContainerFetch = (request: Request, port: number) => Promise<Response>;

function envStub(): Env {
  return {
    SESSION_INGEST: {
      resolveCloudAgentRootSessionForKiloSession: vi.fn(),
      getCloudAgentRootSessionSnapshot: vi.fn(),
      listCloudAgentRootSessions: vi.fn(),
      getCloudAgentRootSessionMessages: vi.fn(),
    },
    CLOUD_AGENT_SESSION: {
      idFromName: vi.fn(() => 'session-do-id'),
      get: vi.fn(() => ({
        hasMessageAdmission: vi.fn().mockResolvedValue(false),
        admitSubmittedMessage: vi.fn(),
        interruptExecution: vi.fn(),
      })),
    },
  } as unknown as Env;
}

function sdkSessionInfo(id: string, directory = '/workspace/root') {
  return {
    id,
    slug: 'rainy-fox',
    projectID: 'global',
    directory,
    path: '/workspace/private/session',
    summary: {
      additions: 1,
      deletions: 0,
      files: 1,
      diffs: [{ file: '/workspace/private/changed.ts', additions: 1, deletions: 0 }],
    },
    permission: [{ permission: 'read', pattern: '/workspace/private', action: 'allow' as const }],
    title: 'SDK session fixture',
    version: '1.0.0',
    time: { created: 100, updated: 200 },
  };
}

function projectedSdkSessionInfo(id: string) {
  const { path: _privatePath, ...info } = sdkSessionInfo(id);
  return {
    ...info,
    directory: publicCloudAgentDirectory(id),
    summary: {
      ...info.summary,
      diffs: [
        {
          ...info.summary.diffs[0],
          file: publicCloudAgentDirectory(id),
        },
      ],
    },
    permission: [{ permission: 'read', pattern: publicCloudAgentDirectory(id), action: 'allow' }],
  };
}

function listedSdkSessionInfo(id: string) {
  return {
    id,
    slug: id,
    projectID: 'cloud-agent',
    directory: publicCloudAgentDirectory(id),
    title: 'Mapped session',
    version: 'cloud-agent',
    time: { created: 100, updated: 200 },
  };
}

function sdkMessageHistory(): KiloSdkStoredMessage[] {
  return [
    {
      info: {
        id: 'msg_user_1',
        sessionID: kiloSessionId,
        role: 'user' as const,
        time: { created: 110 },
        summary: {
          diffs: [
            {
              file: '/workspace/private/user-change.ts',
              patch: 'unchanged text payload',
              additions: 1,
              deletions: 0,
            },
          ],
        },
        editorContext: {
          visibleFiles: ['/workspace/private/visible.ts', 'src/public.ts'],
          openTabs: ['/workspace/private/open.ts'],
          activeFile: '/workspace/private/active.ts',
        },
        agent: 'build',
        model: { providerID: 'test', modelID: 'fake' },
      },
      parts: [
        {
          id: 'prt_user_1',
          sessionID: kiloSessionId,
          messageID: 'msg_user_1',
          type: 'text' as const,
          text: 'hello',
        },
      ],
    },
    {
      info: {
        id: 'msg_assistant_1',
        sessionID: kiloSessionId,
        role: 'assistant' as const,
        time: { created: 120, completed: 130 },
        parentID: 'msg_user_1',
        modelID: 'fake',
        providerID: 'test',
        mode: 'build',
        agent: 'build',
        path: { cwd: '/workspace/private/session', root: '/workspace/private' },
        cost: 0,
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: [
        {
          id: 'prt_file_1',
          sessionID: kiloSessionId,
          messageID: 'msg_assistant_1',
          type: 'file' as const,
          mime: 'text/plain',
          url: 'data:text/plain,private',
          source: {
            type: 'file' as const,
            text: { value: 'private', start: 0, end: 7 },
            path: '/workspace/private/source.ts',
          },
        },
        {
          id: 'prt_tool_1',
          sessionID: kiloSessionId,
          messageID: 'msg_assistant_1',
          type: 'tool' as const,
          callID: 'call_1',
          tool: 'read',
          state: {
            status: 'completed' as const,
            input: {},
            output: 'unchanged model-authored /workspace/private text',
            title: 'read',
            metadata: {},
            time: { start: 120, end: 121 },
            attachments: [
              {
                id: 'prt_attachment_1',
                sessionID: kiloSessionId,
                messageID: 'msg_assistant_1',
                type: 'file' as const,
                mime: 'text/plain',
                url: 'data:text/plain,symbol',
                source: {
                  type: 'symbol' as const,
                  text: { value: 'symbol', start: 0, end: 6 },
                  path: '/workspace/private/symbol.ts',
                  range: {
                    start: { line: 1, character: 0 },
                    end: { line: 1, character: 6 },
                  },
                  name: 'symbol',
                  kind: 1,
                },
              },
            ],
          },
        },
      ],
    },
  ];
}

function sdkMessageHistoryWithOwnerVisibleStructuredPaths(): KiloSdkStoredMessage[] {
  const history = sdkMessageHistory();
  const assistant = history[1];
  if (!assistant || assistant.info.role !== 'assistant') {
    throw new Error('Expected assistant message fixture');
  }
  const tool = assistant.parts.find(part => part.type === 'tool');
  if (!tool) {
    throw new Error('Expected tool part fixture');
  }
  history[1] = {
    ...assistant,
    parts: [
      ...assistant.parts.map(part =>
        part.id === tool.id
          ? { ...tool, state: { ...tool.state, input: { path: '/workspace/repo' } } }
          : part
      ),
      {
        id: 'prt_metadata_private',
        sessionID: kiloSessionId,
        messageID: assistant.info.id,
        type: 'text',
        text: 'file: src/foo.ts was updated',
        metadata: { path: '/workspace/private/unreviewed.ts' },
      },
      {
        id: 'prt_resource_private',
        sessionID: kiloSessionId,
        messageID: assistant.info.id,
        type: 'file',
        mime: 'text/plain',
        url: 'data:text/plain,safe',
        source: {
          type: 'resource',
          text: { value: 'private', start: 0, end: 7 },
          clientName: 'wrapper',
          uri: 'file:///workspace/private/resource.txt',
        },
      },
    ],
  };
  return history;
}

function expectOwnerVisibleStructuredMessagePaths(body: KiloSdkStoredMessage[]): void {
  expect(body[1]?.parts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: 'prt_tool_1',
        state: expect.objectContaining({ input: { path: '/workspace/repo' } }),
      }),
      expect.objectContaining({
        id: 'prt_metadata_private',
        text: 'file: src/foo.ts was updated',
        metadata: { path: '/workspace/private/unreviewed.ts' },
      }),
      expect.objectContaining({
        id: 'prt_resource_private',
        source: expect.objectContaining({ uri: 'file:///workspace/private/resource.txt' }),
      }),
    ])
  );
}

function projectedSdkMessageHistory(): KiloSdkStoredMessage[] {
  const history = sdkMessageHistory();
  const userMessage = history[0];
  const assistantMessage = history[1];
  if (!userMessage || userMessage.info.role !== 'user' || !userMessage.info.summary) {
    throw new Error('Expected user message projection fixture');
  }
  if (!assistantMessage || assistantMessage.info.role !== 'assistant') {
    throw new Error('Expected assistant message projection fixture');
  }
  const filePart = assistantMessage.parts[0];
  const toolPart = assistantMessage.parts[1];
  if (
    !filePart ||
    filePart.type !== 'file' ||
    !filePart.source ||
    filePart.source.type === 'resource'
  ) {
    throw new Error('Expected file source fixture');
  }
  if (
    !toolPart ||
    toolPart.type !== 'tool' ||
    toolPart.state.status !== 'completed' ||
    !toolPart.state.attachments?.[0]
  ) {
    throw new Error('Expected tool attachment fixture');
  }
  const attachment = toolPart.state.attachments[0];
  if (!attachment.source || attachment.source.type === 'resource') {
    throw new Error('Expected attachment source fixture');
  }
  const directory = publicCloudAgentDirectory(kiloSessionId);
  return [
    {
      ...userMessage,
      info: {
        ...userMessage.info,
        summary: {
          diffs: [{ ...userMessage.info.summary.diffs[0], file: directory }],
        },
        editorContext: {
          visibleFiles: [directory, 'src/public.ts'],
          openTabs: [directory],
          activeFile: directory,
        },
      },
    },
    {
      ...assistantMessage,
      info: {
        ...assistantMessage.info,
        path: { cwd: directory, root: directory },
      },
      parts: [
        {
          ...filePart,
          source: { ...filePart.source, path: directory },
        },
        {
          ...toolPart,
          state: {
            ...toolPart.state,
            attachments: [
              {
                ...attachment,
                source: {
                  ...attachment.source,
                  path: directory,
                },
              },
            ],
          },
        },
      ],
    },
  ];
}

function liveWrapperTarget(containerFetch: ContainerFetch): LiveWrapperTarget {
  return {
    port: 5123,
    sandbox: { containerFetch } as unknown as LiveWrapperTarget['sandbox'],
  };
}

async function readSseTextFrame(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const frame = await reader.read();
  if (frame.done) {
    throw new Error('Expected SSE frame');
  }
  return new TextDecoder().decode(frame.value);
}

async function readSseFrame<T>(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<T> {
  return JSON.parse((await readSseTextFrame(reader)).slice('data: '.length));
}

describe('handleKiloFacadeRequest', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    preflightExistingPromptModelMock.mockResolvedValue(undefined);
  });

  it('returns 501 for intentionally unsupported Kilo route families', async () => {
    for (const request of [
      new Request('http://worker.test/kilo/session', { method: 'POST' }),
      new Request('http://worker.test/kilo/session/status'),
      new Request('http://worker.test/kilo/session/viewed', { method: 'POST' }),
      new Request('http://worker.test/kilo/sync/history', { method: 'POST' }),
      new Request('http://worker.test/kilo/config'),
      new Request('http://worker.test/kilo/provider'),
      new Request('http://worker.test/kilo/project/current'),
      new Request('http://worker.test/kilo/global/health'),
    ]) {
      const response = await handleKiloFacadeRequest({
        request,
        env: envStub(),
        userId: 'usr_1',
        deps: {
          globalEvents: {
            openPublicGlobalEventStream: () => new Response('unused'),
            openPublicSessionEventStream: () => new Response('unused'),
          },
        },
      });

      expect(response.status).toBe(501);
      await expect(response.json()).resolves.toMatchObject({ error: 'KILO_ROUTE_UNSUPPORTED' });
    }
  });

  it('lists mapped Cloud Agent roots without requiring private SDK snapshots', async () => {
    const env = envStub();
    const listCloudAgentRootSessions = vi.mocked(env.SESSION_INGEST.listCloudAgentRootSessions);
    listCloudAgentRootSessions.mockResolvedValue([
      {
        kiloSessionId,
        cloudAgentSessionId: 'agent_live',
        title: 'Mapped session',
        created: 100,
        updated: 200,
      },
    ]);

    const response = await handleKiloFacadeRequest({
      request: new Request('http://worker.test/kilo/session?limit=15&start=1234'),
      env,
      userId: 'usr_1',
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([listedSdkSessionInfo(kiloSessionId)]);
    expect(listCloudAgentRootSessions).toHaveBeenCalledWith({
      kiloUserId: 'usr_1',
      limit: 15,
      start: 1234,
    });
  });

  it('rejects repeated session list selectors before listing roots', async () => {
    const env = envStub();

    const response = await handleKiloFacadeRequest({
      request: new Request('http://worker.test/kilo/session?limit=1&limit=2'),
      env,
      userId: 'usr_1',
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: 'KILO_QUERY_INVALID' });
    expect(env.SESSION_INGEST.listCloudAgentRootSessions).not.toHaveBeenCalled();
  });

  it('rejects selectors on the global event route before opening the stream', async () => {
    const openPublicGlobalEventStream = vi.fn();
    const response = await handleKiloFacadeRequest({
      request: new Request('http://worker.test/kilo/global/event?directory=%2Fworkspace%2Fprivate'),
      env: envStub(),
      userId: 'usr_1',
      deps: {
        globalEvents: { openPublicGlobalEventStream, openPublicSessionEventStream: vi.fn() },
      },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: 'KILO_EVENT_SELECTOR_UNSUPPORTED',
    });
    expect(openPublicGlobalEventStream).not.toHaveBeenCalled();
  });

  it('opens the public global event stream through the facade coordinator', async () => {
    const openPublicGlobalEventStream = vi.fn(
      () => new Response('stream', { headers: { 'Content-Type': 'text/event-stream' } })
    );

    const response = await handleKiloFacadeRequest({
      request: new Request('http://worker.test/kilo/global/event'),
      env: envStub(),
      userId: 'usr_1',
      deps: {
        globalEvents: { openPublicGlobalEventStream, openPublicSessionEventStream: vi.fn() },
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(openPublicGlobalEventStream).toHaveBeenCalledOnce();
  });

  it('requires a directory selector for a scoped event subscription', async () => {
    const response = await handleKiloFacadeRequest({
      request: new Request('http://worker.test/kilo/event'),
      env: envStub(),
      userId: 'usr_1',
      deps: {
        globalEvents: {
          openPublicGlobalEventStream: vi.fn(),
          openPublicSessionEventStream: vi.fn(),
        },
      },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: 'KILO_EVENT_DIRECTORY_REQUIRED',
    });
  });

  it('rejects unsupported scoped event selector semantics before ownership lookup', async () => {
    const resolveRootSessionForKiloSession = vi.fn();

    const response = await handleKiloFacadeRequest({
      request: new Request('http://worker.test/kilo/event?workspace=private'),
      env: envStub(),
      userId: 'usr_1',
      deps: {
        resolveRootSessionForKiloSession,
        globalEvents: {
          openPublicGlobalEventStream: vi.fn(),
          openPublicSessionEventStream: vi.fn(),
        },
      },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: 'KILO_EVENT_SELECTOR_UNSUPPORTED',
    });
    expect(resolveRootSessionForKiloSession).not.toHaveBeenCalled();
  });

  it('rejects repeated scoped event selectors before ownership lookup', async () => {
    const resolveRootSessionForKiloSession = vi.fn();
    const openPublicSessionEventStream = vi.fn();
    const directory = encodeURIComponent(publicCloudAgentDirectory(kiloSessionId));

    const response = await handleKiloFacadeRequest({
      request: new Request(
        `http://worker.test/kilo/event?directory=${directory}&directory=${directory}`
      ),
      env: envStub(),
      userId: 'usr_1',
      deps: {
        resolveRootSessionForKiloSession,
        globalEvents: { openPublicGlobalEventStream: vi.fn(), openPublicSessionEventStream },
      },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: 'KILO_QUERY_INVALID' });
    expect(resolveRootSessionForKiloSession).not.toHaveBeenCalled();
    expect(openPublicSessionEventStream).not.toHaveBeenCalled();
  });

  it('rejects a non-Cloud-Agent scoped event directory selector', async () => {
    const response = await handleKiloFacadeRequest({
      request: new Request('http://worker.test/kilo/event?directory=%2Fworkspace%2Fprivate'),
      env: envStub(),
      userId: 'usr_1',
      deps: {
        globalEvents: {
          openPublicGlobalEventStream: vi.fn(),
          openPublicSessionEventStream: vi.fn(),
        },
      },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: 'KILO_EVENT_SELECTOR_UNSUPPORTED',
    });
  });

  it('hides a malformed Cloud Agent session event selector as not found', async () => {
    const resolveRootSessionForKiloSession = vi.fn();
    const response = await handleKiloFacadeRequest({
      request: new Request(
        'http://worker.test/kilo/event?directory=%2Fcloud-agent%2Fsessions%2Fbad-id'
      ),
      env: envStub(),
      userId: 'usr_1',
      deps: {
        resolveRootSessionForKiloSession,
        globalEvents: {
          openPublicGlobalEventStream: vi.fn(),
          openPublicSessionEventStream: vi.fn(),
        },
      },
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: 'KILO_SESSION_NOT_FOUND' });
    expect(resolveRootSessionForKiloSession).not.toHaveBeenCalled();
  });

  it('opens a scoped event stream for an owned root without resolving a live wrapper', async () => {
    const openPublicSessionEventStream = vi.fn(
      () => new Response('stream', { headers: { 'Content-Type': 'text/event-stream' } })
    );
    const resolveLiveWrapper = vi.fn();

    const response = await handleKiloFacadeRequest({
      request: new Request(
        `http://worker.test/kilo/event?directory=${encodeURIComponent(publicCloudAgentDirectory(kiloSessionId))}`
      ),
      env: envStub(),
      userId: 'usr_1',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: 'agent_cold',
        })),
        resolveLiveWrapper,
        globalEvents: { openPublicGlobalEventStream: vi.fn(), openPublicSessionEventStream },
      },
    });

    expect(response.status).toBe(200);
    expect(openPublicSessionEventStream).toHaveBeenCalledWith(kiloSessionId);
    expect(resolveLiveWrapper).not.toHaveBeenCalled();
  });

  it('hides a foreign scoped event selector as not found', async () => {
    const openPublicSessionEventStream = vi.fn();

    const response = await handleKiloFacadeRequest({
      request: new Request(
        `http://worker.test/kilo/event?directory=${encodeURIComponent(publicCloudAgentDirectory(kiloSessionId))}`
      ),
      env: envStub(),
      userId: 'usr_1',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => null),
        globalEvents: { openPublicGlobalEventStream: vi.fn(), openPublicSessionEventStream },
      },
    });

    expect(response.status).toBe(404);
    expect(openPublicSessionEventStream).not.toHaveBeenCalled();
  });

  it('returns 404 for unresolved root Kilo sessions before live wrapper lookup', async () => {
    const resolveLiveWrapper = vi.fn();

    const response = await handleKiloFacadeRequest({
      request: new Request(`http://worker.test/kilo/session/${kiloSessionId}/message`),
      env: envStub(),
      userId: 'usr_1',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => null),
        resolveLiveWrapper,
      },
    });

    expect(response.status).toBe(404);
    expect(resolveLiveWrapper).not.toHaveBeenCalled();
  });

  it('returns 404 for malformed Kilo session IDs before resolving ownership', async () => {
    const resolveRootSessionForKiloSession = vi.fn(async () => {
      throw new Error('Malformed session IDs should not reach session ingest');
    });

    const response = await handleKiloFacadeRequest({
      request: new Request('http://worker.test/kilo/session/not-a-session/message'),
      env: envStub(),
      userId: 'usr_1',
      deps: { resolveRootSessionForKiloSession },
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: 'KILO_SESSION_NOT_FOUND',
    });
    expect(resolveRootSessionForKiloSession).not.toHaveBeenCalled();
  });

  it('runs the session route policy seam before live wrapper lookup', async () => {
    const resolveLiveWrapper = vi.fn();
    const decision: SessionKiloFacadeDecision = {
      kind: 'reject',
      status: 418,
      code: 'POLICY_REJECTED',
      message: 'rejected by policy',
    };

    const response = await handleKiloFacadeRequest({
      request: new Request(`http://worker.test/kilo/session/${kiloSessionId}/message`),
      env: envStub(),
      userId: 'usr_1',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: 'agent_live',
        })),
        decideSessionRoute: vi.fn(() => decision),
        resolveLiveWrapper,
      },
    });

    expect(response.status).toBe(418);
    expect(resolveLiveWrapper).not.toHaveBeenCalled();
  });

  it('returns a persisted session snapshot when an authorized detail read is cold', async () => {
    const env = envStub();
    const getCloudAgentRootSessionSnapshot = vi.mocked(
      env.SESSION_INGEST.getCloudAgentRootSessionSnapshot
    );
    getCloudAgentRootSessionSnapshot.mockResolvedValue({
      kiloSessionId,
      cloudAgentSessionId: 'agent_cold',
      snapshot: { kind: 'value', info: sdkSessionInfo(kiloSessionId), byteLength: 123 },
    });

    const response = await handleKiloFacadeRequest({
      request: new Request(`http://worker.test/kilo/session/${kiloSessionId}`),
      env,
      userId: 'usr_1',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: 'agent_cold',
        })),
        resolveLiveWrapper: vi.fn(async () => null),
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(projectedSdkSessionInfo(kiloSessionId));
    expect(getCloudAgentRootSessionSnapshot).toHaveBeenCalledWith({
      kiloUserId: 'usr_1',
      kiloSessionId,
    });
  });

  it('falls back to the persisted detail snapshot when the wrapper has no private Kilo runtime', async () => {
    const env = envStub();
    vi.mocked(env.SESSION_INGEST.getCloudAgentRootSessionSnapshot).mockResolvedValue({
      kiloSessionId,
      cloudAgentSessionId: 'agent_live',
      snapshot: { kind: 'value', info: sdkSessionInfo(kiloSessionId), byteLength: 123 },
    });
    const containerFetch = vi.fn<ContainerFetch>(async () =>
      Response.json(
        { error: 'KILO_RUNTIME_UNAVAILABLE', message: 'Kilo runtime is not bootstrapped' },
        { status: 503 }
      )
    );

    const response = await handleKiloFacadeRequest({
      request: new Request(`http://worker.test/kilo/session/${kiloSessionId}`),
      env,
      userId: 'usr_1',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: 'agent_live',
        })),
        resolveLiveWrapper: vi.fn(async () => liveWrapperTarget(containerFetch)),
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      directory: publicCloudAgentDirectory(kiloSessionId),
    });
  });

  it('falls back to the persisted detail snapshot when live wrapper discovery is unavailable', async () => {
    const env = envStub();
    vi.mocked(env.SESSION_INGEST.getCloudAgentRootSessionSnapshot).mockResolvedValue({
      kiloSessionId,
      cloudAgentSessionId: 'agent_live',
      snapshot: { kind: 'value', info: sdkSessionInfo(kiloSessionId), byteLength: 123 },
    });

    const response = await handleKiloFacadeRequest({
      request: new Request(`http://worker.test/kilo/session/${kiloSessionId}`),
      env,
      userId: 'usr_1',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: 'agent_live',
        })),
        resolveLiveWrapper: vi.fn(async () => {
          throw new Error('wrapper discovery failed');
        }),
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      directory: publicCloudAgentDirectory(kiloSessionId),
    });
  });

  it('falls back to the persisted detail snapshot when a live proxy request cannot be reached', async () => {
    const env = envStub();
    vi.mocked(env.SESSION_INGEST.getCloudAgentRootSessionSnapshot).mockResolvedValue({
      kiloSessionId,
      cloudAgentSessionId: 'agent_live',
      snapshot: { kind: 'value', info: sdkSessionInfo(kiloSessionId), byteLength: 123 },
    });
    const containerFetch = vi.fn<ContainerFetch>(async () => {
      throw new Error('wrapper request failed');
    });

    const response = await handleKiloFacadeRequest({
      request: new Request(`http://worker.test/kilo/session/${kiloSessionId}`),
      env,
      userId: 'usr_1',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: 'agent_live',
        })),
        resolveLiveWrapper: vi.fn(async () => liveWrapperTarget(containerFetch)),
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      directory: publicCloudAgentDirectory(kiloSessionId),
    });
  });

  it('preserves owner-visible structured paths in a cold session snapshot', async () => {
    const env = envStub();
    vi.mocked(env.SESSION_INGEST.getCloudAgentRootSessionSnapshot).mockResolvedValue({
      kiloSessionId,
      cloudAgentSessionId: 'agent_cold',
      snapshot: {
        kind: 'value',
        byteLength: 123,
        info: {
          ...sdkSessionInfo(kiloSessionId),
          share: { url: '/workspace/private/share' },
        },
      },
    });
    const response = await handleKiloFacadeRequest({
      request: new Request(`http://worker.test/kilo/session/${kiloSessionId}`),
      env,
      userId: 'usr_1',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: 'agent_cold',
        })),
        resolveLiveWrapper: vi.fn(async () => null),
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      share: { url: '/workspace/private/share' },
    });
  });

  it('returns a stable pending response for a cold detail read without a materialized snapshot', async () => {
    const env = envStub();
    vi.mocked(env.SESSION_INGEST.getCloudAgentRootSessionSnapshot).mockResolvedValue({
      kiloSessionId,
      cloudAgentSessionId: 'agent_cold',
      snapshot: { kind: 'pending' },
    });

    const response = await handleKiloFacadeRequest({
      request: new Request(`http://worker.test/kilo/session/${kiloSessionId}`),
      env,
      userId: 'usr_1',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: 'agent_cold',
        })),
        resolveLiveWrapper: vi.fn(async () => null),
      },
    });

    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('1');
    await expect(response.json()).resolves.toMatchObject({
      error: 'KILO_SESSION_SNAPSHOT_PENDING',
    });
  });

  it('maps an oversized cold session snapshot to stable 413', async () => {
    const env = envStub();
    vi.mocked(env.SESSION_INGEST.getCloudAgentRootSessionSnapshot).mockResolvedValue({
      kiloSessionId,
      cloudAgentSessionId: 'agent_cold',
      snapshot: { kind: 'too_large', maximumBytes: 8 * 1024 * 1024 },
    });

    const response = await handleKiloFacadeRequest({
      request: new Request(`http://worker.test/kilo/session/${kiloSessionId}`),
      env,
      userId: 'usr_1',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: 'agent_cold',
        })),
        resolveLiveWrapper: vi.fn(async () => null),
      },
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: 'KILO_SESSION_SNAPSHOT_TOO_LARGE',
    });
  });

  it('maps a retryable cold session snapshot failure to stable retryable 503', async () => {
    const env = envStub();
    vi.mocked(env.SESSION_INGEST.getCloudAgentRootSessionSnapshot).mockResolvedValue({
      kiloSessionId,
      cloudAgentSessionId: 'agent_cold',
      snapshot: { kind: 'retryable_failure' },
    });

    const response = await handleKiloFacadeRequest({
      request: new Request(`http://worker.test/kilo/session/${kiloSessionId}`),
      env,
      userId: 'usr_1',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: 'agent_cold',
        })),
        resolveLiveWrapper: vi.fn(async () => null),
      },
    });

    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('1');
    await expect(response.json()).resolves.toMatchObject({ error: 'KILO_SESSION_READ_RETRYABLE' });
  });

  it('maps invalid persisted snapshot data to the warm-path upstream invalid response', async () => {
    const env = envStub();
    vi.mocked(env.SESSION_INGEST.getCloudAgentRootSessionSnapshot).mockResolvedValue({
      kiloSessionId,
      cloudAgentSessionId: 'agent_cold',
      snapshot: { kind: 'invalid_data' },
    } as never);

    const response = await handleKiloFacadeRequest({
      request: new Request(`http://worker.test/kilo/session/${kiloSessionId}`),
      env,
      userId: 'usr_1',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: 'agent_cold',
        })),
        resolveLiveWrapper: vi.fn(async () => null),
      },
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: 'KILO_UPSTREAM_RESPONSE_INVALID',
      message: 'Kilo session response is not valid',
    });
  });

  it('falls back to the persisted detail snapshot when the live private Kilo request fails', async () => {
    const env = envStub();
    vi.mocked(env.SESSION_INGEST.getCloudAgentRootSessionSnapshot).mockResolvedValue({
      kiloSessionId,
      cloudAgentSessionId: 'agent_live',
      snapshot: { kind: 'value', info: sdkSessionInfo(kiloSessionId), byteLength: 123 },
    });
    const containerFetch = vi.fn<ContainerFetch>(async () =>
      Response.json({ error: 'KILO_PROXY_ERROR', message: 'fetch failed' }, { status: 502 })
    );

    const response = await handleKiloFacadeRequest({
      request: new Request(`http://worker.test/kilo/session/${kiloSessionId}`),
      env,
      userId: 'usr_1',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: 'agent_live',
        })),
        resolveLiveWrapper: vi.fn(async () => liveWrapperTarget(containerFetch)),
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      directory: publicCloudAgentDirectory(kiloSessionId),
    });
  });

  it('rewrites fresh live session routing fields while preserving owner-visible structured paths', async () => {
    const containerFetch = vi.fn<ContainerFetch>(async () =>
      Response.json(
        { ...sdkSessionInfo(kiloSessionId), share: { url: '/workspace/private/share' } },
        { headers: { 'X-Upstream': 'kept' } }
      )
    );

    const response = await handleKiloFacadeRequest({
      request: new Request(`http://worker.test/kilo/session/${kiloSessionId}`),
      env: envStub(),
      userId: 'usr_1',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: 'agent_live',
        })),
        resolveLiveWrapper: vi.fn(async () => liveWrapperTarget(containerFetch)),
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('x-upstream')).toBe('kept');
    await expect(response.json()).resolves.toEqual({
      ...projectedSdkSessionInfo(kiloSessionId),
      share: { url: '/workspace/private/share' },
    });
  });

  it('bounds successful live detail JSON before projection', async () => {
    const containerFetch = vi.fn<ContainerFetch>(
      async () =>
        new Response(JSON.stringify(sdkSessionInfo(kiloSessionId)), {
          status: 200,
          headers: { 'Content-Length': String(8 * 1024 * 1024 + 1) },
        })
    );
    const response = await handleKiloFacadeRequest({
      request: new Request(`http://worker.test/kilo/session/${kiloSessionId}`),
      env: envStub(),
      userId: 'usr_1',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: 'agent_live',
        })),
        resolveLiveWrapper: vi.fn(async () => liveWrapperTarget(containerFetch)),
      },
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: 'KILO_UPSTREAM_RESPONSE_INVALID',
    });
  });

  it('bounds live detail without consuming an oversized streamed body', async () => {
    const response = await handleKiloFacadeRequest({
      request: new Request(`http://worker.test/kilo/session/${kiloSessionId}`),
      env: envStub(),
      userId: 'usr_1',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: 'agent_live',
        })),
        resolveLiveWrapper: vi.fn(async () =>
          liveWrapperTarget(
            async () =>
              new Response(
                new ReadableStream<Uint8Array>({
                  start(controller) {
                    controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1));
                    controller.close();
                  },
                })
              )
          )
        ),
      },
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: 'KILO_UPSTREAM_RESPONSE_INVALID',
    });
  });

  it('rejects malformed successful live detail JSON instead of returning an SDK-invalid session', async () => {
    const containerFetch = vi.fn<ContainerFetch>(async () =>
      Response.json({ directory: '/workspace/root' })
    );

    const response = await handleKiloFacadeRequest({
      request: new Request(`http://worker.test/kilo/session/${kiloSessionId}`),
      env: envStub(),
      userId: 'usr_1',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: 'agent_live',
        })),
        resolveLiveWrapper: vi.fn(async () => liveWrapperTarget(containerFetch)),
      },
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: 'KILO_UPSTREAM_RESPONSE_INVALID',
    });
  });

  it('rejects unsupported SDK session detail selectors instead of ignoring them', async () => {
    const response = await handleKiloFacadeRequest({
      request: new Request(
        `http://worker.test/kilo/session/${kiloSessionId}?directory=%2Fworkspace%2Fprivate`
      ),
      env: envStub(),
      userId: 'usr_1',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: 'agent_live',
        })),
        resolveLiveWrapper: vi.fn(),
      },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: 'KILO_SESSION_SELECTOR_UNSUPPORTED',
    });
  });

  it('rejects repeated SDK session detail selectors before live wrapper lookup', async () => {
    const resolveLiveWrapper = vi.fn();
    const directory = encodeURIComponent(publicCloudAgentDirectory(kiloSessionId));

    const response = await handleKiloFacadeRequest({
      request: new Request(
        `http://worker.test/kilo/session/${kiloSessionId}?directory=${directory}&directory=${directory}`
      ),
      env: envStub(),
      userId: 'usr_1',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: 'agent_live',
        })),
        resolveLiveWrapper,
      },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: 'KILO_QUERY_INVALID' });
    expect(resolveLiveWrapper).not.toHaveBeenCalled();
  });

  it('rejects unsupported session list selectors instead of broadening the result', async () => {
    const env = envStub();

    const response = await handleKiloFacadeRequest({
      request: new Request('http://worker.test/kilo/session?directory=%2Fworkspace%2Fprivate'),
      env,
      userId: 'usr_1',
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: 'KILO_SESSION_LIST_SELECTOR_UNSUPPORTED',
    });
    expect(env.SESSION_INGEST.listCloudAgentRootSessions).not.toHaveBeenCalled();
  });

  it('returns persisted SDK messages and public pagination headers when a read is cold', async () => {
    const env = envStub();
    const nextCursor = 'eyJpZCI6Im1zZ191c2VyXzEiLCJ0aW1lIjoxMTB9';
    const getCloudAgentRootSessionMessages = vi.mocked(
      env.SESSION_INGEST.getCloudAgentRootSessionMessages
    );
    getCloudAgentRootSessionMessages.mockResolvedValue({
      kiloSessionId,
      cloudAgentSessionId: 'agent_cold',
      history: { messages: sdkMessageHistory(), nextCursor, omittedItemCount: 0 },
    });

    const response = await handleKiloFacadeRequest({
      request: new Request(`http://worker.test/kilo/session/${kiloSessionId}/message?limit=1`),
      env,
      userId: 'usr_1',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: 'agent_cold',
        })),
        resolveLiveWrapper: vi.fn(async () => null),
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(projectedSdkMessageHistory());
    expect(response.headers.get('x-kilo-omitted-item-count')).toBe('0');
    expect(response.headers.get('x-next-cursor')).toBe(nextCursor);
    expect(response.headers.get('access-control-expose-headers')).toBeNull();
    expect(response.headers.get('link')).toBe(
      `<http://worker.test/kilo/session/${kiloSessionId}/message?limit=1&before=${nextCursor}>; rel="next"`
    );
    expect(getCloudAgentRootSessionMessages).toHaveBeenCalledWith({
      kiloUserId: 'usr_1',
      kiloSessionId,
      limit: 1,
    });
  });

  it('returns persisted omission metadata without changing the projected message array body', async () => {
    const env = envStub();
    vi.mocked(env.SESSION_INGEST.getCloudAgentRootSessionMessages).mockResolvedValue({
      kiloSessionId,
      cloudAgentSessionId: 'agent_cold',
      history: { messages: sdkMessageHistory(), nextCursor: null, omittedItemCount: 3 },
    });

    const response = await handleKiloFacadeRequest({
      request: new Request(`http://worker.test/kilo/session/${kiloSessionId}/message?limit=1`),
      env,
      userId: 'usr_1',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: 'agent_cold',
        })),
        resolveLiveWrapper: vi.fn(async () => null),
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(projectedSdkMessageHistory());
    expect(response.headers.get('x-kilo-omitted-item-count')).toBe('3');
    expect(response.headers.get('access-control-expose-headers')).toBeNull();
    expect(response.headers.get('link')).toBeNull();
    expect(response.headers.get('x-next-cursor')).toBeNull();
  });

  it('keeps legacy message cursors on the live-first path', async () => {
    const env = envStub();
    const cursor = encodeKiloSdkMessagesCursor({ id: 'msg_user_1', time: 110 });
    const containerFetch = vi.fn<ContainerFetch>(async () => Response.json(sdkMessageHistory()));
    const resolveLiveWrapper = vi.fn(async () => liveWrapperTarget(containerFetch));

    const response = await handleKiloFacadeRequest({
      request: new Request(
        `http://worker.test/kilo/session/${kiloSessionId}/message?limit=1&before=${cursor}`
      ),
      env,
      userId: 'usr_1',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: 'agent_live',
        })),
        resolveLiveWrapper,
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(projectedSdkMessageHistory());
    expect(resolveLiveWrapper).toHaveBeenCalledOnce();
    expect(containerFetch).toHaveBeenCalledOnce();
    expect(env.SESSION_INGEST.getCloudAgentRootSessionMessages).not.toHaveBeenCalled();
    expect(response.headers.get('x-kilo-omitted-item-count')).toBeNull();
  });

  it('rejects invalid message pagination before durable lookup', async () => {
    const env = envStub();
    const resolveLiveWrapper = vi.fn();

    const response = await handleKiloFacadeRequest({
      request: new Request(
        `http://worker.test/kilo/session/${kiloSessionId}/message?limit=1&before=not-a-cursor`
      ),
      env,
      userId: 'usr_1',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: 'agent_cold',
        })),
        resolveLiveWrapper,
      },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: 'KILO_QUERY_INVALID' });
    expect(resolveLiveWrapper).not.toHaveBeenCalled();
    expect(env.SESSION_INGEST.getCloudAgentRootSessionMessages).not.toHaveBeenCalled();
  });

  it('rejects a decodable non-message cursor before durable lookup', async () => {
    const env = envStub();
    const resolveLiveWrapper = vi.fn();
    const cursor = btoa(JSON.stringify({ id: 'other_01', time: 1 })).replace(/=+$/g, '');

    const response = await handleKiloFacadeRequest({
      request: new Request(
        `http://worker.test/kilo/session/${kiloSessionId}/message?limit=1&before=${cursor}`
      ),
      env,
      userId: 'usr_1',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: 'agent_cold',
        })),
        resolveLiveWrapper,
      },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: 'KILO_QUERY_INVALID' });
    expect(resolveLiveWrapper).not.toHaveBeenCalled();
    expect(env.SESSION_INGEST.getCloudAgentRootSessionMessages).not.toHaveBeenCalled();
  });

  it('rejects message page limits above the shared maximum before live or persisted reads', async () => {
    const env = envStub();
    const resolveLiveWrapper = vi.fn();

    const response = await handleKiloFacadeRequest({
      request: new Request(
        `http://worker.test/kilo/session/${kiloSessionId}/message?limit=${MAX_KILO_SDK_MESSAGE_HISTORY_PAGE_SIZE + 1}`
      ),
      env,
      userId: 'usr_1',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: 'agent_cold',
        })),
        resolveLiveWrapper,
      },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: 'KILO_QUERY_INVALID' });
    expect(resolveLiveWrapper).not.toHaveBeenCalled();
    expect(env.SESSION_INGEST.getCloudAgentRootSessionMessages).not.toHaveBeenCalled();
  });

  it('rejects repeated message pagination parameters before live or persisted reads', async () => {
    const env = envStub();
    const resolveLiveWrapper = vi.fn();

    const response = await handleKiloFacadeRequest({
      request: new Request(
        `http://worker.test/kilo/session/${kiloSessionId}/message?limit=1&limit=${MAX_KILO_SDK_MESSAGE_HISTORY_PAGE_SIZE + 1}`
      ),
      env,
      userId: 'usr_1',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: 'agent_cold',
        })),
        resolveLiveWrapper,
      },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: 'KILO_QUERY_INVALID' });
    expect(resolveLiveWrapper).not.toHaveBeenCalled();
    expect(env.SESSION_INGEST.getCloudAgentRootSessionMessages).not.toHaveBeenCalled();
  });

  it('falls back to persisted messages when the wrapper has no private Kilo runtime', async () => {
    const env = envStub();
    vi.mocked(env.SESSION_INGEST.getCloudAgentRootSessionMessages).mockResolvedValue({
      kiloSessionId,
      cloudAgentSessionId: 'agent_live',
      history: { messages: sdkMessageHistory(), nextCursor: null, omittedItemCount: 0 },
    });
    const containerFetch = vi.fn<ContainerFetch>(async () =>
      Response.json(
        { error: 'KILO_RUNTIME_UNAVAILABLE', message: 'Kilo runtime is not bootstrapped' },
        { status: 503 }
      )
    );

    const response = await handleKiloFacadeRequest({
      request: new Request(`http://worker.test/kilo/session/${kiloSessionId}/message`),
      env,
      userId: 'usr_1',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: 'agent_live',
        })),
        resolveLiveWrapper: vi.fn(async () => liveWrapperTarget(containerFetch)),
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(projectedSdkMessageHistory());
  });

  it('falls back to persisted messages when the live private Kilo request fails', async () => {
    const env = envStub();
    vi.mocked(env.SESSION_INGEST.getCloudAgentRootSessionMessages).mockResolvedValue({
      kiloSessionId,
      cloudAgentSessionId: 'agent_live',
      history: { messages: sdkMessageHistory(), nextCursor: null, omittedItemCount: 0 },
    });
    const containerFetch = vi.fn<ContainerFetch>(async () =>
      Response.json({ error: 'KILO_PROXY_ERROR', message: 'fetch failed' }, { status: 502 })
    );

    const response = await handleKiloFacadeRequest({
      request: new Request(`http://worker.test/kilo/session/${kiloSessionId}/message`),
      env,
      userId: 'usr_1',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: 'agent_live',
        })),
        resolveLiveWrapper: vi.fn(async () => liveWrapperTarget(containerFetch)),
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(projectedSdkMessageHistory());
  });

  it('falls back to persisted messages when a live proxy request cannot be reached', async () => {
    const env = envStub();
    vi.mocked(env.SESSION_INGEST.getCloudAgentRootSessionMessages).mockResolvedValue({
      kiloSessionId,
      cloudAgentSessionId: 'agent_live',
      history: { messages: sdkMessageHistory(), nextCursor: null, omittedItemCount: 0 },
    });
    const containerFetch = vi.fn<ContainerFetch>(async () => {
      throw new Error('wrapper request failed');
    });

    const response = await handleKiloFacadeRequest({
      request: new Request(`http://worker.test/kilo/session/${kiloSessionId}/message`),
      env,
      userId: 'usr_1',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: 'agent_live',
        })),
        resolveLiveWrapper: vi.fn(async () => liveWrapperTarget(containerFetch)),
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(projectedSdkMessageHistory());
  });

  it('continues forwarding live message reads for freshest available history without private selectors', async () => {
    const containerFetch = vi.fn<ContainerFetch>(async () => Response.json(sdkMessageHistory()));

    const response = await handleKiloFacadeRequest({
      request: new Request(
        `http://worker.test/kilo/session/${kiloSessionId}/message?directory=${encodeURIComponent(publicCloudAgentDirectory(kiloSessionId))}&limit=1`
      ),
      env: envStub(),
      userId: 'usr_1',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: 'agent_live',
        })),
        resolveLiveWrapper: vi.fn(async () => liveWrapperTarget(containerFetch)),
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(projectedSdkMessageHistory());
    const [forwardedRequest] = containerFetch.mock.calls[0];
    expect(new URL(forwardedRequest.url).search).toBe('?limit=1');
  });

  it('preserves owner-visible structured paths and file text in live messages', async () => {
    const containerFetch = vi.fn<ContainerFetch>(async () =>
      Response.json(sdkMessageHistoryWithOwnerVisibleStructuredPaths())
    );

    const response = await handleKiloFacadeRequest({
      request: new Request(`http://worker.test/kilo/session/${kiloSessionId}/message`),
      env: envStub(),
      userId: 'usr_1',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: 'agent_live',
        })),
        resolveLiveWrapper: vi.fn(async () => liveWrapperTarget(containerFetch)),
      },
    });

    expect(response.status).toBe(200);
    expectOwnerVisibleStructuredMessagePaths((await response.json()) as KiloSdkStoredMessage[]);
  });

  it('bounds and validates successful live message JSON before public projection', async () => {
    const oversizedResponse = await handleKiloFacadeRequest({
      request: new Request(`http://worker.test/kilo/session/${kiloSessionId}/message`),
      env: envStub(),
      userId: 'usr_1',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: 'agent_live',
        })),
        resolveLiveWrapper: vi.fn(async () =>
          liveWrapperTarget(
            async () =>
              new Response(JSON.stringify(sdkMessageHistory()), {
                status: 200,
                headers: { 'Content-Length': String(8 * 1024 * 1024 + 1) },
              })
          )
        ),
      },
    });
    expect(oversizedResponse.status).toBe(502);
    await expect(oversizedResponse.json()).resolves.toMatchObject({
      error: 'KILO_UPSTREAM_RESPONSE_INVALID',
    });

    const malformedResponse = await handleKiloFacadeRequest({
      request: new Request(`http://worker.test/kilo/session/${kiloSessionId}/message`),
      env: envStub(),
      userId: 'usr_1',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: 'agent_live',
        })),
        resolveLiveWrapper: vi.fn(async () =>
          liveWrapperTarget(async () => Response.json([{ info: {} }]))
        ),
      },
    });
    expect(malformedResponse.status).toBe(502);
    await expect(malformedResponse.json()).resolves.toMatchObject({
      error: 'KILO_UPSTREAM_RESPONSE_INVALID',
    });
  });

  it('bounds live messages without consuming an oversized streamed body', async () => {
    const response = await handleKiloFacadeRequest({
      request: new Request(`http://worker.test/kilo/session/${kiloSessionId}/message`),
      env: envStub(),
      userId: 'usr_1',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: 'agent_live',
        })),
        resolveLiveWrapper: vi.fn(async () =>
          liveWrapperTarget(
            async () =>
              new Response(
                new ReadableStream<Uint8Array>({
                  start(controller) {
                    controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1));
                    controller.close();
                  },
                })
              )
          )
        ),
      },
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: 'KILO_UPSTREAM_RESPONSE_INVALID',
    });
  });

  it('preserves owner-visible structured paths and file text in cold messages', async () => {
    const env = envStub();
    const history = sdkMessageHistoryWithOwnerVisibleStructuredPaths();
    vi.mocked(env.SESSION_INGEST.getCloudAgentRootSessionMessages).mockResolvedValue({
      kiloSessionId,
      cloudAgentSessionId: 'agent_cold',
      history: { messages: history, nextCursor: null, omittedItemCount: 0 },
    });
    const response = await handleKiloFacadeRequest({
      request: new Request(`http://worker.test/kilo/session/${kiloSessionId}/message`),
      env,
      userId: 'usr_1',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: 'agent_cold',
        })),
        resolveLiveWrapper: vi.fn(async () => null),
      },
    });

    expect(response.status).toBe(200);
    expectOwnerVisibleStructuredMessagePaths((await response.json()) as KiloSdkStoredMessage[]);
  });

  it('preserves non-enumerating not-found behavior for a cold transcript miss', async () => {
    const env = envStub();
    vi.mocked(env.SESSION_INGEST.getCloudAgentRootSessionMessages).mockResolvedValue(null);

    const response = await handleKiloFacadeRequest({
      request: new Request(`http://worker.test/kilo/session/${kiloSessionId}/message`),
      env,
      userId: 'usr_1',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: 'agent_cold',
        })),
        resolveLiveWrapper: vi.fn(async () => null),
      },
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: 'KILO_SESSION_NOT_FOUND' });
  });

  it('returns snapshot-pending for a listed root without persisted transcript state', async () => {
    const env = envStub();
    vi.mocked(env.SESSION_INGEST.getCloudAgentRootSessionMessages).mockResolvedValue({
      kiloSessionId,
      cloudAgentSessionId: 'agent_pending',
      history: null,
    });

    const response = await handleKiloFacadeRequest({
      request: new Request(`http://worker.test/kilo/session/${kiloSessionId}/message`),
      env,
      userId: 'usr_1',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: 'agent_pending',
        })),
        resolveLiveWrapper: vi.fn(async () => null),
      },
    });

    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('1');
    await expect(response.json()).resolves.toMatchObject({
      error: 'KILO_SESSION_SNAPSHOT_PENDING',
    });
  });

  it('maps an oversized cold transcript materialization result to stable 413', async () => {
    const env = envStub();
    vi.mocked(env.SESSION_INGEST.getCloudAgentRootSessionMessages).mockResolvedValue({
      kiloSessionId,
      cloudAgentSessionId: 'agent_cold',
      history: { kind: 'too_large', maximumBytes: 8 * 1024 * 1024, phase: 'message_scan' },
    });

    const response = await handleKiloFacadeRequest({
      request: new Request(`http://worker.test/kilo/session/${kiloSessionId}/message?limit=1`),
      env,
      userId: 'usr_1',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: 'agent_cold',
        })),
        resolveLiveWrapper: vi.fn(async () => null),
      },
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: 'KILO_TRANSCRIPT_TOO_LARGE',
      message:
        'Persisted Kilo transcript exceeds the safe cold-read budget; use smaller bounded history when possible, or retry while a live runtime is available',
    });
  });

  it('maps retryable cold transcript failure to stable retryable 503', async () => {
    const env = envStub();
    vi.mocked(env.SESSION_INGEST.getCloudAgentRootSessionMessages).mockResolvedValue({
      kiloSessionId,
      cloudAgentSessionId: 'agent_cold',
      history: { kind: 'retryable_failure', phase: 'page_parts' },
    });

    const response = await handleKiloFacadeRequest({
      request: new Request(`http://worker.test/kilo/session/${kiloSessionId}/message`),
      env,
      userId: 'usr_1',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: 'agent_cold',
        })),
        resolveLiveWrapper: vi.fn(async () => null),
      },
    });

    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('1');
    await expect(response.json()).resolves.toMatchObject({ error: 'KILO_SESSION_READ_RETRYABLE' });
  });

  it('maps invalid persisted transcript data to the warm-path upstream invalid response', async () => {
    const env = envStub();
    vi.mocked(env.SESSION_INGEST.getCloudAgentRootSessionMessages).mockResolvedValue({
      kiloSessionId,
      cloudAgentSessionId: 'agent_cold',
      history: { kind: 'invalid_data' },
    } as never);

    const response = await handleKiloFacadeRequest({
      request: new Request(`http://worker.test/kilo/session/${kiloSessionId}/message`),
      env,
      userId: 'usr_1',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: 'agent_cold',
        })),
        resolveLiveWrapper: vi.fn(async () => null),
      },
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: 'KILO_UPSTREAM_RESPONSE_INVALID',
      message: 'Kilo messages response is not valid',
    });
  });

  it('accepts the exact public directory selector on prompt_async while retaining prompt admission', async () => {
    const admitPrompt = vi.fn().mockResolvedValue({
      success: true,
      outcome: 'queued',
      messageId: 'msg_match_directory',
      compatibilityDelivery: 'queued',
    });
    const response = await handleKiloFacadeRequest({
      request: new Request(
        `http://worker.test/kilo/session/${kiloSessionId}/prompt_async?directory=${encodeURIComponent(publicCloudAgentDirectory(kiloSessionId))}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ parts: [{ type: 'text', text: 'matching selector' }] }),
        }
      ),
      env: envStub(),
      userId: 'usr_1',
      authToken: 'validated-token',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: 'agent_cold',
        })),
        validatePromptBalance: vi.fn(async () => ({ success: true as const })),
        admitPrompt,
      },
    });

    expect(response.status).toBe(204);
    expect(admitPrompt).toHaveBeenCalledOnce();
  });

  it('rejects workspace or mismatching prompt selectors before balance or admission side effects', async () => {
    const validatePromptBalance = vi.fn();
    const admitPrompt = vi.fn();
    for (const search of [
      '?workspace=private',
      `?directory=${encodeURIComponent(publicCloudAgentDirectory('ses_22222222222222222222222222'))}`,
    ]) {
      const response = await handleKiloFacadeRequest({
        request: new Request(
          `http://worker.test/kilo/session/${kiloSessionId}/prompt_async${search}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ parts: [{ type: 'text', text: 'blocked' }] }),
          }
        ),
        env: envStub(),
        userId: 'usr_1',
        authToken: 'validated-token',
        deps: {
          resolveRootSessionForKiloSession: vi.fn(async () => ({
            cloudAgentSessionId: 'agent_cold',
          })),
          validatePromptBalance,
          admitPrompt,
        },
      });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: 'KILO_SESSION_SELECTOR_UNSUPPORTED',
      });
    }
    expect(validatePromptBalance).not.toHaveBeenCalled();
    expect(admitPrompt).not.toHaveBeenCalled();
  });

  it('rejects repeated prompt selectors before balance or admission side effects', async () => {
    const validatePromptBalance = vi.fn();
    const admitPrompt = vi.fn();
    const directory = encodeURIComponent(publicCloudAgentDirectory(kiloSessionId));

    const response = await handleKiloFacadeRequest({
      request: new Request(
        `http://worker.test/kilo/session/${kiloSessionId}/prompt_async?directory=${directory}&directory=${directory}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ parts: [{ type: 'text', text: 'blocked' }] }),
        }
      ),
      env: envStub(),
      userId: 'usr_1',
      authToken: 'validated-token',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: 'agent_cold',
        })),
        validatePromptBalance,
        admitPrompt,
      },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: 'KILO_QUERY_INVALID' });
    expect(validatePromptBalance).not.toHaveBeenCalled();
    expect(admitPrompt).not.toHaveBeenCalled();
  });

  it('rejects abort selectors before interruption side effects', async () => {
    const interruptPrompt = vi.fn();
    const response = await handleKiloFacadeRequest({
      request: new Request(
        `http://worker.test/kilo/session/${kiloSessionId}/abort?workspace=private`,
        {
          method: 'POST',
        }
      ),
      env: envStub(),
      userId: 'usr_1',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: 'agent_cold',
        })),
        interruptPrompt,
      },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: 'KILO_SESSION_SELECTOR_UNSUPPORTED',
    });
    expect(interruptPrompt).not.toHaveBeenCalled();
  });

  it('admits text-only prompt_async through the session DO while its wrapper is cold', async () => {
    const env = envStub();
    const admitSubmittedMessage = vi.fn().mockResolvedValue({
      success: true,
      outcome: 'queued',
      messageId: 'msg_018f1e2d3c4bAsynPrmtAbCdEf',
      compatibilityDelivery: 'queued',
    });
    vi.spyOn(env.CLOUD_AGENT_SESSION, 'get').mockReturnValue({
      hasMessageAdmission: vi.fn().mockResolvedValue(false),
      admitSubmittedMessage,
    } as never);
    const idFromName = vi.spyOn(env.CLOUD_AGENT_SESSION, 'idFromName');
    const resolveLiveWrapper = vi.fn();

    const response = await handleKiloFacadeRequest({
      request: new Request(`http://worker.test/kilo/session/${kiloSessionId}/prompt_async`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messageID: 'msg_018f1e2d3c4bAsynPrmtAbCdEf',
          parts: [
            { type: 'text', text: 'hello' },
            { type: 'text', text: ' world' },
          ],
        }),
      }),
      env,
      userId: 'usr_1',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: 'agent_cold',
        })),
        resolveLiveWrapper,
        validatePromptBalance: vi.fn(async () => ({ success: true as const })),
      },
      authToken: 'validated-token',
    });

    expect(response.status).toBe(204);
    expect(resolveLiveWrapper).not.toHaveBeenCalled();
    expect(idFromName).toHaveBeenCalledWith('usr_1:agent_cold');
    expect(admitSubmittedMessage).toHaveBeenCalledWith({
      userId: 'usr_1',
      turn: {
        type: 'prompt',
        id: 'msg_018f1e2d3c4bAsynPrmtAbCdEf',
        prompt: 'hello world',
      },
    });
  });

  it('forwards native SDK agent and Kilo model selections through prompt_async admission', async () => {
    const env = envStub();
    const admitSubmittedMessage = vi.fn().mockResolvedValue({
      success: true,
      outcome: 'queued',
      messageId: 'msg_018f1e2d3c4bAgentModAbCdEf',
      compatibilityDelivery: 'queued',
    });
    vi.spyOn(env.CLOUD_AGENT_SESSION, 'get').mockReturnValue({
      hasMessageAdmission: vi.fn().mockResolvedValue(false),
      admitSubmittedMessage,
    } as never);

    const response = await handleKiloFacadeRequest({
      request: new Request(`http://worker.test/kilo/session/${kiloSessionId}/prompt_async`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messageID: 'msg_018f1e2d3c4bAgentModAbCdEf',
          agent: 'plan',
          model: { providerID: 'kilo', modelID: 'anthropic/claude-sonnet-4' },
          parts: [{ type: 'text', text: 'use my selection' }],
        }),
      }),
      env,
      userId: 'usr_1',
      authToken: 'validated-token',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: 'agent_cold',
        })),
        validatePromptBalance: vi.fn(async () => ({ success: true as const })),
      },
    });

    expect(response.status).toBe(204);
    expect(preflightExistingPromptModelMock).toHaveBeenCalledWith({
      env,
      userId: 'usr_1',
      cloudAgentSessionId: 'agent_cold',
      requestedModel: 'anthropic/claude-sonnet-4',
      procedure: 'kilo.prompt_async',
    });
    expect(admitSubmittedMessage).toHaveBeenCalledWith({
      userId: 'usr_1',
      turn: {
        type: 'prompt',
        id: 'msg_018f1e2d3c4bAgentModAbCdEf',
        prompt: 'use my selection',
      },
      agent: { mode: 'plan', model: 'anthropic/claude-sonnet-4' },
    });
  });

  it('rejects non-Kilo SDK model providers before prompt_async side effects', async () => {
    const validatePromptBalance = vi.fn();
    const admitPrompt = vi.fn();

    const response = await handleKiloFacadeRequest({
      request: new Request(`http://worker.test/kilo/session/${kiloSessionId}/prompt_async`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: { providerID: 'anthropic', modelID: 'claude-sonnet-4' },
          parts: [{ type: 'text', text: 'unsupported provider' }],
        }),
      }),
      env: envStub(),
      userId: 'usr_1',
      authToken: 'validated-token',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: 'agent_cold',
        })),
        validatePromptBalance,
        admitPrompt,
      },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: 'KILO_BASIC_PROMPT_UNSUPPORTED',
    });
    expect(validatePromptBalance).not.toHaveBeenCalled();
    expect(preflightExistingPromptModelMock).not.toHaveBeenCalled();
    expect(admitPrompt).not.toHaveBeenCalled();
  });

  it('preflights the stored session model before admitting a new prompt_async message', async () => {
    const env = envStub();
    const admitSubmittedMessage = vi.fn().mockResolvedValue({
      success: true,
      outcome: 'queued',
      messageId: 'msg_018f1e2d3c4bPreflightAbCdEf',
      compatibilityDelivery: 'queued',
    });
    vi.spyOn(env.CLOUD_AGENT_SESSION, 'get').mockReturnValue({
      admitSubmittedMessage,
    } as never);

    const response = await handleKiloFacadeRequest({
      request: new Request(`http://worker.test/kilo/session/${kiloSessionId}/prompt_async`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parts: [{ type: 'text', text: 'preflight me' }] }),
      }),
      env,
      userId: 'usr_1',
      authToken: 'validated-token',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: 'agent_cold',
        })),
        validatePromptBalance: vi.fn(async () => ({ success: true as const })),
      },
    });

    expect(response.status).toBe(204);
    expect(preflightExistingPromptModelMock).toHaveBeenCalledWith({
      env,
      userId: 'usr_1',
      cloudAgentSessionId: 'agent_cold',
      procedure: 'kilo.prompt_async',
    });
    expect(preflightExistingPromptModelMock.mock.invocationCallOrder[0]).toBeLessThan(
      admitSubmittedMessage.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
  });

  it('replays an admitted matching prompt_async message before model preflight', async () => {
    const env = envStub();
    const admitSubmittedMessage = vi.fn().mockResolvedValue({
      success: true,
      outcome: 'queued',
      messageId: 'msg_018f1e2d3c4bReplayAbCdEfGh',
      compatibilityDelivery: 'queued',
    });
    const hasMessageAdmission = vi.fn().mockResolvedValue(true);
    vi.spyOn(env.CLOUD_AGENT_SESSION, 'get').mockReturnValue({
      admitSubmittedMessage,
      hasMessageAdmission,
    } as never);
    preflightExistingPromptModelMock.mockRejectedValue(
      new Error('Selected model is no longer available')
    );

    const response = await handleKiloFacadeRequest({
      request: new Request(`http://worker.test/kilo/session/${kiloSessionId}/prompt_async`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messageID: 'msg_018f1e2d3c4bReplayAbCdEfGh',
          parts: [{ type: 'text', text: 'retry me' }],
        }),
      }),
      env,
      userId: 'usr_1',
      authToken: 'validated-token',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: 'agent_cold',
        })),
        validatePromptBalance: vi.fn(async () => ({ success: true as const })),
      },
    });

    expect(response.status).toBe(204);
    expect(hasMessageAdmission).toHaveBeenCalledWith('msg_018f1e2d3c4bReplayAbCdEfGh');
    expect(preflightExistingPromptModelMock).not.toHaveBeenCalled();
    expect(admitSubmittedMessage).toHaveBeenCalledOnce();
  });

  it('maps unavailable stored-session models to an SDK error before prompt_async admission', async () => {
    const env = envStub();
    const admitPrompt = vi.fn();
    preflightExistingPromptModelMock.mockRejectedValue(
      new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Selected model is not available for this cloud agent session',
      })
    );

    const response = await handleKiloFacadeRequest({
      request: new Request(`http://worker.test/kilo/session/${kiloSessionId}/prompt_async`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parts: [{ type: 'text', text: 'reject me' }] }),
      }),
      env,
      userId: 'usr_1',
      authToken: 'validated-token',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: 'agent_cold',
        })),
        validatePromptBalance: vi.fn(async () => ({ success: true as const })),
        admitPrompt,
      },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'KILO_PROMPT_ADMISSION_REJECTED',
      message: 'Selected model is not available for this cloud agent session',
    });
    expect(admitPrompt).not.toHaveBeenCalled();
  });

  it('maps unavailable stored-session model validation to retryable SDK error before admission', async () => {
    const env = envStub();
    const admitPrompt = vi.fn();
    preflightExistingPromptModelMock.mockRejectedValue(
      new TRPCError({
        code: 'SERVICE_UNAVAILABLE',
        message: 'Model availability could not be verified',
      })
    );

    const response = await handleKiloFacadeRequest({
      request: new Request(`http://worker.test/kilo/session/${kiloSessionId}/prompt_async`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parts: [{ type: 'text', text: 'retry later' }] }),
      }),
      env,
      userId: 'usr_1',
      authToken: 'validated-token',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: 'agent_cold',
        })),
        validatePromptBalance: vi.fn(async () => ({ success: true as const })),
        admitPrompt,
      },
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: 'MODEL_VALIDATION_UNAVAILABLE',
      message: 'Model availability could not be verified',
    });
    expect(admitPrompt).not.toHaveBeenCalled();
  });

  it('rejects unsupported prompt_async semantic fields without admitting work', async () => {
    const env = envStub();
    const admitSubmittedMessage = vi.fn();
    vi.spyOn(env.CLOUD_AGENT_SESSION, 'get').mockReturnValue({
      admitSubmittedMessage,
    } as never);

    const response = await handleKiloFacadeRequest({
      request: new Request(`http://worker.test/kilo/session/${kiloSessionId}/prompt_async`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          parts: [{ type: 'text', text: 'hello' }],
          noReply: true,
        }),
      }),
      env,
      userId: 'usr_1',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: 'agent_cold',
        })),
      },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: 'KILO_BASIC_PROMPT_UNSUPPORTED',
    });
    expect(admitSubmittedMessage).not.toHaveBeenCalled();
  });

  it('rejects malformed or oversized prompt_async bodies before balance or admission side effects', async () => {
    const validatePromptBalance = vi.fn();
    const admitPrompt = vi.fn();
    const supportedPromptBody = JSON.stringify({ parts: [{ type: 'text', text: 'hello' }] });
    for (const requestInit of [
      { body: '{', headers: new Headers({ 'Content-Type': 'application/json' }) },
      {
        body: supportedPromptBody,
        headers: new Headers({
          'Content-Type': 'application/json',
          'Content-Length': String(256 * 1024 + 1),
        }),
      },
      {
        body: supportedPromptBody.padEnd(256 * 1024 + 1, ' '),
        headers: new Headers({ 'Content-Type': 'application/json' }),
      },
    ]) {
      const response = await handleKiloFacadeRequest({
        request: new Request(`http://worker.test/kilo/session/${kiloSessionId}/prompt_async`, {
          method: 'POST',
          ...requestInit,
        }),
        env: envStub(),
        userId: 'usr_1',
        authToken: 'validated-token',
        deps: {
          resolveRootSessionForKiloSession: vi.fn(async () => ({
            cloudAgentSessionId: 'agent_cold',
          })),
          validatePromptBalance,
          admitPrompt,
        },
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: 'KILO_BASIC_PROMPT_UNSUPPORTED',
        message: 'Basic Kilo prompt body is not supported',
      });
    }
    expect(validatePromptBalance).not.toHaveBeenCalled();
    expect(admitPrompt).not.toHaveBeenCalled();
  });

  it('rejects prompt_async attempts to bypass public balance validation after owner resolution', async () => {
    const env = envStub();
    const validatePromptBalance = vi.fn();
    const admitPrompt = vi.fn();
    const resolveRootSessionForKiloSession = vi.fn(async () => ({
      cloudAgentSessionId: 'agent_owned',
    }));

    const response = await handleKiloFacadeRequest({
      request: new Request(`http://worker.test/kilo/session/${kiloSessionId}/prompt_async`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-skip-balance-check': 'true',
        },
        body: JSON.stringify({ parts: [{ type: 'text', text: 'local acceptance' }] }),
      }),
      env,
      userId: 'usr_1',
      authToken: 'validated-token',
      deps: {
        resolveRootSessionForKiloSession,
        validatePromptBalance,
        admitPrompt,
      },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'KILO_BALANCE_BYPASS_UNSUPPORTED',
      message: 'Balance bypass is not supported for public Kilo prompt mutations',
    });
    expect(resolveRootSessionForKiloSession).toHaveBeenCalledWith({
      env,
      userId: 'usr_1',
      kiloSessionId,
    });
    expect(validatePromptBalance).not.toHaveBeenCalled();
    expect(admitPrompt).not.toHaveBeenCalled();
  });

  it('does not support synchronous prompt mutation or admit its body', async () => {
    const validatePromptBalance = vi.fn();
    const admitPrompt = vi.fn();

    const response = await handleKiloFacadeRequest({
      request: new Request(`http://worker.test/kilo/session/${kiloSessionId}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messageID: 'msg_018f1e2d3c4bSyncGoneAbCdEf',
          parts: [{ type: 'text', text: 'do not admit this' }],
        }),
      }),
      env: envStub(),
      userId: 'usr_1',
      authToken: 'validated-token',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: 'agent_owned',
        })),
        validatePromptBalance,
        admitPrompt,
      },
    });

    expect(response.status).toBe(501);
    await expect(response.json()).resolves.toMatchObject({ error: 'KILO_ROUTE_UNSUPPORTED' });
    expect(validatePromptBalance).not.toHaveBeenCalled();
    expect(admitPrompt).not.toHaveBeenCalled();
  });

  it('applies public balance validation before durable prompt admission', async () => {
    const env = envStub();
    const admitPrompt = vi.fn();
    const validatePromptBalance = vi.fn().mockResolvedValue({
      success: false,
      status: 402,
      message: 'Insufficient credits: $1 minimum required',
    });

    const response = await handleKiloFacadeRequest({
      request: new Request(`http://worker.test/kilo/session/${kiloSessionId}/prompt_async`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parts: [{ type: 'text', text: 'hello' }] }),
      }),
      env,
      userId: 'usr_1',
      authToken: 'validated-token',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: 'agent_cold',
        })),
        validatePromptBalance,
        admitPrompt,
      },
    });

    expect(response.status).toBe(402);
    await expect(response.json()).resolves.toMatchObject({
      error: 'KILO_BALANCE_VALIDATION_FAILED',
    });
    expect(validatePromptBalance).toHaveBeenCalledWith({
      env,
      authToken: 'validated-token',
      userId: 'usr_1',
      cloudAgentSessionId: 'agent_cold',
    });
    expect(admitPrompt).not.toHaveBeenCalled();
  });

  it('applies abort idempotently and returns the native boolean success response', async () => {
    const interruptPrompt = vi.fn().mockResolvedValue({
      success: false,
      message: 'No accepted wrapper messages or pending queued messages',
    });
    const resolveLiveWrapper = vi.fn();

    const response = await handleKiloFacadeRequest({
      request: new Request(`http://worker.test/kilo/session/${kiloSessionId}/abort`, {
        method: 'POST',
      }),
      env: envStub(),
      userId: 'usr_1',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: 'agent_cold',
        })),
        interruptPrompt,
        resolveLiveWrapper,
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toBe(true);
    expect(interruptPrompt).toHaveBeenCalledWith({
      env: expect.anything(),
      userId: 'usr_1',
      cloudAgentSessionId: 'agent_cold',
    });
    expect(resolveLiveWrapper).not.toHaveBeenCalled();
  });

  it('rejects unsupported root-scoped session routes without contacting a warm wrapper', async () => {
    const containerFetch = vi.fn<ContainerFetch>(async () => new Response('unexpected'));
    const resolveLiveWrapper = vi.fn(async () => liveWrapperTarget(containerFetch));

    const response = await handleKiloFacadeRequest({
      request: new Request(`http://worker.test/kilo/session/${kiloSessionId}/share?cursor=abc`, {
        method: 'POST',
        body: JSON.stringify({ prompt: 'hello' }),
      }),
      env: envStub(),
      userId: 'usr_1',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: 'agent_live',
        })),
        resolveLiveWrapper,
      },
    });

    expect(response.status).toBe(501);
    await expect(response.json()).resolves.toEqual({
      error: 'KILO_ROUTE_UNSUPPORTED',
      message: 'Kilo facade route is not supported',
    });
    expect(resolveLiveWrapper).not.toHaveBeenCalled();
    expect(containerFetch).not.toHaveBeenCalled();
  });

  it('preserves the exact no-suffix session route shape', async () => {
    const containerFetch = vi.fn<ContainerFetch>(async () => new Response('ok'));

    await handleKiloFacadeRequest({
      request: new Request(`http://worker.test/kilo/session/${kiloSessionId}`),
      env: envStub(),
      userId: 'usr_1',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: 'agent_live',
        })),
        resolveLiveWrapper: vi.fn(async () => liveWrapperTarget(containerFetch)),
      },
    });

    const [forwardedRequest] = containerFetch.mock.calls[0];
    expect(new URL((forwardedRequest as Request).url).pathname).toBe(
      `/kilo-proxy/session/${kiloSessionId}`
    );
  });
});

describe('UserKiloFacade producer messages', () => {
  it('does not let an older routed producer replace a newer connected feed', async () => {
    const validateKiloGlobalFeedProducer = vi.fn(async () => ({ success: true as const }));
    const close = vi.fn();
    const currentSocket = {
      close,
      deserializeAttachment: () => ({
        userId: 'usr_1',
        cloudAgentSessionId: 'agent_live',
        kiloSessionId,
        wrapperRunId: 'wr_current',
        wrapperGeneration: 2,
        wrapperConnectionId: 'conn_current',
      }),
    } as unknown as WebSocket;
    const ctx = {
      getWebSockets: vi.fn(() => [currentSocket]),
    } as unknown as DurableObjectState;
    const env = {
      CLOUD_AGENT_SESSION: {
        idFromName: vi.fn(() => 'session-do-id'),
        get: vi.fn(() => ({ validateKiloGlobalFeedProducer })),
      },
    } as unknown as Env;
    const facade = new UserKiloFacade(ctx, env);
    const response = await facade.fetch(
      new Request(
        'http://worker.test/internal/kilo/global-feed?userId=usr_1&cloudAgentSessionId=agent_live&kiloSessionId=ses_12345678901234567890123456&wrapperRunId=wr_old&wrapperGeneration=1&wrapperConnectionId=conn_old',
        { headers: { Upgrade: 'websocket' } }
      )
    );

    expect(response.status).toBe(409);
    expect(close).not.toHaveBeenCalled();
  });

  it('emits a native-shaped global connection event in the public virtual-server directory', async () => {
    const env = {
      CLOUD_AGENT_SESSION: { idFromName: vi.fn(), get: vi.fn() },
    } as unknown as Env;
    const facade = new UserKiloFacade({} as DurableObjectState, env);
    const response = facade.openPublicGlobalEventStream();
    const body = response.body;
    if (!body) throw new Error('Expected public global event response body');
    const reader = body.getReader();

    try {
      const event = await readSseFrame<{
        directory?: string;
        payload: { id?: string; type: string };
      }>(reader);
      expect(event.directory).toBe('/cloud-agent');
      expect(event.payload.type).toBe('server.connected');
      expect(event.payload.id).toMatch(/^evt_/);
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  });

  it('drops malformed substantive global producer envelopes without a usable directory or payload type', async () => {
    const validateKiloGlobalFeedProducer = vi.fn(async () => ({ success: true as const }));
    const env = {
      CLOUD_AGENT_SESSION: {
        idFromName: vi.fn(() => 'session-do-id'),
        get: vi.fn(() => ({ validateKiloGlobalFeedProducer })),
      },
    } as unknown as Env;
    const facade = new UserKiloFacade({} as DurableObjectState, env);
    const response = facade.openPublicGlobalEventStream();
    const body = response.body;
    if (!body) throw new Error('Expected public global event response body');
    const reader = body.getReader();
    const ws = {
      close: vi.fn(),
      send: vi.fn(),
      deserializeAttachment: () => ({
        userId: 'usr_1',
        cloudAgentSessionId: 'agent_live',
        kiloSessionId,
        wrapperRunId: 'wr_current',
        wrapperGeneration: 1,
        wrapperConnectionId: 'conn_current',
      }),
    } as unknown as WebSocket;

    try {
      await readSseFrame(reader);
      await facade.webSocketMessage(
        ws,
        JSON.stringify({
          payload: { type: 'message.updated', properties: { sessionID: kiloSessionId } },
        })
      );
      await facade.webSocketMessage(
        ws,
        JSON.stringify({
          directory: '/workspace/root',
          payload: { properties: { sessionID: kiloSessionId } },
        })
      );
      expect((ws as unknown as { send: ReturnType<typeof vi.fn> }).send).toHaveBeenCalledTimes(2);
      expect((ws as unknown as { send: ReturnType<typeof vi.fn> }).send).toHaveBeenLastCalledWith(
        JSON.stringify({ error: 'Invalid global event envelope' })
      );
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  });

  it('accepts the deployed native substantive message envelope without a payload id', async () => {
    const validateKiloGlobalFeedProducer = vi.fn(async () => ({ success: true as const }));
    const env = {
      CLOUD_AGENT_SESSION: {
        idFromName: vi.fn(() => 'session-do-id'),
        get: vi.fn(() => ({ validateKiloGlobalFeedProducer })),
      },
    } as unknown as Env;
    const facade = new UserKiloFacade({} as DurableObjectState, env);
    const response = facade.openPublicGlobalEventStream();
    const body = response.body;
    if (!body) throw new Error('Expected public global event response body');
    const reader = body.getReader();
    const ws = {
      close: vi.fn(),
      send: vi.fn(),
      deserializeAttachment: () => ({
        userId: 'usr_1',
        cloudAgentSessionId: 'agent_live',
        kiloSessionId,
        wrapperRunId: 'wr_current',
        wrapperGeneration: 1,
        wrapperConnectionId: 'conn_current',
      }),
    } as unknown as WebSocket;
    const payload = {
      type: 'message.updated',
      properties: { sessionID: kiloSessionId, info: { id: 'msg_native' } },
    };

    try {
      await readSseFrame(reader);
      await facade.webSocketMessage(
        ws,
        JSON.stringify({ directory: '/workspace/native', payload })
      );
      await expect(readSseFrame(reader)).resolves.toEqual({
        directory: publicCloudAgentDirectory(kiloSessionId),
        payload,
      });
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  });

  it('rewrites a valid substantive global producer event at the public stream boundary', async () => {
    const validateKiloGlobalFeedProducer = vi.fn(async () => ({ success: true as const }));
    const env = {
      CLOUD_AGENT_SESSION: {
        idFromName: vi.fn(() => 'session-do-id'),
        get: vi.fn(() => ({ validateKiloGlobalFeedProducer })),
      },
    } as unknown as Env;
    const facade = new UserKiloFacade({} as DurableObjectState, env);
    const response = facade.openPublicGlobalEventStream();
    const body = response.body;
    if (!body) throw new Error('Expected public global event response body');
    const reader = body.getReader();
    const ws = {
      close: vi.fn(),
      send: vi.fn(),
      deserializeAttachment: () => ({
        userId: 'usr_1',
        cloudAgentSessionId: 'agent_live',
        kiloSessionId,
        wrapperRunId: 'wr_current',
        wrapperGeneration: 1,
        wrapperConnectionId: 'conn_current',
      }),
    } as unknown as WebSocket;

    try {
      await readSseFrame(reader);
      await facade.webSocketMessage(
        ws,
        JSON.stringify({
          directory: '/workspace/private',
          project: 'project-1',
          payload: {
            id: 'evt_public',
            type: 'message.updated',
            properties: { sessionID: kiloSessionId, id: 'msg_public' },
          },
        })
      );
      await expect(readSseFrame(reader)).resolves.toEqual({
        directory: publicCloudAgentDirectory(kiloSessionId),
        project: 'project-1',
        payload: {
          id: 'evt_public',
          type: 'message.updated',
          properties: { sessionID: kiloSessionId, id: 'msg_public' },
        },
      });
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  });

  it('rewrites only the outer producer directory while preserving sibling envelope fields', async () => {
    const validateKiloGlobalFeedProducer = vi.fn(async () => ({ success: true as const }));
    const env = {
      CLOUD_AGENT_SESSION: {
        idFromName: vi.fn(() => 'session-do-id'),
        get: vi.fn(() => ({ validateKiloGlobalFeedProducer })),
      },
    } as unknown as Env;
    const facade = new UserKiloFacade({} as DurableObjectState, env);
    const response = facade.openPublicGlobalEventStream();
    const body = response.body;
    if (!body) throw new Error('Expected public global event response body');
    const reader = body.getReader();
    const ws = {
      close: vi.fn(),
      send: vi.fn(),
      deserializeAttachment: () => ({
        userId: 'usr_1',
        cloudAgentSessionId: 'agent_live',
        kiloSessionId,
        wrapperRunId: 'wr_current',
        wrapperGeneration: 1,
        wrapperConnectionId: 'conn_current',
      }),
    } as unknown as WebSocket;

    try {
      await readSseFrame(reader);
      const event = {
        directory: '/workspace/private',
        artifact: { path: '/workspace/private/envelope-secret.ts' },
        payload: {
          type: 'message.updated',
          properties: { sessionID: kiloSessionId, id: 'preserved-envelope' },
        },
      };
      await facade.webSocketMessage(ws, JSON.stringify(event));
      await expect(readSseFrame(reader)).resolves.toEqual({
        ...event,
        directory: publicCloudAgentDirectory(kiloSessionId),
      });
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  });

  it('uses comment frames for public keepalives rather than undeclared heartbeat events', async () => {
    vi.useFakeTimers();
    const env = {
      CLOUD_AGENT_SESSION: { idFromName: vi.fn(), get: vi.fn() },
    } as unknown as Env;
    const facade = new UserKiloFacade({} as DurableObjectState, env);
    const body = facade.openPublicSessionEventStream(kiloSessionId).body;
    if (!body) throw new Error('Expected public scoped event response body');
    const reader = body.getReader();
    try {
      expect((await readSseFrame<{ type: string }>(reader)).type).toBe('server.connected');
      await vi.advanceTimersByTimeAsync(10_000);
      const keepalive = await readSseTextFrame(reader);
      expect(keepalive).toBe(': heartbeat\n\n');
      expect(keepalive).not.toContain('server.heartbeat');
    } finally {
      await reader.cancel().catch(() => undefined);
      vi.useRealTimers();
    }
  });

  it('emits a native-shaped scoped connection event while no producer is live', async () => {
    const env = {
      CLOUD_AGENT_SESSION: { idFromName: vi.fn(), get: vi.fn() },
    } as unknown as Env;
    const facade = new UserKiloFacade({} as DurableObjectState, env);
    const response = facade.openPublicSessionEventStream(kiloSessionId);
    const body = response.body;
    if (!body) throw new Error('Expected public scoped event response body');
    const reader = body.getReader();

    try {
      const event = await readSseFrame<{
        id?: string;
        type: string;
        properties: Record<string, unknown>;
      }>(reader);
      expect(event).toEqual({
        id: expect.stringMatching(/^evt_/),
        type: 'server.connected',
        properties: {},
      });
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  });

  it('fans Cloud Agent extension events out before a native wrapper producer is live', async () => {
    const env = {
      CLOUD_AGENT_SESSION: { idFromName: vi.fn(), get: vi.fn() },
    } as unknown as Env;
    const facade = new UserKiloFacade({} as DurableObjectState, env);
    const globalBody = facade.openPublicGlobalEventStream().body;
    const scopedBody = facade.openPublicSessionEventStream(kiloSessionId).body;
    if (!globalBody || !scopedBody) throw new Error('Expected public event response bodies');
    const globalReader = globalBody.getReader();
    const scopedReader = scopedBody.getReader();
    const event = {
      type: 'cloud.message.queued' as const,
      properties: {
        sessionID: kiloSessionId,
        messageId: 'msg_extension',
        delivery: 'queued' as const,
      },
    };

    try {
      await readSseFrame(globalReader);
      await readSseFrame(scopedReader);
      await facade.publishCloudAgentExtensionEvent({
        kiloUserId: 'usr_1',
        cloudAgentSessionId: 'agent_live',
        kiloSessionId,
        event,
      });
      await expect(readSseFrame(scopedReader)).resolves.toEqual(event);
      await expect(readSseFrame(globalReader)).resolves.toEqual({
        directory: publicCloudAgentDirectory(kiloSessionId),
        payload: event,
      });
    } finally {
      await globalReader.cancel().catch(() => undefined);
      await scopedReader.cancel().catch(() => undefined);
    }
  });

  it('suppresses organization lifecycle extensions after current root access is lost', async () => {
    const resolveCloudAgentRootSessionForKiloSession = vi.fn(async () => null);
    const env = {
      SESSION_INGEST: { resolveCloudAgentRootSessionForKiloSession },
      CLOUD_AGENT_SESSION: { idFromName: vi.fn(), get: vi.fn() },
    } as unknown as Env;
    const facade = new UserKiloFacade({} as DurableObjectState, env);
    const body = facade.openPublicGlobalEventStream().body;
    if (!body) throw new Error('Expected public global event response body');
    const reader = body.getReader();
    const deniedEvent = {
      type: 'cloud.message.queued' as const,
      properties: {
        sessionID: kiloSessionId,
        messageId: 'msg_denied',
        delivery: 'queued' as const,
      },
    };
    const personalEvent = {
      type: 'cloud.message.sent' as const,
      properties: {
        sessionID: kiloSessionId,
        messageId: 'msg_personal',
        delivery: 'sent' as const,
      },
    };

    try {
      await readSseFrame(reader);
      await facade.publishCloudAgentExtensionEvent({
        kiloUserId: 'usr_1',
        cloudAgentSessionId: 'agent_org',
        kiloSessionId,
        organizationId: 'org_removed',
        event: deniedEvent,
      });
      await facade.publishCloudAgentExtensionEvent({
        kiloUserId: 'usr_1',
        cloudAgentSessionId: 'agent_personal',
        kiloSessionId,
        event: personalEvent,
      });
      await expect(readSseFrame(reader)).resolves.toEqual({
        directory: publicCloudAgentDirectory(kiloSessionId),
        payload: personalEvent,
      });
      expect(resolveCloudAgentRootSessionForKiloSession).toHaveBeenCalledWith({
        kiloUserId: 'usr_1',
        kiloSessionId,
      });
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  });

  it('opens a scoped stream while cold and emits only matching bare native events', async () => {
    const validateKiloGlobalFeedProducer = vi.fn(async () => ({ success: true as const }));
    const env = {
      CLOUD_AGENT_SESSION: {
        idFromName: vi.fn(() => 'session-do-id'),
        get: vi.fn(() => ({ validateKiloGlobalFeedProducer })),
      },
    } as unknown as Env;
    const facade = new UserKiloFacade({} as DurableObjectState, env);
    const response = facade.openPublicSessionEventStream(kiloSessionId);
    const body = response.body;
    if (!body) throw new Error('Expected public scoped event response body');
    const reader = body.getReader();
    const matchingWs = {
      close: vi.fn(),
      send: vi.fn(),
      deserializeAttachment: () => ({
        userId: 'usr_1',
        cloudAgentSessionId: 'agent_live',
        kiloSessionId,
        wrapperRunId: 'wr_current',
        wrapperGeneration: 1,
        wrapperConnectionId: 'conn_current',
      }),
    } as unknown as WebSocket;
    const otherWs = {
      close: vi.fn(),
      send: vi.fn(),
      deserializeAttachment: () => ({
        userId: 'usr_1',
        cloudAgentSessionId: 'agent_other',
        kiloSessionId: 'ses_22222222222222222222222222',
        wrapperRunId: 'wr_other',
        wrapperGeneration: 1,
        wrapperConnectionId: 'conn_other',
      }),
    } as unknown as WebSocket;

    try {
      const connected = await readSseFrame<{ id?: string; type: string }>(reader);
      expect(connected.type).toBe('server.connected');
      expect(connected.id).toMatch(/^evt_/);
      await facade.webSocketMessage(
        otherWs,
        JSON.stringify({
          directory: '/workspace/other',
          payload: {
            id: 'evt_other',
            type: 'message.updated',
            properties: { sessionID: 'ses_22222222222222222222222222', id: 'msg_other' },
          },
        })
      );
      await facade.webSocketMessage(
        matchingWs,
        JSON.stringify({
          directory: '/workspace/root',
          payload: {
            id: 'evt_synthetic_connected',
            type: 'server.connected',
            properties: { sessionID: kiloSessionId },
          },
        })
      );
      await facade.webSocketMessage(
        matchingWs,
        JSON.stringify({
          directory: '/workspace/root',
          payload: {
            id: 'evt_synthetic_heartbeat',
            type: 'server.heartbeat',
            properties: { sessionID: kiloSessionId },
          },
        })
      );
      await facade.webSocketMessage(
        matchingWs,
        JSON.stringify({
          directory: '/workspace/root',
          payload: {
            type: 'message.updated',
            properties: { sessionID: kiloSessionId, info: { id: 'msg_match' } },
          },
        })
      );
      const event = await readSseFrame<{
        type: string;
        properties: { sessionID: string; info: { id: string } };
      }>(reader);
      expect(event).toEqual({
        type: 'message.updated',
        properties: { sessionID: kiloSessionId, info: { id: 'msg_match' } },
      });
      expect(
        (matchingWs as unknown as { send: ReturnType<typeof vi.fn> }).send
      ).not.toHaveBeenCalled();
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  });

  it('preserves embedded session and message entities during scoped and global fanout', async () => {
    const validateKiloGlobalFeedProducer = vi.fn(async () => ({ success: true as const }));
    const env = {
      CLOUD_AGENT_SESSION: {
        idFromName: vi.fn(() => 'session-do-id'),
        get: vi.fn(() => ({ validateKiloGlobalFeedProducer })),
      },
    } as unknown as Env;
    const facade = new UserKiloFacade({} as DurableObjectState, env);
    const globalBody = facade.openPublicGlobalEventStream().body;
    const scopedBody = facade.openPublicSessionEventStream(kiloSessionId).body;
    if (!globalBody || !scopedBody) throw new Error('Expected public event response bodies');
    const globalReader = globalBody.getReader();
    const scopedReader = scopedBody.getReader();
    const ws = {
      close: vi.fn(),
      send: vi.fn(),
      deserializeAttachment: () => ({
        userId: 'usr_1',
        cloudAgentSessionId: 'agent_live',
        kiloSessionId,
        wrapperRunId: 'wr_current',
        wrapperGeneration: 1,
        wrapperConnectionId: 'conn_current',
      }),
    } as unknown as WebSocket;

    try {
      await readSseFrame(globalReader);
      await readSseFrame(scopedReader);
      await facade.webSocketMessage(
        ws,
        JSON.stringify({
          directory: '/workspace/private',
          payload: {
            type: 'session.updated',
            properties: { sessionID: kiloSessionId, info: sdkSessionInfo(kiloSessionId) },
          },
        })
      );
      await facade.webSocketMessage(
        ws,
        JSON.stringify({
          directory: '/workspace/private',
          payload: {
            type: 'message.updated',
            properties: { sessionID: kiloSessionId, info: sdkMessageHistory()[1].info },
          },
        })
      );
      await facade.webSocketMessage(
        ws,
        JSON.stringify({
          directory: '/workspace/private',
          payload: {
            type: 'message.updated',
            properties: { sessionID: kiloSessionId, info: sdkMessageHistory()[0].info },
          },
        })
      );
      await facade.webSocketMessage(
        ws,
        JSON.stringify({
          directory: '/workspace/private',
          payload: {
            type: 'message.part.updated',
            properties: {
              sessionID: kiloSessionId,
              part: {
                ...sdkMessageHistory()[1].parts[1],
                sessionID: 'ses_22222222222222222222222222',
              },
            },
          },
        })
      );

      const globalSession = await readSseFrame<{ payload: { properties: { info: unknown } } }>(
        globalReader
      );
      const scopedSession = await readSseFrame<{ properties: { info: unknown } }>(scopedReader);
      expect(globalSession.payload.properties.info).toEqual(sdkSessionInfo(kiloSessionId));
      expect(scopedSession.properties.info).toEqual(sdkSessionInfo(kiloSessionId));
      const globalMessage = await readSseFrame<{
        payload: { properties: { info: { path: unknown } } };
      }>(globalReader);
      const scopedMessage = await readSseFrame<{ properties: { info: { path: unknown } } }>(
        scopedReader
      );
      expect(globalMessage.payload.properties.info.path).toEqual({
        cwd: '/workspace/private/session',
        root: '/workspace/private',
      });
      expect(scopedMessage.properties.info.path).toEqual({
        cwd: '/workspace/private/session',
        root: '/workspace/private',
      });
      const globalUserMessage = await readSseFrame<{
        payload: { properties: { info: { editorContext: { activeFile: string } } } };
      }>(globalReader);
      const scopedUserMessage = await readSseFrame<{
        properties: { info: { editorContext: { activeFile: string } } };
      }>(scopedReader);
      expect(globalUserMessage.payload.properties.info.editorContext.activeFile).toBe(
        '/workspace/private/active.ts'
      );
      expect(scopedUserMessage.properties.info.editorContext.activeFile).toBe(
        '/workspace/private/active.ts'
      );
      const globalPart = await readSseFrame<{
        payload: {
          properties: {
            part: {
              sessionID: string;
              state: { attachments: Array<{ source: { path: string } }> };
            };
          };
        };
      }>(globalReader);
      const scopedPart = await readSseFrame<{
        properties: {
          part: { sessionID: string; state: { attachments: Array<{ source: { path: string } }> } };
        };
      }>(scopedReader);
      expect(globalPart.payload.properties.part.sessionID).toBe('ses_22222222222222222222222222');
      expect(scopedPart.properties.part.sessionID).toBe('ses_22222222222222222222222222');
      expect(globalPart.payload.properties.part.state.attachments[0].source.path).toBe(
        '/workspace/private/symbol.ts'
      );
      expect(scopedPart.properties.part.state.attachments[0].source.path).toBe(
        '/workspace/private/symbol.ts'
      );
    } finally {
      await globalReader.cancel().catch(() => undefined);
      await scopedReader.cancel().catch(() => undefined);
    }
  });

  it('does not accept Cloud Agent extension namespace frames from wrapper producers', async () => {
    const validateKiloGlobalFeedProducer = vi.fn(async () => ({ success: true as const }));
    const env = {
      CLOUD_AGENT_SESSION: {
        idFromName: vi.fn(() => 'session-do-id'),
        get: vi.fn(() => ({ validateKiloGlobalFeedProducer })),
      },
    } as unknown as Env;
    const facade = new UserKiloFacade({} as DurableObjectState, env);
    const body = facade.openPublicGlobalEventStream().body;
    if (!body) throw new Error('Expected public global event response body');
    const reader = body.getReader();
    const ws = {
      close: vi.fn(),
      send: vi.fn(),
      deserializeAttachment: () => ({
        userId: 'usr_1',
        cloudAgentSessionId: 'agent_live',
        kiloSessionId,
        wrapperRunId: 'wr_current',
        wrapperGeneration: 1,
        wrapperConnectionId: 'conn_current',
      }),
    } as unknown as WebSocket;

    try {
      await readSseFrame(reader);
      await facade.webSocketMessage(
        ws,
        JSON.stringify({
          directory: '/workspace/private',
          payload: {
            type: 'cloud.status',
            properties: {
              sessionID: kiloSessionId,
              internalDetail: 'secret backend lifecycle detail',
            },
          },
        })
      );
      await facade.webSocketMessage(
        ws,
        JSON.stringify({
          directory: '/workspace/private',
          payload: {
            type: 'message.updated',
            properties: { sessionID: kiloSessionId, id: 'safe-native-after-extension' },
          },
        })
      );
      const next = await readSseFrame<{ payload: { properties: { id: string } } }>(reader);
      expect(next.payload.properties.id).toBe('safe-native-after-extension');
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  });

  it('suppresses identityless and foreign-root wrapper events using top-level attribution', async () => {
    const validateKiloGlobalFeedProducer = vi.fn(async () => ({ success: true as const }));
    const env = {
      CLOUD_AGENT_SESSION: {
        idFromName: vi.fn(() => 'session-do-id'),
        get: vi.fn(() => ({ validateKiloGlobalFeedProducer })),
      },
    } as unknown as Env;
    const facade = new UserKiloFacade({} as DurableObjectState, env);
    const response = facade.openPublicGlobalEventStream();
    const body = response.body;
    if (!body) throw new Error('Expected public global event response body');
    const reader = body.getReader();
    const ws = {
      close: vi.fn(),
      send: vi.fn(),
      deserializeAttachment: () => ({
        userId: 'usr_1',
        cloudAgentSessionId: 'agent_live',
        kiloSessionId,
        wrapperRunId: 'wr_current',
        wrapperGeneration: 1,
        wrapperConnectionId: 'conn_current',
      }),
    } as unknown as WebSocket;

    try {
      await readSseFrame(reader);
      await facade.webSocketMessage(
        ws,
        JSON.stringify({
          directory: '/workspace/private',
          payload: { type: 'file.edited', properties: { path: '/workspace/private/secret.ts' } },
        })
      );
      for (const type of ['pty.exited', 'indexing.status', 'session.error']) {
        await facade.webSocketMessage(
          ws,
          JSON.stringify({ directory: '/workspace/private', payload: { type, properties: {} } })
        );
      }
      await facade.webSocketMessage(
        ws,
        JSON.stringify({
          directory: '/workspace/private',
          payload: {
            type: 'session.idle',
            properties: { sessionID: 'ses_22222222222222222222222222' },
          },
        })
      );
      await facade.webSocketMessage(
        ws,
        JSON.stringify({
          directory: '/workspace/private',
          payload: {
            type: 'message.updated',
            properties: {
              sessionID: kiloSessionId,
              id: 'matching-after-suppressed',
              info: sdkMessageHistory()[1].info,
              artifact: { path: '/workspace/private/unreviewed.ts' },
            },
          },
        })
      );
      const next = await readSseFrame<{
        payload: { properties: { id: string; artifact: { path: string } } };
      }>(reader);
      expect(next.payload.properties).toMatchObject({
        id: 'matching-after-suppressed',
        artifact: { path: '/workspace/private/unreviewed.ts' },
      });
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  });

  it('rejects repeated internal producer identity parameters before fence validation', async () => {
    const validateKiloGlobalFeedProducer = vi.fn();
    const idFromName = vi.fn();
    const env = {
      CLOUD_AGENT_SESSION: {
        idFromName,
        get: vi.fn(() => ({ validateKiloGlobalFeedProducer })),
      },
    } as unknown as Env;
    const facade = new UserKiloFacade({} as DurableObjectState, env);

    const response = await facade.fetch(
      new Request(
        `http://worker.test/internal/kilo/global-feed?userId=usr_1&cloudAgentSessionId=agent_live&kiloSessionId=${kiloSessionId}&wrapperRunId=wr_first&wrapperRunId=wr_second&wrapperGeneration=1&wrapperConnectionId=conn_current`,
        { headers: { Upgrade: 'websocket' } }
      )
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: 'INVALID_GLOBAL_FEED_SOURCE' });
    expect(idFromName).not.toHaveBeenCalled();
    expect(validateKiloGlobalFeedProducer).not.toHaveBeenCalled();
  });

  it('rejects a producer connection once its wrapper fence is no longer current', async () => {
    const validateKiloGlobalFeedProducer = vi.fn(async () => ({
      success: false as const,
      status: 409,
      message: 'Stale wrapper connection',
    }));
    const idFromName = vi.fn(() => 'session-do-id');
    const env = {
      CLOUD_AGENT_SESSION: {
        idFromName,
        get: vi.fn(() => ({ validateKiloGlobalFeedProducer })),
      },
    } as unknown as Env;
    const facade = new UserKiloFacade({} as DurableObjectState, env);

    const response = await facade.fetch(
      new Request(
        `http://worker.test/internal/kilo/global-feed?userId=usr_1&cloudAgentSessionId=agent_live&kiloSessionId=${kiloSessionId}&wrapperRunId=wr_stale&wrapperGeneration=1&wrapperConnectionId=conn_stale`,
        { headers: { Upgrade: 'websocket' } }
      )
    );

    expect(idFromName).toHaveBeenCalledWith('usr_1:agent_live');
    expect(validateKiloGlobalFeedProducer).toHaveBeenCalledWith({
      kiloSessionId,
      wrapperRunId: 'wr_stale',
      wrapperGeneration: 1,
      wrapperConnectionId: 'conn_stale',
    });
    expect(response.status).toBe(409);
    await expect(response.text()).resolves.toBe('Stale wrapper connection');
  });

  it('terminates a public subscriber that falls behind the live event stream', async () => {
    const validateKiloGlobalFeedProducer = vi.fn(async () => ({ success: true as const }));
    const env = {
      CLOUD_AGENT_SESSION: {
        idFromName: vi.fn(() => 'session-do-id'),
        get: vi.fn(() => ({ validateKiloGlobalFeedProducer })),
      },
    } as unknown as Env;
    const facade = new UserKiloFacade({} as DurableObjectState, env);
    const response = facade.openPublicGlobalEventStream();
    const body = response.body;
    if (!body) {
      throw new Error('Expected public global event response body');
    }
    const reader = body.getReader();
    const ws = {
      close: vi.fn(),
      send: vi.fn(),
      deserializeAttachment: () => ({
        userId: 'usr_1',
        cloudAgentSessionId: 'agent_live',
        kiloSessionId,
        wrapperRunId: 'wr_current',
        wrapperGeneration: 1,
        wrapperConnectionId: 'conn_current',
      }),
    } as unknown as WebSocket;

    for (let index = 0; index < 256; index++) {
      await facade.webSocketMessage(
        ws,
        JSON.stringify({
          directory: '/workspace/root',
          payload: {
            id: `evt_${index}`,
            type: 'message.updated',
            properties: { sessionID: kiloSessionId, id: `msg_${index}` },
          },
        })
      );
    }

    try {
      await expect(reader.read()).rejects.toThrow('Global event subscriber fell behind');
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  });

  it('preserves producer event order without revalidating each frame', async () => {
    const validateKiloGlobalFeedProducer = vi.fn();
    const idFromName = vi.fn();
    const env = {
      CLOUD_AGENT_SESSION: {
        idFromName,
        get: vi.fn(() => ({ validateKiloGlobalFeedProducer })),
      },
    } as unknown as Env;
    const facade = new UserKiloFacade({} as DurableObjectState, env);
    const response = facade.openPublicGlobalEventStream();
    const body = response.body;
    if (!body) {
      throw new Error('Expected public global event response body');
    }
    const reader = body.getReader();
    const ws = {
      close: vi.fn(),
      send: vi.fn(),
      deserializeAttachment: () => ({
        userId: 'usr_1',
        cloudAgentSessionId: 'agent_live',
        kiloSessionId,
        wrapperRunId: 'wr_current',
        wrapperGeneration: 1,
        wrapperConnectionId: 'conn_current',
      }),
    } as unknown as WebSocket;

    await facade.webSocketMessage(
      ws,
      JSON.stringify({
        directory: '/workspace/root',
        payload: {
          id: 'evt_first',
          type: 'message.updated',
          properties: { sessionID: kiloSessionId, id: 'first' },
        },
      })
    );
    await facade.webSocketMessage(
      ws,
      JSON.stringify({
        directory: '/workspace/root',
        payload: {
          id: 'evt_second',
          type: 'message.updated',
          properties: { sessionID: kiloSessionId, id: 'second' },
        },
      })
    );

    const readEvent = async (): Promise<{ payload: { properties?: { id?: string } } }> => {
      const frame = await reader.read();
      if (frame.done) {
        throw new Error('Expected global event frame');
      }
      return JSON.parse(new TextDecoder().decode(frame.value).slice('data: '.length));
    };

    try {
      await readEvent();
      expect((await readEvent()).payload.properties?.id).toBe('first');
      expect((await readEvent()).payload.properties?.id).toBe('second');
      expect(idFromName).not.toHaveBeenCalled();
      expect(validateKiloGlobalFeedProducer).not.toHaveBeenCalled();
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  });
});

describe('global event helpers', () => {
  it('rewrites only directory to the public Cloud Agent session namespace', () => {
    const payload = {
      id: 'evt_msg_1',
      type: 'message.updated',
      properties: { sessionID: kiloSessionId, id: 'msg_1' },
    };
    const event = {
      directory: '/workspace/project/sessions/agent_live',
      project: 'project-1',
      workspace: 'workspace-1',
      payload,
    };

    expect(rewriteGlobalEventDirectory(event, kiloSessionId)).toEqual({
      directory: publicCloudAgentDirectory(kiloSessionId),
      project: 'project-1',
      workspace: 'workspace-1',
      payload,
    });
  });

  it('identifies wrapper synthetic global frames for suppression', () => {
    expect(
      isSyntheticGlobalEvent({
        payload: { id: 'evt_connected', type: 'server.connected', properties: {} },
      })
    ).toBe(true);
    expect(
      isSyntheticGlobalEvent({
        payload: { id: 'evt_heartbeat', type: 'server.heartbeat', properties: {} },
      })
    ).toBe(true);
    expect(
      isSyntheticGlobalEvent({
        payload: { id: 'evt_message', type: 'message.updated', properties: {} },
      })
    ).toBe(false);
  });
});
