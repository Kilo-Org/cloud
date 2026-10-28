import {
  type CloudAgentRootSessionsPage,
  type CloudAgentRootSessionSummary,
  MAX_KILO_SDK_MESSAGE_HISTORY_PAGE_SIZE,
} from '@kilocode/session-ingest-contracts';
import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getPgDbMock, preflightExistingPromptModelMock } = vi.hoisted(() => ({
  getPgDbMock: vi.fn(),
  preflightExistingPromptModelMock: vi.fn(),
}));

vi.mock('../db/pg.js', () => ({
  getPgDb: getPgDbMock,
}));

vi.mock('../session/model-preflight.js', () => ({
  preflightSessionRuntime: vi.fn().mockResolvedValue(undefined),
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
  publicCloudAgentDirectory,
  UserKiloFacade,
  type KiloFacadeNativeTailOpener,
} from './user-kilo-facade';
import type { NativeEventTail, NativeTailOpenResult, NativeTailSink } from './native-event-tail.js';

function nativeTailDouble(options: { run?: (sink: NativeTailSink) => Promise<void> } = {}): NativeEventTail {
  return {
    async run(sink) {
      if (options.run !== undefined) return options.run(sink);
      await sink.send({ type: 'kilo.native.fence', properties: { snapshotComplete: true } });
    },
    close: () => undefined,
  };
}

const kiloSessionId = 'ses_12345678901234567890123456';
const siblingKiloSessionId = 'ses_abcdefghijklmnopqrstuvwxyz';
const groupedOwnerId = 'oauth/google:1234';
const groupedOrganizationId = '11111111-1111-4111-8111-111111111111';
const groupedWorktreeId = 'worktree_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const firstWorkspaceSessionId = 'workspace_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const siblingWorkspaceSessionId = 'workspace_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

type PendingOwnershipFixture = {
  kiloSessionId: string;
  cloudAgentSessionId: string;
  userId: string;
  organizationId: string | null;
  organizationMembershipId: string | null;
  worktreeId: string | null;
  cloudAgentSessionScopeId: string | null;
  title: string | null;
  repositoryUrl: string | null;
  createdAt: string;
  updatedAt: string;
};

function pendingOwnershipFixture(
  overrides: Partial<PendingOwnershipFixture> = {}
): PendingOwnershipFixture {
  return {
    kiloSessionId,
    cloudAgentSessionId: firstWorkspaceSessionId,
    userId: groupedOwnerId,
    organizationId: groupedOrganizationId,
    organizationMembershipId: 'membership_grouped_owner',
    worktreeId: groupedWorktreeId,
    cloudAgentSessionScopeId: firstWorkspaceSessionId,
    title: 'Grouped session',
    repositoryUrl: 'https://github.com/acme/shared.git',
    createdAt: '2026-04-29 01:16:12.945+00',
    updatedAt: '2026-04-29 01:17:13.123+00',
    ...overrides,
  };
}

function mockPendingOwnershipRows(results: PendingOwnershipFixture[][]) {
  const limit = vi.fn(async () => results.shift() ?? []);
  const where = vi.fn(() => ({ limit }));
  const leftJoin = vi.fn(() => ({ where }));
  const from = vi.fn(() => ({ leftJoin }));
  const select = vi.fn(() => ({ from }));
  getPgDbMock.mockReturnValue({ select });
  return { select, from, leftJoin, where, limit };
}

function envStub(): Env {
  return {
    SESSION_INGEST: {
      resolveCloudAgentRootSessionForKiloSession: vi.fn(),
      getCloudAgentRootSessionSnapshot: vi.fn(),
      listCloudAgentRootSessions: vi.fn(),
      getCloudAgentRootSessionMessages: vi.fn(),
    },
    SANDBOX_SESSION: {
      idFromName: vi.fn(() => 'sandbox-session-do-id'),
      get: vi.fn(),
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

function sdkMessageHistoryWithPrivateStructuredPaths(): KiloSdkStoredMessage[] {
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
          ? {
              ...tool,
              state: {
                ...tool.state,
                input: {
                  path: '/workspace/repo',
                  content: 'Keep /workspace/repo and file:///workspace/private as user text',
                },
              },
            }
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

function expectPublicStructuredMessagePaths(body: KiloSdkStoredMessage[]): void {
  const directory = publicCloudAgentDirectory(kiloSessionId);
  expect(body[1]?.parts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: 'prt_tool_1',
        state: expect.objectContaining({
          input: {
            path: directory,
            content: 'Keep /workspace/repo and file:///workspace/private as user text',
          },
          output: 'unchanged model-authored /workspace/private text',
        }),
      }),
      expect.objectContaining({
        id: 'prt_metadata_private',
        text: 'file: src/foo.ts was updated',
        metadata: { path: `${directory}/unreviewed.ts` },
      }),
      expect.objectContaining({
        id: 'prt_resource_private',
        url: 'data:text/plain,safe',
        source: expect.objectContaining({ type: 'resource', uri: '' }),
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
          source: { ...filePart.source, path: `${directory}/source.ts` },
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
                  path: `${directory}/symbol.ts`,
                },
              },
            ],
          },
        },
      ],
    },
  ];
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
      new Request(
        'http://worker.test/kilo/session/status?directory=%2Fcloud-agent%2Fsessions%2Fses_12345678901234567890123456',
        { method: 'POST' }
      ),
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
    listCloudAgentRootSessions.mockResolvedValue({
      items: [
        {
          kiloSessionId,
          cloudAgentSessionId: firstWorkspaceSessionId,
          workspaceId: 'worktree_11111111-1111-4111-8111-111111111111',
          userId: 'usr_1',
          organizationId: null,
          title: 'Mapped session',
          gitUrl: null,
          gitBranch: null,
          profileId: null,
          createdOnPlatform: 'unknown',
          created: 100,
          updated: 200,
        },
      ],
      nextCursor: null,
    });

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
    expect(openPublicGlobalEventStream).toHaveBeenCalledWith('usr_1', expect.any(Function));
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
    const tail = nativeTailDouble();

    const response = await handleKiloFacadeRequest({
      request: new Request(
        `http://worker.test/kilo/event?directory=${encodeURIComponent(publicCloudAgentDirectory(kiloSessionId))}`
      ),
      env: envStub(),
      userId: 'usr_1',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: firstWorkspaceSessionId,
        })),
        openNativeTail: vi.fn(async () => ({ kind: 'open' as const, tail })),
        globalEvents: { openPublicGlobalEventStream: vi.fn(), openPublicSessionEventStream },
      },
    });

    expect(response.status).toBe(200);
    expect(openPublicSessionEventStream).toHaveBeenCalledWith(kiloSessionId, { tail });
  });

  it('hides a non-control root scoped event selector as not found', async () => {
    const openPublicSessionEventStream = vi.fn();

    const response = await handleKiloFacadeRequest({
      request: new Request(
        `http://worker.test/kilo/event?directory=${encodeURIComponent(publicCloudAgentDirectory(kiloSessionId))}`
      ),
      env: envStub(),
      userId: 'usr_1',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: 'agent_legacy',
        })),
        globalEvents: { openPublicGlobalEventStream: vi.fn(), openPublicSessionEventStream },
      },
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: 'KILO_SESSION_NOT_FOUND' });
    expect(openPublicSessionEventStream).not.toHaveBeenCalled();
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

  it('requires a directory selector for the system event feed', async () => {
    const response = await handleKiloFacadeRequest({
      request: new Request('http://worker.test/kilo/cloud-agent/event'),
      env: envStub(),
      userId: 'usr_1',
      deps: { systemFeed: vi.fn() },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: 'KILO_EVENT_DIRECTORY_REQUIRED',
    });
  });

  it('opens the system event feed for an owned root without waking the runtime', async () => {
    const env = envStub();
    const systemFeed = vi.fn(
      () => new Response('stream', { headers: { 'Content-Type': 'text/event-stream' } })
    );

    const response = await handleKiloFacadeRequest({
      request: new Request(
        `http://worker.test/kilo/cloud-agent/event?directory=${encodeURIComponent(publicCloudAgentDirectory(kiloSessionId))}`
      ),
      env,
      userId: 'usr_1',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: firstWorkspaceSessionId,
        })),
        systemFeed,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(systemFeed).toHaveBeenCalledWith({
      env,
      userId: 'usr_1',
      cloudAgentSessionId: firstWorkspaceSessionId,
      kiloSessionId,
    });
  });

  it('rejects unsupported system event selectors before ownership lookup', async () => {
    const resolveRootSessionForKiloSession = vi.fn();
    const response = await handleKiloFacadeRequest({
      request: new Request('http://worker.test/kilo/cloud-agent/event?workspace=private'),
      env: envStub(),
      userId: 'usr_1',
      deps: { resolveRootSessionForKiloSession, systemFeed: vi.fn() },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: 'KILO_EVENT_SELECTOR_UNSUPPORTED',
    });
    expect(resolveRootSessionForKiloSession).not.toHaveBeenCalled();
  });

  it('hides a foreign system event selector as not found', async () => {
    const systemFeed = vi.fn();
    const response = await handleKiloFacadeRequest({
      request: new Request(
        `http://worker.test/kilo/cloud-agent/event?directory=${encodeURIComponent(publicCloudAgentDirectory(kiloSessionId))}`
      ),
      env: envStub(),
      userId: 'usr_1',
      deps: { resolveRootSessionForKiloSession: vi.fn(async () => null), systemFeed },
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: 'KILO_SESSION_NOT_FOUND' });
    expect(systemFeed).not.toHaveBeenCalled();
  });

  it('hides a malformed system event session id as not found', async () => {
    const resolveRootSessionForKiloSession = vi.fn();
    const response = await handleKiloFacadeRequest({
      request: new Request(
        'http://worker.test/kilo/cloud-agent/event?directory=%2Fcloud-agent%2Fsessions%2Fbad-id'
      ),
      env: envStub(),
      userId: 'usr_1',
      deps: { resolveRootSessionForKiloSession, systemFeed: vi.fn() },
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: 'KILO_SESSION_NOT_FOUND' });
    expect(resolveRootSessionForKiloSession).not.toHaveBeenCalled();
  });

  it('hides a non-control root system event selector as not found', async () => {
    const systemFeed = vi.fn();
    const response = await handleKiloFacadeRequest({
      request: new Request(
        `http://worker.test/kilo/cloud-agent/event?directory=${encodeURIComponent(publicCloudAgentDirectory(kiloSessionId))}`
      ),
      env: envStub(),
      userId: 'usr_1',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: 'agent_legacy',
        })),
        systemFeed,
      },
    });

    expect(response.status).toBe(404);
    expect(systemFeed).not.toHaveBeenCalled();
  });

  it('returns 404 for unresolved root Kilo sessions before live wrapper lookup', async () => {
    const response = await handleKiloFacadeRequest({
      request: new Request(`http://worker.test/kilo/session/${kiloSessionId}/message`),
      env: envStub(),
      userId: 'usr_1',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => null),
      },
    });

    expect(response.status).toBe(404);
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

  it('returns a persisted session snapshot when an authorized detail read is cold', async () => {
    const env = envStub();
    const getCloudAgentRootSessionSnapshot = vi.mocked(
      env.SESSION_INGEST.getCloudAgentRootSessionSnapshot
    );
    getCloudAgentRootSessionSnapshot.mockResolvedValue({
      kiloSessionId,
      cloudAgentSessionId: firstWorkspaceSessionId,
      snapshot: { kind: 'value', info: sdkSessionInfo(kiloSessionId), byteLength: 123 },
    });

    const response = await handleKiloFacadeRequest({
      request: new Request(`http://worker.test/kilo/session/${kiloSessionId}`),
      env,
      userId: 'usr_1',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: firstWorkspaceSessionId,
        })),
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(projectedSdkSessionInfo(kiloSessionId));
    expect(getCloudAgentRootSessionSnapshot).toHaveBeenCalledWith({
      kiloUserId: 'usr_1',
      kiloSessionId,
    });
  });

  it('preserves owner-visible structured paths in a cold session snapshot', async () => {
    const env = envStub();
    vi.mocked(env.SESSION_INGEST.getCloudAgentRootSessionSnapshot).mockResolvedValue({
      kiloSessionId,
      cloudAgentSessionId: firstWorkspaceSessionId,
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
          cloudAgentSessionId: firstWorkspaceSessionId,
        })),
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      share: { url: '/workspace/private/share' },
    });
  });

  it('projects distinct lazy grouped roots from authorized ownership without touching the sandbox', async () => {
    const env = envStub();
    const firstOwnership = pendingOwnershipFixture({ title: 'First grouped chat' });
    const siblingOwnership = pendingOwnershipFixture({
      kiloSessionId: siblingKiloSessionId,
      cloudAgentSessionId: siblingWorkspaceSessionId,
      cloudAgentSessionScopeId: siblingWorkspaceSessionId,
      title: null,
      updatedAt: '2026-04-29 01:18:14.456+00',
    });
    const ownershipQuery = mockPendingOwnershipRows([[firstOwnership], [siblingOwnership]]);
    vi.mocked(env.SESSION_INGEST.getCloudAgentRootSessionSnapshot).mockImplementation(
      async ({ kiloSessionId: requestedKiloSessionId }) => ({
        kiloSessionId: requestedKiloSessionId,
        cloudAgentSessionId:
          requestedKiloSessionId === kiloSessionId
            ? firstWorkspaceSessionId
            : siblingWorkspaceSessionId,
        snapshot: { kind: 'pending' },
      })
    );
    const resolveRootSessionForKiloSession = vi.fn(
      async ({ kiloSessionId: requestedKiloSessionId }: { kiloSessionId: string }) => ({
        cloudAgentSessionId:
          requestedKiloSessionId === kiloSessionId
            ? firstWorkspaceSessionId
            : siblingWorkspaceSessionId,
      })
    );

    const firstResponse = await handleKiloFacadeRequest({
      request: new Request(`http://worker.test/kilo/session/${kiloSessionId}`),
      env,
      userId: groupedOwnerId,
      deps: { resolveRootSessionForKiloSession },
    });
    const siblingResponse = await handleKiloFacadeRequest({
      request: new Request(`http://worker.test/kilo/session/${siblingKiloSessionId}`),
      env,
      userId: groupedOwnerId,
      deps: { resolveRootSessionForKiloSession },
    });

    expect(firstResponse.status).toBe(200);
    expect(siblingResponse.status).toBe(200);
    const firstSession = await firstResponse.json();
    const siblingSession = await siblingResponse.json();
    expect(firstSession).toEqual({
      id: kiloSessionId,
      slug: kiloSessionId,
      projectID: 'cloud-agent',
      directory: publicCloudAgentDirectory(kiloSessionId),
      title: 'First grouped chat',
      version: 'cloud-agent',
      time: {
        created: new Date(firstOwnership.createdAt).getTime(),
        updated: new Date(firstOwnership.updatedAt).getTime(),
      },
    });
    expect(siblingSession).toEqual({
      id: siblingKiloSessionId,
      slug: siblingKiloSessionId,
      projectID: 'cloud-agent',
      directory: publicCloudAgentDirectory(siblingKiloSessionId),
      title: 'acme/shared',
      version: 'cloud-agent',
      time: {
        created: new Date(siblingOwnership.createdAt).getTime(),
        updated: new Date(siblingOwnership.updatedAt).getTime(),
      },
    });
    expect(firstSession).not.toMatchObject({
      directory: publicCloudAgentDirectory(siblingKiloSessionId),
    });
    expect(JSON.stringify([firstSession, siblingSession])).not.toContain('/workspace/');
    expect(JSON.stringify([firstSession, siblingSession])).not.toContain(groupedOrganizationId);
    expect(ownershipQuery.leftJoin).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['ungrouped workspace sessions', { worktreeId: null }],
    ['invalid worktree identities', { worktreeId: 'worktree_invalid' }],
    ['mismatched root ownership scopes', { cloudAgentSessionScopeId: siblingWorkspaceSessionId }],
  ])('preserves the pending snapshot response for %s', async (_description, overrides) => {
    const env = envStub();
    mockPendingOwnershipRows([[pendingOwnershipFixture(overrides)]]);
    vi.mocked(env.SESSION_INGEST.getCloudAgentRootSessionSnapshot).mockResolvedValue({
      kiloSessionId,
      cloudAgentSessionId: firstWorkspaceSessionId,
      snapshot: { kind: 'pending' },
    });
    const response = await handleKiloFacadeRequest({
      request: new Request(`http://worker.test/kilo/session/${kiloSessionId}`),
      env,
      userId: groupedOwnerId,
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: firstWorkspaceSessionId,
        })),
      },
    });

    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('1');
    await expect(response.json()).resolves.toMatchObject({
      error: 'KILO_SESSION_SNAPSHOT_PENDING',
    });
  });

  it.each([
    ['another owner', { userId: 'oauth/google:another-owner' }],
    ['a revoked organization membership', { organizationMembershipId: null }],
  ])('denies a pending grouped session belonging to %s', async (_description, overrides) => {
    const env = envStub();
    mockPendingOwnershipRows([[pendingOwnershipFixture(overrides)]]);
    vi.mocked(env.SESSION_INGEST.getCloudAgentRootSessionSnapshot).mockResolvedValue({
      kiloSessionId,
      cloudAgentSessionId: firstWorkspaceSessionId,
      snapshot: { kind: 'pending' },
    });

    const response = await handleKiloFacadeRequest({
      request: new Request(`http://worker.test/kilo/session/${kiloSessionId}`),
      env,
      userId: groupedOwnerId,
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: firstWorkspaceSessionId,
        })),
      },
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: 'KILO_SESSION_NOT_FOUND' });
  });

  it('denies a foreign grouped root before reading its snapshot or ownership', async () => {
    const env = envStub();
    vi.mocked(env.SESSION_INGEST.resolveCloudAgentRootSessionForKiloSession).mockResolvedValue(
      null
    );

    const response = await handleKiloFacadeRequest({
      request: new Request(`http://worker.test/kilo/session/${kiloSessionId}`),
      env,
      userId: 'oauth/google:foreign-owner',
      deps: {},
    });

    expect(response.status).toBe(404);
    expect(env.SESSION_INGEST.getCloudAgentRootSessionSnapshot).not.toHaveBeenCalled();
    expect(getPgDbMock).not.toHaveBeenCalled();
  });

  it.each([
    'file:///workspace/private/shared',
    'https://username:password@github.com/acme/shared.git',
  ])('does not expose unsafe repository metadata from %s', async repositoryUrl => {
    const env = envStub();
    mockPendingOwnershipRows([[pendingOwnershipFixture({ title: null, repositoryUrl })]]);
    vi.mocked(env.SESSION_INGEST.getCloudAgentRootSessionSnapshot).mockResolvedValue({
      kiloSessionId,
      cloudAgentSessionId: firstWorkspaceSessionId,
      snapshot: { kind: 'pending' },
    });

    const response = await handleKiloFacadeRequest({
      request: new Request(`http://worker.test/kilo/session/${kiloSessionId}`),
      env,
      userId: groupedOwnerId,
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: firstWorkspaceSessionId,
        })),
      },
    });

    expect(response.status).toBe(200);
    const session = await response.json();
    expect(session).toMatchObject({ title: '' });
    expect(JSON.stringify(session)).not.toContain('/workspace/private');
    expect(JSON.stringify(session)).not.toContain('password');
  });

  it('rejects invalid grouped ownership timestamps without touching the sandbox', async () => {
    const env = envStub();
    mockPendingOwnershipRows([
      [pendingOwnershipFixture({ createdAt: 'not-a-postgresql-timestamp' })],
    ]);
    vi.mocked(env.SESSION_INGEST.getCloudAgentRootSessionSnapshot).mockResolvedValue({
      kiloSessionId,
      cloudAgentSessionId: firstWorkspaceSessionId,
      snapshot: { kind: 'pending' },
    });

    const response = await handleKiloFacadeRequest({
      request: new Request(`http://worker.test/kilo/session/${kiloSessionId}`),
      env,
      userId: groupedOwnerId,
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: firstWorkspaceSessionId,
        })),
      },
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: 'KILO_UPSTREAM_RESPONSE_INVALID',
    });
  });

  it('hides a cold detail read without authorized ownership as not found', async () => {
    const env = envStub();
    mockPendingOwnershipRows([[]]);
    vi.mocked(env.SESSION_INGEST.getCloudAgentRootSessionSnapshot).mockResolvedValue({
      kiloSessionId,
      cloudAgentSessionId: firstWorkspaceSessionId,
      snapshot: { kind: 'pending' },
    });

    const response = await handleKiloFacadeRequest({
      request: new Request(`http://worker.test/kilo/session/${kiloSessionId}`),
      env,
      userId: 'usr_1',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: firstWorkspaceSessionId,
        })),
      },
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: 'KILO_SESSION_NOT_FOUND',
    });
    expect(getPgDbMock).toHaveBeenCalledOnce();
  });

  it('maps an oversized cold session snapshot to stable 413', async () => {
    const env = envStub();
    vi.mocked(env.SESSION_INGEST.getCloudAgentRootSessionSnapshot).mockResolvedValue({
      kiloSessionId,
      cloudAgentSessionId: firstWorkspaceSessionId,
      snapshot: { kind: 'too_large', maximumBytes: 8 * 1024 * 1024 },
    });

    const response = await handleKiloFacadeRequest({
      request: new Request(`http://worker.test/kilo/session/${kiloSessionId}`),
      env,
      userId: 'usr_1',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: firstWorkspaceSessionId,
        })),
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
      cloudAgentSessionId: firstWorkspaceSessionId,
      snapshot: { kind: 'retryable_failure' },
    });

    const response = await handleKiloFacadeRequest({
      request: new Request(`http://worker.test/kilo/session/${kiloSessionId}`),
      env,
      userId: 'usr_1',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: firstWorkspaceSessionId,
        })),
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
      cloudAgentSessionId: firstWorkspaceSessionId,
      snapshot: { kind: 'invalid_data' },
    } as never);

    const response = await handleKiloFacadeRequest({
      request: new Request(`http://worker.test/kilo/session/${kiloSessionId}`),
      env,
      userId: 'usr_1',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: firstWorkspaceSessionId,
        })),
      },
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: 'KILO_UPSTREAM_RESPONSE_INVALID',
      message: 'Kilo session response is not valid',
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
          cloudAgentSessionId: firstWorkspaceSessionId,
        })),
      },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: 'KILO_SESSION_SELECTOR_UNSUPPORTED',
    });
  });

  it('rejects repeated SDK session detail selectors before live wrapper lookup', async () => {
    const directory = encodeURIComponent(publicCloudAgentDirectory(kiloSessionId));

    const response = await handleKiloFacadeRequest({
      request: new Request(
        `http://worker.test/kilo/session/${kiloSessionId}?directory=${directory}&directory=${directory}`
      ),
      env: envStub(),
      userId: 'usr_1',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: firstWorkspaceSessionId,
        })),
      },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: 'KILO_QUERY_INVALID' });
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
      cloudAgentSessionId: firstWorkspaceSessionId,
      history: { messages: sdkMessageHistory(), nextCursor, omittedItemCount: 0 },
    });

    const response = await handleKiloFacadeRequest({
      request: new Request(`http://worker.test/kilo/session/${kiloSessionId}/message?limit=1`),
      env,
      userId: 'usr_1',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: firstWorkspaceSessionId,
        })),
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
      cloudAgentSessionId: firstWorkspaceSessionId,
      history: { messages: sdkMessageHistory(), nextCursor: null, omittedItemCount: 3 },
    });

    const response = await handleKiloFacadeRequest({
      request: new Request(`http://worker.test/kilo/session/${kiloSessionId}/message?limit=1`),
      env,
      userId: 'usr_1',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: firstWorkspaceSessionId,
        })),
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(projectedSdkMessageHistory());
    expect(response.headers.get('x-kilo-omitted-item-count')).toBe('3');
    expect(response.headers.get('access-control-expose-headers')).toBeNull();
    expect(response.headers.get('link')).toBeNull();
    expect(response.headers.get('x-next-cursor')).toBeNull();
  });

  it('rejects invalid message pagination before durable lookup', async () => {
    const env = envStub();

    const response = await handleKiloFacadeRequest({
      request: new Request(
        `http://worker.test/kilo/session/${kiloSessionId}/message?limit=1&before=not-a-cursor`
      ),
      env,
      userId: 'usr_1',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: firstWorkspaceSessionId,
        })),
      },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: 'KILO_QUERY_INVALID' });
    expect(env.SESSION_INGEST.getCloudAgentRootSessionMessages).not.toHaveBeenCalled();
  });

  it('rejects a decodable non-message cursor before durable lookup', async () => {
    const env = envStub();
    const cursor = btoa(JSON.stringify({ id: 'other_01', time: 1 })).replace(/=+$/g, '');

    const response = await handleKiloFacadeRequest({
      request: new Request(
        `http://worker.test/kilo/session/${kiloSessionId}/message?limit=1&before=${cursor}`
      ),
      env,
      userId: 'usr_1',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: firstWorkspaceSessionId,
        })),
      },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: 'KILO_QUERY_INVALID' });
    expect(env.SESSION_INGEST.getCloudAgentRootSessionMessages).not.toHaveBeenCalled();
  });

  it('rejects message page limits above the shared maximum before live or persisted reads', async () => {
    const env = envStub();

    const response = await handleKiloFacadeRequest({
      request: new Request(
        `http://worker.test/kilo/session/${kiloSessionId}/message?limit=${MAX_KILO_SDK_MESSAGE_HISTORY_PAGE_SIZE + 1}`
      ),
      env,
      userId: 'usr_1',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: firstWorkspaceSessionId,
        })),
      },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: 'KILO_QUERY_INVALID' });
    expect(env.SESSION_INGEST.getCloudAgentRootSessionMessages).not.toHaveBeenCalled();
  });

  it('rejects repeated message pagination parameters before live or persisted reads', async () => {
    const env = envStub();

    const response = await handleKiloFacadeRequest({
      request: new Request(
        `http://worker.test/kilo/session/${kiloSessionId}/message?limit=1&limit=${MAX_KILO_SDK_MESSAGE_HISTORY_PAGE_SIZE + 1}`
      ),
      env,
      userId: 'usr_1',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: firstWorkspaceSessionId,
        })),
      },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: 'KILO_QUERY_INVALID' });
    expect(env.SESSION_INGEST.getCloudAgentRootSessionMessages).not.toHaveBeenCalled();
  });

  it('projects private structured paths and preserves file text in cold messages', async () => {
    const env = envStub();
    const history = sdkMessageHistoryWithPrivateStructuredPaths();
    vi.mocked(env.SESSION_INGEST.getCloudAgentRootSessionMessages).mockResolvedValue({
      kiloSessionId,
      cloudAgentSessionId: firstWorkspaceSessionId,
      history: { messages: history, nextCursor: null, omittedItemCount: 0 },
    });
    const response = await handleKiloFacadeRequest({
      request: new Request(`http://worker.test/kilo/session/${kiloSessionId}/message`),
      env,
      userId: 'usr_1',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: firstWorkspaceSessionId,
        })),
      },
    });

    expect(response.status).toBe(200);
    expectPublicStructuredMessagePaths((await response.json()) as KiloSdkStoredMessage[]);
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
          cloudAgentSessionId: firstWorkspaceSessionId,
        })),
      },
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: 'KILO_SESSION_NOT_FOUND' });
  });

  it('returns snapshot-pending for a listed root without persisted transcript state', async () => {
    const env = envStub();
    vi.mocked(env.SESSION_INGEST.getCloudAgentRootSessionMessages).mockResolvedValue({
      kiloSessionId,
      cloudAgentSessionId: firstWorkspaceSessionId,
      history: null,
    });

    const response = await handleKiloFacadeRequest({
      request: new Request(`http://worker.test/kilo/session/${kiloSessionId}/message`),
      env,
      userId: 'usr_1',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: firstWorkspaceSessionId,
        })),
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
      cloudAgentSessionId: firstWorkspaceSessionId,
      history: { kind: 'too_large', maximumBytes: 8 * 1024 * 1024, phase: 'message_scan' },
    });

    const response = await handleKiloFacadeRequest({
      request: new Request(`http://worker.test/kilo/session/${kiloSessionId}/message?limit=1`),
      env,
      userId: 'usr_1',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: firstWorkspaceSessionId,
        })),
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
      cloudAgentSessionId: firstWorkspaceSessionId,
      history: { kind: 'retryable_failure', phase: 'page_parts' },
    });

    const response = await handleKiloFacadeRequest({
      request: new Request(`http://worker.test/kilo/session/${kiloSessionId}/message`),
      env,
      userId: 'usr_1',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: firstWorkspaceSessionId,
        })),
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
      cloudAgentSessionId: firstWorkspaceSessionId,
      history: { kind: 'invalid_data' },
    } as never);

    const response = await handleKiloFacadeRequest({
      request: new Request(`http://worker.test/kilo/session/${kiloSessionId}/message`),
      env,
      userId: 'usr_1',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: firstWorkspaceSessionId,
        })),
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
          cloudAgentSessionId: firstWorkspaceSessionId,
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
            cloudAgentSessionId: firstWorkspaceSessionId,
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
          cloudAgentSessionId: firstWorkspaceSessionId,
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
          cloudAgentSessionId: firstWorkspaceSessionId,
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

  it('admits text-only prompt_async through durable prompt admission', async () => {
    const env = envStub();
    const admitPrompt = vi.fn().mockResolvedValue({
      success: true,
      outcome: 'queued',
      messageId: 'msg_018f1e2d3c4bAsynPrmtAbCdEf',
      compatibilityDelivery: 'queued',
    });

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
          cloudAgentSessionId: firstWorkspaceSessionId,
        })),
        validatePromptBalance: vi.fn(async () => ({ success: true as const })),
        admitPrompt,
      },
      authToken: 'validated-token',
    });

    expect(response.status).toBe(204);
    expect(admitPrompt).toHaveBeenCalledWith({
      env,
      userId: 'usr_1',
      cloudAgentSessionId: firstWorkspaceSessionId,
      request: {
        userId: 'usr_1',
        turn: {
          type: 'prompt',
          id: 'msg_018f1e2d3c4bAsynPrmtAbCdEf',
          prompt: 'hello world',
        },
      },
    });
  });

  it('forwards native SDK agent and Kilo model selections through prompt_async admission', async () => {
    const env = envStub();
    const admitPrompt = vi.fn().mockResolvedValue({
      success: true,
      outcome: 'queued',
      messageId: 'msg_018f1e2d3c4bAgentModAbCdEf',
      compatibilityDelivery: 'queued',
    });

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
          cloudAgentSessionId: firstWorkspaceSessionId,
        })),
        validatePromptBalance: vi.fn(async () => ({ success: true as const })),
        admitPrompt,
      },
    });

    expect(response.status).toBe(204);
    expect(preflightExistingPromptModelMock).toHaveBeenCalledWith({
      env,
      userId: 'usr_1',
      cloudAgentSessionId: firstWorkspaceSessionId,
      requestedModel: 'anthropic/claude-sonnet-4',
      procedure: 'kilo.prompt_async',
    });
    expect(admitPrompt).toHaveBeenCalledWith({
      env,
      userId: 'usr_1',
      cloudAgentSessionId: firstWorkspaceSessionId,
      request: {
        userId: 'usr_1',
        turn: {
          type: 'prompt',
          id: 'msg_018f1e2d3c4bAgentModAbCdEf',
          prompt: 'use my selection',
        },
        agent: { mode: 'plan', model: 'anthropic/claude-sonnet-4' },
      },
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
          cloudAgentSessionId: firstWorkspaceSessionId,
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
    const admitPrompt = vi.fn().mockResolvedValue({
      success: true,
      outcome: 'queued',
      messageId: 'msg_018f1e2d3c4bPreflightAbCdEf',
      compatibilityDelivery: 'queued',
    });

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
          cloudAgentSessionId: firstWorkspaceSessionId,
        })),
        validatePromptBalance: vi.fn(async () => ({ success: true as const })),
        admitPrompt,
      },
    });

    expect(response.status).toBe(204);
    expect(preflightExistingPromptModelMock).toHaveBeenCalledWith({
      env,
      userId: 'usr_1',
      cloudAgentSessionId: firstWorkspaceSessionId,
      procedure: 'kilo.prompt_async',
    });
    expect(preflightExistingPromptModelMock.mock.invocationCallOrder[0]).toBeLessThan(
      admitPrompt.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
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
          cloudAgentSessionId: firstWorkspaceSessionId,
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
          cloudAgentSessionId: firstWorkspaceSessionId,
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

  it.each([
    {
      trpcCode: 'BAD_REQUEST',
      status: 400,
      publicCode: 'KILO_PROMPT_ADMISSION_REJECTED',
      message: 'Selected model is not available for this cloud agent session',
    },
    {
      trpcCode: 'FORBIDDEN',
      status: 403,
      publicCode: 'KILO_PROMPT_ADMISSION_REJECTED',
      message: 'Model catalog access denied for this cloud agent session',
    },
    {
      trpcCode: 'SERVICE_UNAVAILABLE',
      status: 503,
      publicCode: 'MODEL_VALIDATION_UNAVAILABLE',
      message: 'Model availability could not be verified',
    },
  ] as const)(
    'maps control-plane model preflight $trpcCode to an SDK error at HTTP $status',
    async ({ trpcCode, status, publicCode, message }) => {
      const env = envStub();
      // A control-plane send runs the same model-policy preflight as the legacy
      // plane; its TRPCError code is what the facade maps.
      preflightExistingPromptModelMock.mockRejectedValueOnce(
        new TRPCError({ code: trpcCode, message })
      );

      const response = await handleKiloFacadeRequest({
        request: new Request(`http://worker.test/kilo/session/${kiloSessionId}/prompt_async`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messageID: 'msg_018f1e2d3c4bAsynPrmtAbCdEf',
            model: { providerID: 'kilo', modelID: 'anthropic/claude-sonnet-4' },
            parts: [{ type: 'text', text: 'validate selection' }],
          }),
        }),
        env,
        userId: 'usr_1',
        authToken: 'validated-token',
        deps: {
          resolveRootSessionForKiloSession: vi.fn(async () => ({
            cloudAgentSessionId: 'workspace_cold',
          })),
          validatePromptBalance: vi.fn(async () => ({ success: true as const })),
        },
      });

      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toEqual({ error: publicCode, message });
    }
  );

  it('rejects unsupported prompt_async semantic fields without admitting work', async () => {
    const env = envStub();
    const admitSubmittedMessage = vi.fn();
    vi.spyOn(env.SANDBOX_SESSION, 'get').mockReturnValue({
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
          cloudAgentSessionId: firstWorkspaceSessionId,
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
            cloudAgentSessionId: firstWorkspaceSessionId,
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
      cloudAgentSessionId: firstWorkspaceSessionId,
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
          cloudAgentSessionId: firstWorkspaceSessionId,
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
          cloudAgentSessionId: firstWorkspaceSessionId,
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
      cloudAgentSessionId: firstWorkspaceSessionId,
    });
    expect(admitPrompt).not.toHaveBeenCalled();
  });

  it('hides a non-control root before abort or balance side effects', async () => {
    const interruptPrompt = vi.fn();

    const response = await handleKiloFacadeRequest({
      request: new Request(`http://worker.test/kilo/session/${kiloSessionId}/abort`, {
        method: 'POST',
      }),
      env: envStub(),
      userId: 'usr_1',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: 'agent_legacy',
        })),
        interruptPrompt,
      },
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: 'KILO_SESSION_NOT_FOUND' });
    expect(interruptPrompt).not.toHaveBeenCalled();
  });

  it('applies abort idempotently and returns the native boolean success response', async () => {
    const interruptPrompt = vi.fn().mockResolvedValue({
      success: false,
      message: 'No accepted wrapper messages or pending queued messages',
    });

    const response = await handleKiloFacadeRequest({
      request: new Request(`http://worker.test/kilo/session/${kiloSessionId}/abort`, {
        method: 'POST',
      }),
      env: envStub(),
      userId: 'usr_1',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: firstWorkspaceSessionId,
        })),
        interruptPrompt,
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toBe(true);
    expect(interruptPrompt).toHaveBeenCalledWith({
      env: expect.anything(),
      userId: 'usr_1',
      cloudAgentSessionId: firstWorkspaceSessionId,
    });
  });

  it('rejects unsupported root-scoped session routes', async () => {
    const response = await handleKiloFacadeRequest({
      request: new Request(`http://worker.test/kilo/session/${kiloSessionId}/share?cursor=abc`, {
        method: 'POST',
        body: JSON.stringify({ prompt: 'hello' }),
      }),
      env: envStub(),
      userId: 'usr_1',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: firstWorkspaceSessionId,
        })),
      },
    });

    expect(response.status).toBe(501);
    await expect(response.json()).resolves.toEqual({
      error: 'KILO_ROUTE_UNSUPPORTED',
      message: 'Kilo facade route is not supported',
    });
  });

  it('preserves the exact no-suffix session route shape', async () => {
    const env = envStub();
    const getCloudAgentRootSessionSnapshot = vi.mocked(
      env.SESSION_INGEST.getCloudAgentRootSessionSnapshot
    );
    getCloudAgentRootSessionSnapshot.mockResolvedValue({
      kiloSessionId,
      cloudAgentSessionId: firstWorkspaceSessionId,
      snapshot: { kind: 'value', info: sdkSessionInfo(kiloSessionId), byteLength: 123 },
    });

    const response = await handleKiloFacadeRequest({
      request: new Request(`http://worker.test/kilo/session/${kiloSessionId}`),
      env,
      userId: 'usr_1',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: firstWorkspaceSessionId,
        })),
      },
    });

    expect(response.status).toBe(200);
    expect(getCloudAgentRootSessionSnapshot).toHaveBeenCalledWith({
      kiloUserId: 'usr_1',
      kiloSessionId,
    });
  });
});

describe('UserKiloFacade producer messages', () => {
  it('emits a native-shaped global connection event in the public virtual-server directory', async () => {
    const env = {
      SANDBOX_SESSION: { idFromName: vi.fn(), get: vi.fn() },
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

  it('uses comment frames for public keepalives rather than undeclared heartbeat events', async () => {
    vi.useFakeTimers();
    const env = {
      SANDBOX_SESSION: { idFromName: vi.fn(), get: vi.fn() },
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
      SANDBOX_SESSION: { idFromName: vi.fn(), get: vi.fn() },
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
      SANDBOX_SESSION: { idFromName: vi.fn(), get: vi.fn() },
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
        cloudAgentSessionId: firstWorkspaceSessionId,
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
      SANDBOX_SESSION: { idFromName: vi.fn(), get: vi.fn() },
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
});


describe('hosted global native events', () => {
  function rootSummary(
    id = kiloSessionId,
    cloudAgentSessionId = firstWorkspaceSessionId
  ): CloudAgentRootSessionSummary {
    return {
      kiloSessionId: id,
      cloudAgentSessionId,
      workspaceId: 'worktree_11111111-1111-4111-8111-111111111111',
      userId: groupedOwnerId,
      organizationId: null,
      title: 'Owned root',
      gitUrl: null,
      gitBranch: null,
      profileId: null,
      createdOnPlatform: 'unknown',
      created: 100,
      updated: 200,
    };
  }

  function rootPage(roots: CloudAgentRootSessionSummary[]): CloudAgentRootSessionsPage {
    return { items: roots, nextCursor: null };
  }

  function globalFixture(roots = [rootSummary()]) {
    const env = envStub();
    const listCloudAgentRootSessions = vi.mocked(env.SESSION_INGEST.listCloudAgentRootSessions);
    listCloudAgentRootSessions.mockResolvedValue(rootPage(roots));
    const resolveRoot = vi.mocked(env.SESSION_INGEST.resolveCloudAgentRootSessionForKiloSession);
    resolveRoot.mockImplementation(async ({ kiloUserId, kiloSessionId: requestedId }) => {
      if (kiloUserId !== groupedOwnerId) return null;
      const root = roots.find(item => item.kiloSessionId === requestedId);
      return root ? { cloudAgentSessionId: root.cloudAgentSessionId } : null;
    });
    const tails = new Map<
      string,
      Array<{ sink?: NativeTailSink; closed: boolean; history?: boolean }>
    >();
    const openNativeTail = vi.fn(
      async (params: {
        env: Env;
        userId: string;
        cloudAgentSessionId: string;
        kiloSessionId: string;
        history?: boolean;
      }): Promise<NativeTailOpenResult> => {
        const entry: { sink?: NativeTailSink; closed: boolean; history?: boolean } = {
          closed: false,
          history: params.history,
        };
        const tail: NativeEventTail = {
          async run(sink) {
            entry.sink = sink;
          },
          close() {
            entry.closed = true;
          },
        };
        tails.set(params.kiloSessionId, [...(tails.get(params.kiloSessionId) ?? []), entry]);
        return { kind: 'open', tail };
      }
    );
    const waitUntil = vi.fn<(promise: Promise<unknown>) => void>();
    const facade = new UserKiloFacade({ waitUntil } as unknown as DurableObjectState, env);

    const event = (eventId: number, root = roots[0]) => ({
      type: 'message.updated',
      properties: { sessionID: root?.kiloSessionId, eventId },
    });
    const sinksFor = (root = roots[0]) => {
      if (!root) throw new Error('Expected native root fixture');
      const list = tails.get(root.kiloSessionId) ?? [];
      if (list.length === 0) throw new Error('Expected an open global native tail');
      return list;
    };
    const push = async (frames: unknown[], root = roots[0]) => {
      const list = sinksFor(root);
      for (const item of frames) for (const entry of list) await entry.sink?.send(item as never);
    };
    return { env, facade, listCloudAgentRootSessions, resolveRoot, openNativeTail, tails, waitUntil, event, push, sinksFor };
  }

  function globalReader(facade: UserKiloFacade, openNativeTail: KiloFacadeNativeTailOpener) {
    const response = facade.openPublicGlobalEventStream(groupedOwnerId, openNativeTail);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    if (!response.body) throw new Error('Expected authenticated global event response body');
    return response.body.getReader();
  }

  async function expectGlobalConnected(reader: ReadableStreamDefaultReader<Uint8Array>) {
    await expect(readSseFrame(reader)).resolves.toEqual({
      directory: '/cloud-agent',
      payload: { id: expect.stringMatching(/^evt_/), type: 'server.connected', properties: {} },
    });
  }

  it('tails only listed owned control roots without history or compute reads', async () => {
    const fixture = globalFixture([
      rootSummary(),
      rootSummary(siblingKiloSessionId, siblingWorkspaceSessionId),
      rootSummary('ses_legacy_legacy_legacy_legacy', 'agent_legacy'),
    ]);
    const reader = globalReader(fixture.facade, fixture.openNativeTail);
    try {
      await expectGlobalConnected(reader);
      expect(fixture.listCloudAgentRootSessions).toHaveBeenCalledWith({
        kiloUserId: groupedOwnerId,
        limit: 100,
      });
      const tailed = fixture.openNativeTail.mock.calls.map(([params]) => params.kiloSessionId);
      expect(new Set(tailed)).toEqual(new Set([kiloSessionId, siblingKiloSessionId]));
      expect(fixture.openNativeTail).toHaveBeenCalledWith(
        expect.objectContaining({ history: false })
      );
      expect(fixture.env.SANDBOX_SESSION.get).not.toHaveBeenCalled();
    } finally {
      await reader.cancel();
    }
  });

  it('delivers a live frame for an owned root with its directory and never fences it', async () => {
    const fixture = globalFixture();
    const reader = globalReader(fixture.facade, fixture.openNativeTail);
    try {
      await expectGlobalConnected(reader);
      await fixture.push([fixture.event(11)]);
      await expect(readSseFrame(reader)).resolves.toEqual({
        directory: publicCloudAgentDirectory(kiloSessionId),
        payload: { type: 'message.updated', properties: { sessionID: kiloSessionId, eventId: 11 } },
      });
    } finally {
      await reader.cancel();
    }
  });

  it('discovers a root added after global connection on the next heartbeat', async () => {
    vi.useFakeTimers();
    const fixture = globalFixture([]);
    fixture.listCloudAgentRootSessions.mockResolvedValue(rootPage([]));
    const reader = globalReader(fixture.facade, fixture.openNativeTail);
    try {
      await vi.runOnlyPendingTimersAsync();
      await expectGlobalConnected(reader);
      expect(fixture.openNativeTail).not.toHaveBeenCalled();
      fixture.listCloudAgentRootSessions.mockResolvedValue(rootPage([rootSummary()]));
      await vi.advanceTimersByTimeAsync(10_000);
      await Promise.all(fixture.waitUntil.mock.calls.map(([promise]) => promise));
      expect(fixture.openNativeTail.mock.calls.map(([params]) => params.kiloSessionId)).toEqual([
        kiloSessionId,
      ]);
      await reader.cancel();
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes a root tail removed from the owned list and stops its delivery', async () => {
    vi.useFakeTimers();
    const fixture = globalFixture([rootSummary()]);
    const reader = globalReader(fixture.facade, fixture.openNativeTail);
    try {
      await vi.runOnlyPendingTimersAsync();
      await expectGlobalConnected(reader);
      const entries = fixture.sinksFor();
      expect(entries).toHaveLength(1);
      fixture.listCloudAgentRootSessions.mockResolvedValue(rootPage([]));
      await vi.advanceTimersByTimeAsync(10_000);
      await Promise.all(fixture.waitUntil.mock.calls.map(([promise]) => promise));
      expect(entries.every(entry => entry.closed)).toBe(true);
      await reader.cancel();
    } finally {
      vi.useRealTimers();
    }
  });

  it('resnapshots only the root whose tail reports a gap and keeps the global SSE open', async () => {
    const fixture = globalFixture([rootSummary(), rootSummary(siblingKiloSessionId, siblingWorkspaceSessionId)]);
    const reader = globalReader(fixture.facade, fixture.openNativeTail);
    try {
      await expectGlobalConnected(reader);
      fixture.sinksFor()[0]?.sink?.finish('continuity_unproven');
      await expect(readSseFrame(reader)).resolves.toEqual({
        directory: publicCloudAgentDirectory(kiloSessionId),
        payload: {
          type: 'kilo.native.resnapshot',
          properties: { sessionID: kiloSessionId, reason: 'continuity_unproven' },
        },
      });
      expect(fixture.sinksFor()[0]?.closed).toBe(true);
      // The global SSE stays open: the sibling root still delivers on it.
      const siblingRoot = rootSummary(siblingKiloSessionId, siblingWorkspaceSessionId);
      await fixture.push([fixture.event(12, siblingRoot)], siblingRoot);
      await expect(readSseFrame(reader)).resolves.toMatchObject({
        payload: { properties: { sessionID: siblingKiloSessionId, eventId: 12 } },
      });
    } finally {
      await reader.cancel();
    }
  });

  it('keeps two global consumers distinct when one cancels', async () => {
    const fixture = globalFixture([rootSummary(), rootSummary(siblingKiloSessionId, siblingWorkspaceSessionId)]);
    const first = globalReader(fixture.facade, fixture.openNativeTail);
    const second = globalReader(fixture.facade, fixture.openNativeTail);
    try {
      await expectGlobalConnected(first);
      await expectGlobalConnected(second);
      await fixture.push([fixture.event(11)]);
      await expect(readSseFrame(first)).resolves.toMatchObject({
        payload: { properties: { eventId: 11 } },
      });
      await expect(readSseFrame(second)).resolves.toMatchObject({
        payload: { properties: { eventId: 11 } },
      });
      await first.cancel();
      const siblingRoot = rootSummary(siblingKiloSessionId, siblingWorkspaceSessionId);
      await fixture.push([fixture.event(12, siblingRoot)], siblingRoot);
      await expect(readSseFrame(second)).resolves.toMatchObject({
        payload: { properties: { sessionID: siblingKiloSessionId, eventId: 12 } },
      });
      expect(fixture.sinksFor(siblingRoot).some(entry => !entry.closed)).toBe(true);
      await second.cancel();
    } finally {
      await first.cancel();
      await second.cancel();
    }
  });
});

describe('hosted native routes', () => {
  const workspaceSession = 'workspace_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  function hostedDeps(overrides: Record<string, unknown> = {}) {
    return {
      resolveRootSessionForKiloSession: vi.fn(async () => ({
        cloudAgentSessionId: workspaceSession,
      })),
      decideSessionRoute: vi.fn(() => ({ kind: 'native-session' }) as never),
      ...overrides,
    };
  }

  it('maps a stopped hosted root to the live-runtime-unavailable error before opening SSE', async () => {
    const openPublicSessionEventStream = vi.fn();
    const response = await handleKiloFacadeRequest({
      request: new Request(
        `http://worker.test/kilo/event?directory=${encodeURIComponent(publicCloudAgentDirectory(kiloSessionId))}`
      ),
      env: envStub(),
      userId: 'usr_1',
      deps: hostedDeps({
        openNativeTail: vi.fn(async () => ({ kind: 'stopped' as const })),
        globalEvents: { openPublicGlobalEventStream: vi.fn(), openPublicSessionEventStream },
      }),
    });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: 'KILO_LIVE_RUNTIME_UNAVAILABLE',
    });
    expect(openPublicSessionEventStream).not.toHaveBeenCalled();
  });

  it('maps an unavailable native tail to a retryable 503 before opening SSE', async () => {
    const openPublicSessionEventStream = vi.fn();
    const response = await handleKiloFacadeRequest({
      request: new Request(
        `http://worker.test/kilo/event?directory=${encodeURIComponent(publicCloudAgentDirectory(kiloSessionId))}`
      ),
      env: envStub(),
      userId: 'usr_1',
      deps: hostedDeps({
        openNativeTail: vi.fn(async () => ({
          kind: 'unavailable' as const,
          code: 'KILO_SESSION_READ_RETRYABLE',
          message: 'Native event stream is unavailable',
        })),
        globalEvents: { openPublicGlobalEventStream: vi.fn(), openPublicSessionEventStream },
      }),
    });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: 'KILO_SESSION_READ_RETRYABLE' });
    expect(openPublicSessionEventStream).not.toHaveBeenCalled();
  });

  it('streams tail frames in order and closes the response when the tail finishes', async () => {
    const env = envStub();
    const facade = new UserKiloFacade({ waitUntil: vi.fn() } as unknown as DurableObjectState, env);
    const reader = facade
      .openPublicSessionEventStream(kiloSessionId, {
        tail: nativeTailDouble({
          run: async sink => {
            await sink.send({ type: 'message.updated', properties: { sessionID: kiloSessionId } });
            await sink.send({ type: 'kilo.native.fence', properties: { snapshotComplete: true } });
            sink.finish(undefined);
          },
        }),
      })
      .body!.getReader();
    await reader.read();
    await expect(readSseFrame(reader)).resolves.toMatchObject({ type: 'message.updated' });
    await expect(readSseFrame(reader)).resolves.toMatchObject({ type: 'kilo.native.fence' });
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
  });

  it('emits a continuity resnapshot and closes when the tail reports a gap', async () => {
    const env = envStub();
    const facade = new UserKiloFacade({ waitUntil: vi.fn() } as unknown as DurableObjectState, env);
    const reader = facade
      .openPublicSessionEventStream(kiloSessionId, {
        tail: nativeTailDouble({
          run: async sink => {
            await sink.send({ type: 'message.updated', properties: { sessionID: kiloSessionId } });
            sink.finish('continuity_unproven');
          },
        }),
      })
      .body!.getReader();
    await reader.read();
    await expect(readSseFrame(reader)).resolves.toMatchObject({ type: 'message.updated' });
    await expect(readSseFrame(reader)).resolves.toMatchObject({
      type: 'kilo.native.resnapshot',
      properties: { reason: 'continuity_unproven' },
    });
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
  });

  it('keeps the response open after a snapshot_too_large resnapshot', async () => {
    vi.useFakeTimers();
    const env = envStub();
    const facade = new UserKiloFacade({ waitUntil: vi.fn() } as unknown as DurableObjectState, env);
    const reader = facade
      .openPublicSessionEventStream(kiloSessionId, {
        tail: nativeTailDouble({ run: async sink => sink.finish('snapshot_too_large') }),
      })
      .body!.getReader();
    try {
      await reader.read();
      await expect(readSseFrame(reader)).resolves.toMatchObject({
        type: 'kilo.native.resnapshot',
        properties: { reason: 'snapshot_too_large' },
      });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await readSseTextFrame(reader)).toBe(': heartbeat\n\n');
    } finally {
      await reader.cancel();
      vi.useRealTimers();
    }
  });

  it('reads a hosted session status through the Session DO without waking compute', async () => {
    const nativeLiveRead = vi.fn(async () => ({
      ok: true as const,
      result: { [kiloSessionId]: { type: 'busy', directory: '/workspace/private' } },
    }));
    const response = await handleKiloFacadeRequest({
      request: new Request(
        `http://worker.test/kilo/session/status?directory=${encodeURIComponent(publicCloudAgentDirectory(kiloSessionId))}`
      ),
      env: envStub(),
      userId: 'usr_1',
      deps: hostedDeps({ nativeLiveRead }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ [kiloSessionId]: { type: 'busy' } });
    expect(nativeLiveRead).toHaveBeenCalledWith({
      env: expect.anything(),
      userId: 'usr_1',
      cloudAgentSessionId: workspaceSession,
      operation: { name: 'session.status' },
    });
    const sandboxGet = vi.fn();
    expect(sandboxGet).not.toHaveBeenCalled();
  });

  it('requires the hosted directory selector for collection reads', async () => {
    const nativeLiveRead = vi.fn();
    const response = await handleKiloFacadeRequest({
      request: new Request('http://worker.test/kilo/question'),
      env: envStub(),
      userId: 'usr_1',
      deps: hostedDeps({ nativeLiveRead }),
    });
    expect(response.status).toBe(400);
    expect(nativeLiveRead).not.toHaveBeenCalled();
  });

  it('rejects a collection selector that names no hosted session', async () => {
    const response = await handleKiloFacadeRequest({
      request: new Request(
        'http://worker.test/kilo/permission?directory=%2Fcloud-agent%2Fsessions%2Fnot-a-session'
      ),
      env: envStub(),
      userId: 'usr_1',
      deps: hostedDeps(),
    });
    expect(response.status).toBe(404);
  });

  it('reports a stopped hosted runtime as unavailable rather than starting it', async () => {
    const response = await handleKiloFacadeRequest({
      request: new Request(`http://worker.test/kilo/session/${kiloSessionId}/todo`),
      env: envStub(),
      userId: 'usr_1',
      deps: hostedDeps({
        nativeLiveRead: vi.fn(async () => ({
          ok: false as const,
          error: { code: 'not_ready', message: 'Live runtime is not ready', retryable: true },
        })),
      }),
    });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: 'KILO_LIVE_RUNTIME_UNAVAILABLE',
    });
  });

  it('answers a hosted question through the Session DO, which owns the route identity', async () => {
    const answer = vi.fn(async () => 'delivered' as const);
    const env = envStub();
    const sandboxGet = vi.fn(() => ({ answer }));
    vi.mocked(env.SANDBOX_SESSION).get = sandboxGet as never;
    const response = await handleKiloFacadeRequest({
      request: new Request(
        `http://worker.test/kilo/question/que_1/reply?directory=${encodeURIComponent(publicCloudAgentDirectory(kiloSessionId))}`,
        { method: 'POST', body: JSON.stringify({ answers: [['yes']] }) }
      ),
      env,
      userId: 'usr_1',
      deps: hostedDeps(),
    });
    expect(response.status).toBe(200);
    expect(answer).toHaveBeenCalledWith({
      sessionId: workspaceSession,
      reply: { action: 'answer', questionId: 'que_1', answers: [['yes']] },
    });
  });

  it('rejects an interaction the session does not wait on', async () => {
    const env = envStub();
    const sandboxGet = vi.fn(() => ({ answer: vi.fn(async () => 'not_connected' as const) }));
    vi.mocked(env.SANDBOX_SESSION).get = sandboxGet as never;
    const response = await handleKiloFacadeRequest({
      request: new Request(
        `http://worker.test/kilo/permission/per_stale/reply?directory=${encodeURIComponent(publicCloudAgentDirectory(kiloSessionId))}`,
        { method: 'POST', body: JSON.stringify({ reply: 'once' }) }
      ),
      env,
      userId: 'usr_1',
      deps: hostedDeps(),
    });
    expect(response.status).toBe(409);
  });

  it.each([{ mode: 'code', model: 'anthropic/test' }, { model: 'anthropic/test' }])(
    'forwards command overrides %j through durable admission',
    async agent => {
      const admitPrompt = vi.fn(async (_params: unknown) => ({
        success: true as const,
        outcome: 'queued' as const,
        compatibilityDelivery: 'queued' as const,
        messageId: 'msg_1',
      }));
      const response = await handleKiloFacadeRequest({
        request: new Request(`http://worker.test/kilo/session/${kiloSessionId}/command`, {
          method: 'POST',
          body: JSON.stringify({
            messageID: 'msg_1',
            command: 'commit',
            arguments: '-m done',
            agent: 'mode' in agent ? agent.mode : undefined,
            model: agent.model,
          }),
        }),
        env: envStub(),
        userId: 'usr_1',
        authToken: 'token',
        deps: hostedDeps({ admitPrompt }),
      });
      expect(response.status).toBe(204);
      expect(admitPrompt).toHaveBeenCalledWith(
        expect.objectContaining({
          cloudAgentSessionId: workspaceSession,
          request: expect.objectContaining({
            agent,
            turn: { type: 'command', id: 'msg_1', command: 'commit', arguments: '-m done' },
          }),
        })
      );
    }
  );

  it('refuses a balance bypass on the native command route', async () => {
    const response = await handleKiloFacadeRequest({
      request: new Request(`http://worker.test/kilo/session/${kiloSessionId}/command`, {
        method: 'POST',
        headers: { 'x-skip-balance-check': '1' },
        body: JSON.stringify({ command: 'commit' }),
      }),
      env: envStub(),
      userId: 'usr_1',
      authToken: 'token',
      deps: hostedDeps(),
    });
    expect([400, 204]).toContain(response.status);
  });
});
