import {
  type CloudAgentRootSessionSummary,
  encodeKiloSdkMessagesCursor,
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
  isSyntheticGlobalEvent,
  publicCloudAgentDirectory,
  rewriteGlobalEventDirectory,
  UserKiloFacade,
  type NativeAttachOutcome,
} from './user-kilo-facade';
import type { LiveWrapperResolution, SessionKiloFacadeDecision } from './session-proxy';
import type { NativeEventDelivery, NativeEventSubscription } from './native-event-source.js';

const fixtureContinuity = { generation: 1, sequence: 0 };

function nativePublisher(facade: UserKiloFacade) {
  const sequences = new Map<string, number>();
  return (delivery: NativeEventDelivery & { kiloUserId: string }) => {
    const sequence = (sequences.get(delivery.cloudAgentSessionId) ?? 0) + 1;
    sequences.set(delivery.cloudAgentSessionId, sequence);
    return facade.publishNativeEventBatch({
      kiloUserId: delivery.kiloUserId,
      cloudAgentSessionId: delivery.cloudAgentSessionId,
      kiloSessionId: delivery.kiloSessionId,
      kind: 'events',
      generation: 1,
      firstSequence: sequence,
      deadlineAt: Date.now() + 2_000,
      events: [
        { eventId: delivery.eventId, materialized: delivery.materialized, event: delivery.event },
      ],
    });
  };
}

const kiloSessionId = 'ses_12345678901234567890123456';
const siblingKiloSessionId = 'ses_abcdefghijklmnopqrstuvwxyz';
const groupedOwnerId = 'oauth/google:1234';
const groupedOrganizationId = '11111111-1111-4111-8111-111111111111';
const groupedWorktreeId = 'worktree_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const firstWorkspaceSessionId = 'workspace_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const siblingWorkspaceSessionId = 'workspace_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

type ContainerFetch = (request: Request, port: number) => Promise<Response>;
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
    CLOUD_AGENT_SESSION: {
      idFromName: vi.fn(() => 'session-do-id'),
      get: vi.fn(() => ({
        hasMessageAdmission: vi.fn().mockResolvedValue(false),
        admitSubmittedMessage: vi.fn(),
        interruptExecution: vi.fn(),
      })),
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

function liveWrapperTarget(containerFetch: ContainerFetch): LiveWrapperResolution {
  return {
    kind: 'available',
    target: {
      port: 5123,
      sandbox: { containerFetch } as unknown as Extract<
        LiveWrapperResolution,
        { kind: 'available' }
      >['target']['sandbox'],
    },
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
    expect(openPublicGlobalEventStream).toHaveBeenCalledWith('usr_1');
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
        resolveLiveWrapper: vi.fn(
          async (): Promise<LiveWrapperResolution> => ({
            kind: 'unavailable',
          })
        ),
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(projectedSdkSessionInfo(kiloSessionId));
    expect(getCloudAgentRootSessionSnapshot).toHaveBeenCalledWith({
      kiloUserId: 'usr_1',
      kiloSessionId,
    });
  });

  it('returns a billing rejection instead of reading a persisted detail snapshot', async () => {
    const env = envStub();
    const getCloudAgentRootSessionSnapshot = vi.mocked(
      env.SESSION_INGEST.getCloudAgentRootSessionSnapshot
    );

    const response = await handleKiloFacadeRequest({
      request: new Request(`http://worker.test/kilo/session/${kiloSessionId}`),
      env,
      userId: 'usr_1',
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: 'agent_billing_blocked',
        })),
        resolveLiveWrapper: vi.fn(
          async (): Promise<LiveWrapperResolution> => ({
            kind: 'billing-rejected',
            admission: {
              success: false,
              code: 'insufficient_credits',
              message: 'internal admission detail',
              remainingMicrodollars: 1,
              minimumRequiredMicrodollars: 5,
            },
          })
        ),
      },
    });

    expect(response.status).toBe(402);
    await expect(response.json()).resolves.toEqual({
      error: 'KILO_BILLING_PAYMENT_REQUIRED',
      message: 'Container billing requires additional credits',
      remainingMicrodollars: 1,
      minimumRequiredMicrodollars: 5,
    });
    expect(getCloudAgentRootSessionSnapshot).not.toHaveBeenCalled();
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
    const resolveLiveWrapper = vi.fn();

    const firstResponse = await handleKiloFacadeRequest({
      request: new Request(`http://worker.test/kilo/session/${kiloSessionId}`),
      env,
      userId: groupedOwnerId,
      deps: { resolveRootSessionForKiloSession, resolveLiveWrapper },
    });
    const siblingResponse = await handleKiloFacadeRequest({
      request: new Request(`http://worker.test/kilo/session/${siblingKiloSessionId}`),
      env,
      userId: groupedOwnerId,
      deps: { resolveRootSessionForKiloSession, resolveLiveWrapper },
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
    expect(resolveLiveWrapper).not.toHaveBeenCalled();
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
    const resolveLiveWrapper = vi.fn(async () => null);

    const response = await handleKiloFacadeRequest({
      request: new Request(`http://worker.test/kilo/session/${kiloSessionId}`),
      env,
      userId: groupedOwnerId,
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: firstWorkspaceSessionId,
        })),
        resolveLiveWrapper,
      },
    });

    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('1');
    await expect(response.json()).resolves.toMatchObject({
      error: 'KILO_SESSION_SNAPSHOT_PENDING',
    });
    expect(resolveLiveWrapper).toHaveBeenCalledOnce();
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
    const resolveLiveWrapper = vi.fn();

    const response = await handleKiloFacadeRequest({
      request: new Request(`http://worker.test/kilo/session/${kiloSessionId}`),
      env,
      userId: groupedOwnerId,
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: firstWorkspaceSessionId,
        })),
        resolveLiveWrapper,
      },
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: 'KILO_SESSION_NOT_FOUND' });
    expect(resolveLiveWrapper).not.toHaveBeenCalled();
  });

  it('denies a foreign grouped root before reading its snapshot or ownership', async () => {
    const env = envStub();
    vi.mocked(env.SESSION_INGEST.resolveCloudAgentRootSessionForKiloSession).mockResolvedValue(
      null
    );
    const resolveLiveWrapper = vi.fn();

    const response = await handleKiloFacadeRequest({
      request: new Request(`http://worker.test/kilo/session/${kiloSessionId}`),
      env,
      userId: 'oauth/google:foreign-owner',
      deps: { resolveLiveWrapper },
    });

    expect(response.status).toBe(404);
    expect(env.SESSION_INGEST.getCloudAgentRootSessionSnapshot).not.toHaveBeenCalled();
    expect(getPgDbMock).not.toHaveBeenCalled();
    expect(resolveLiveWrapper).not.toHaveBeenCalled();
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
        resolveLiveWrapper: vi.fn(),
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
    const resolveLiveWrapper = vi.fn();

    const response = await handleKiloFacadeRequest({
      request: new Request(`http://worker.test/kilo/session/${kiloSessionId}`),
      env,
      userId: groupedOwnerId,
      deps: {
        resolveRootSessionForKiloSession: vi.fn(async () => ({
          cloudAgentSessionId: firstWorkspaceSessionId,
        })),
        resolveLiveWrapper,
      },
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: 'KILO_UPSTREAM_RESPONSE_INVALID',
    });
    expect(resolveLiveWrapper).not.toHaveBeenCalled();
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
    expect(getPgDbMock).not.toHaveBeenCalled();
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

  it('projects private structured paths and preserves file text in live messages', async () => {
    const containerFetch = vi.fn<ContainerFetch>(async () =>
      Response.json(sdkMessageHistoryWithPrivateStructuredPaths())
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
    expectPublicStructuredMessagePaths((await response.json()) as KiloSdkStoredMessage[]);
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

  it('projects private structured paths and preserves file text in cold messages', async () => {
    const env = envStub();
    const history = sdkMessageHistoryWithPrivateStructuredPaths();
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

describe('hosted global native events', () => {
  function rootSummary(
    id = kiloSessionId,
    cloudAgentSessionId = firstWorkspaceSessionId
  ): CloudAgentRootSessionSummary {
    return {
      kiloSessionId: id,
      cloudAgentSessionId,
      title: 'Owned root',
      created: 100,
      updated: 200,
    };
  }

  function globalFixture(roots = [rootSummary()]) {
    const env = envStub();
    const listCloudAgentRootSessions = vi.mocked(env.SESSION_INGEST.listCloudAgentRootSessions);
    listCloudAgentRootSessions.mockResolvedValue(roots);
    const resolveRoot = vi.mocked(env.SESSION_INGEST.resolveCloudAgentRootSessionForKiloSession);
    resolveRoot.mockImplementation(async ({ kiloUserId, kiloSessionId: requestedId }) => {
      if (kiloUserId !== groupedOwnerId) return null;
      const root = roots.find(item => item.kiloSessionId === requestedId);
      return root ? { cloudAgentSessionId: root.cloudAgentSessionId } : null;
    });
    const subscribeNativeEvents = vi.fn(
      async ({
        kiloSessionId: requestedId,
      }: {
        kiloSessionId: string;
        attachmentId: string;
      }): Promise<NativeEventSubscription> => ({
        registered: true,
        fence: 10,
        kiloSessionId: requestedId,
        continuity: fixtureContinuity,
      })
    );
    const releaseNativeEvents = vi.fn(async (_input: { attachmentId: string }) => undefined);
    const nativeSnapshot = vi.fn();
    const refreshNativeEvents = vi.fn(
      async (_input: { kiloSessionId: string; attachmentId: string; generation: number }) => true
    );
    const nativeLiveRead = vi.fn();
    const kiloRequest = vi.fn();
    const send = vi.fn();
    const sandboxIdFromName = vi.fn().mockReturnValue('sandbox-session-do-id');
    env.SANDBOX_SESSION.idFromName = sandboxIdFromName;
    const legacyGet = vi.fn();
    env.CLOUD_AGENT_SESSION.get = legacyGet;
    env.SANDBOX_SESSION.get = vi.fn().mockReturnValue({
      subscribeNativeEvents,
      releaseNativeEvents,
      refreshNativeEvents,
      nativeSnapshot,
      nativeLiveRead,
      kiloRequest,
      send,
    });
    const waitUntil = vi.fn<(promise: Promise<unknown>) => void>();
    const facade = new UserKiloFacade({ waitUntil } as unknown as DurableObjectState, env);
    const publish = nativePublisher(facade);
    const push = (eventId: number, root = roots[0], materialized = false) => {
      if (!root) throw new Error('Expected native root fixture');
      return publish({
        kiloUserId: groupedOwnerId,
        cloudAgentSessionId: root.cloudAgentSessionId,
        kiloSessionId: root.kiloSessionId,
        eventId,
        materialized,
        event: { type: 'message.updated', properties: { sessionID: root.kiloSessionId, eventId } },
      });
    };
    return {
      env,
      facade,
      listCloudAgentRootSessions,
      resolveRoot,
      subscribeNativeEvents,
      releaseNativeEvents,
      nativeSnapshot,
      nativeLiveRead,
      kiloRequest,
      send,
      sandboxIdFromName,
      legacyGet,
      waitUntil,
      push,
      refreshNativeEvents,
    };
  }

  function globalReader(facade: UserKiloFacade) {
    const response = facade.openPublicGlobalEventStream(groupedOwnerId);
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

  it('subscribes only listed owned control roots at limit 100 without reading or waking compute', async () => {
    const fixture = globalFixture([
      rootSummary(),
      rootSummary(siblingKiloSessionId, siblingWorkspaceSessionId),
      rootSummary('ses_legacy', 'agent_legacy'),
    ]);
    const scopedStream = vi.spyOn(fixture.facade, 'openPublicSessionEventStream');
    const reader = globalReader(fixture.facade);
    try {
      await expectGlobalConnected(reader);
      expect(fixture.listCloudAgentRootSessions).toHaveBeenCalledExactlyOnceWith({
        kiloUserId: groupedOwnerId,
        limit: 100,
      });
      expect(fixture.subscribeNativeEvents).toHaveBeenCalledTimes(2);
      expect(
        fixture.subscribeNativeEvents.mock.calls.map(([input]) => input.kiloSessionId)
      ).toEqual([kiloSessionId, siblingKiloSessionId]);
      expect(fixture.sandboxIdFromName).toHaveBeenNthCalledWith(
        1,
        `${groupedOwnerId}:${firstWorkspaceSessionId}`
      );
      expect(fixture.sandboxIdFromName).toHaveBeenNthCalledWith(
        2,
        `${groupedOwnerId}:${siblingWorkspaceSessionId}`
      );
      expect(fixture.resolveRoot).not.toHaveBeenCalled();
      expect(fixture.env.SESSION_INGEST.getCloudAgentRootSessionSnapshot).not.toHaveBeenCalled();
      expect(fixture.env.SESSION_INGEST.getCloudAgentRootSessionMessages).not.toHaveBeenCalled();
      expect(fixture.legacyGet).not.toHaveBeenCalled();
      expect(fixture.nativeSnapshot).not.toHaveBeenCalled();
      expect(fixture.nativeLiveRead).not.toHaveBeenCalled();
      expect(fixture.kiloRequest).not.toHaveBeenCalled();
      expect(fixture.send).not.toHaveBeenCalled();
      expect(scopedStream).not.toHaveBeenCalled();
    } finally {
      await reader.cancel();
      await Promise.all(fixture.waitUntil.mock.calls.map(([promise]) => promise));
    }
    expect(fixture.releaseNativeEvents).toHaveBeenCalledTimes(2);
    expect(fixture.releaseNativeEvents.mock.calls.map(([input]) => input.attachmentId)).toEqual(
      fixture.subscribeNativeEvents.mock.calls.map(([input]) => input.attachmentId)
    );
  });

  it('authorizes a mutable-update batch once and applies an ambiguous retry only once', async () => {
    const fixture = globalFixture();
    const reader = globalReader(fixture.facade);
    try {
      await expectGlobalConnected(reader);
      fixture.resolveRoot.mockClear();
      const batch = {
        kind: 'events' as const,
        kiloUserId: groupedOwnerId,
        cloudAgentSessionId: firstWorkspaceSessionId,
        kiloSessionId,
        generation: 1,
        firstSequence: 1,
        deadlineAt: Date.now() + 2_000,
        events: ['first', 'second', 'third'].map(value => ({
          eventId: 2,
          materialized: true,
          event: { type: 'message.part.updated', properties: { sessionID: kiloSessionId, value } },
        })),
      };
      await fixture.facade.publishNativeEventBatch(batch);
      expect(fixture.resolveRoot).toHaveBeenCalledOnce();
      await fixture.facade.publishNativeEventBatch(batch);
      for (const value of ['first', 'second', 'third'])
        await expect(readSseFrame(reader)).resolves.toMatchObject({
          payload: { properties: { value } },
        });
      await fixture.facade.publishNativeEventBatch({
        ...batch,
        firstSequence: 4,
        events: [
          { eventId: 11, event: { type: 'after', properties: { sessionID: kiloSessionId } } },
        ],
      });
      await expect(readSseFrame(reader)).resolves.toMatchObject({ payload: { type: 'after' } });
    } finally {
      await reader.cancel();
    }
  });

  it('does not apply an expired RPC after ownership lookup returns late', async () => {
    vi.useFakeTimers();
    const fixture = globalFixture();
    const reader = globalReader(fixture.facade);
    try {
      await expectGlobalConnected(reader);
      const ownership = Promise.withResolvers<{ cloudAgentSessionId: string }>();
      fixture.resolveRoot.mockReturnValueOnce(ownership.promise);
      const send = fixture.facade.publishNativeEventBatch({
        kind: 'events',
        kiloUserId: groupedOwnerId,
        cloudAgentSessionId: firstWorkspaceSessionId,
        kiloSessionId,
        generation: 1,
        firstSequence: 1,
        deadlineAt: Date.now() + 2_000,
        events: [
          { eventId: 11, event: { type: 'late', properties: { sessionID: kiloSessionId } } },
        ],
      });
      const rejected = expect(send).rejects.toThrow('deadline');
      await vi.advanceTimersByTimeAsync(2_000);
      ownership.resolve({ cloudAgentSessionId: firstWorkspaceSessionId });
      await rejected;
      await fixture.push(12);
      await expect(readSseFrame(reader)).resolves.toMatchObject({
        payload: { type: 'message.updated', properties: { eventId: 12 } },
      });
    } finally {
      await reader.cancel();
      vi.useRealTimers();
    }
  });

  it('signals eviction or a lost loss-RPC on every affected global and scoped attachment without affecting its sibling', async () => {
    vi.useFakeTimers();
    const fixture = globalFixture([
      rootSummary(),
      rootSummary(siblingKiloSessionId, siblingWorkspaceSessionId),
    ]);
    const global = globalReader(fixture.facade);
    const scopedId = fixture.facade.prepareNativeAttachment(
      firstWorkspaceSessionId,
      kiloSessionId,
      groupedOwnerId
    );
    const scoped = fixture.facade
      .openPublicSessionEventStream(kiloSessionId, {
        attachmentId: scopedId,
        continuity: fixtureContinuity,
        fence: 10,
      })
      .body!.getReader();
    try {
      await expectGlobalConnected(global);
      await readSseFrame(scoped);
      await readSseFrame(scoped);
      fixture.refreshNativeEvents.mockImplementation(
        async input => input.kiloSessionId !== kiloSessionId
      );
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await readSseTextFrame(global)).toBe(': heartbeat\n\n');
      await expect(readSseFrame(global)).resolves.toMatchObject({
        payload: { type: 'kilo.native.resnapshot', properties: { sessionID: kiloSessionId } },
      });
      expect(await readSseTextFrame(scoped)).toBe(': heartbeat\n\n');
      await expect(readSseFrame(scoped)).resolves.toMatchObject({ type: 'kilo.native.resnapshot' });
      await fixture.push(11, rootSummary(siblingKiloSessionId, siblingWorkspaceSessionId));
      await expect(readSseFrame(global)).resolves.toMatchObject({
        payload: { type: 'message.updated', properties: { sessionID: siblingKiloSessionId } },
      });
      await fixture.push(11);
      expect(fixture.releaseNativeEvents).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await readSseTextFrame(global)).toBe(': heartbeat\n\n');
      await expect(scoped.read()).resolves.toEqual({ done: true, value: undefined });
      expect(fixture.subscribeNativeEvents).toHaveBeenCalledTimes(3);
    } finally {
      await global.cancel();
      await scoped.cancel();
      vi.useRealTimers();
    }
  });

  it('retries bounded stalled probes before signaling loss and subscribing again', async () => {
    vi.useFakeTimers();
    const fixture = globalFixture();
    const reader = globalReader(fixture.facade);
    try {
      await expectGlobalConnected(reader);
      fixture.refreshNativeEvents.mockReturnValue(new Promise(() => undefined));
      await vi.advanceTimersByTimeAsync(12_000);
      expect(await readSseTextFrame(reader)).toBe(': heartbeat\n\n');
      expect(fixture.releaseNativeEvents).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await readSseTextFrame(reader)).toBe(': heartbeat\n\n');
      expect(fixture.releaseNativeEvents).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await readSseTextFrame(reader)).toBe(': heartbeat\n\n');
      await expect(readSseFrame(reader)).resolves.toMatchObject({
        payload: { type: 'kilo.native.resnapshot' },
      });
      expect(fixture.refreshNativeEvents).toHaveBeenCalledTimes(3);
      expect(fixture.releaseNativeEvents).toHaveBeenCalledOnce();
      fixture.refreshNativeEvents.mockResolvedValue(true);
      await vi.advanceTimersByTimeAsync(8_000);
      expect(await readSseTextFrame(reader)).toBe(': heartbeat\n\n');
      expect(fixture.subscribeNativeEvents).toHaveBeenCalledTimes(2);
      await fixture.push(11);
      await expect(readSseFrame(reader)).resolves.toMatchObject({
        payload: { type: 'message.updated' },
      });
    } finally {
      await reader.cancel();
      vi.useRealTimers();
    }
  });

  it('keeps scoped live delivery after one failed continuity probe and resets its failure budget', async () => {
    vi.useFakeTimers();
    const fixture = globalFixture();
    const attachmentId = fixture.facade.prepareNativeAttachment(
      firstWorkspaceSessionId,
      kiloSessionId,
      groupedOwnerId
    );
    const reader = fixture.facade
      .openPublicSessionEventStream(kiloSessionId, {
        attachmentId,
        continuity: fixtureContinuity,
        fence: 10,
      })
      .body!.getReader();
    try {
      await readSseFrame(reader);
      await readSseFrame(reader);
      fixture.refreshNativeEvents.mockReturnValueOnce(new Promise(() => undefined));
      await vi.advanceTimersByTimeAsync(12_000);
      expect(await readSseTextFrame(reader)).toBe(': heartbeat\n\n');
      expect(fixture.releaseNativeEvents).not.toHaveBeenCalled();
      await fixture.push(11);
      await expect(readSseFrame(reader)).resolves.toMatchObject({ type: 'message.updated' });
      await vi.advanceTimersByTimeAsync(8_000);
      expect(await readSseTextFrame(reader)).toBe(': heartbeat\n\n');
      fixture.refreshNativeEvents.mockReturnValueOnce(new Promise(() => undefined));
      await vi.advanceTimersByTimeAsync(12_000);
      expect(await readSseTextFrame(reader)).toBe(': heartbeat\n\n');
      expect(fixture.releaseNativeEvents).not.toHaveBeenCalled();
      await fixture.push(12);
      await expect(readSseFrame(reader)).resolves.toMatchObject({ type: 'message.updated' });
    } finally {
      await reader.cancel();
      vi.useRealTimers();
    }
  });

  it('keeps global delivery after a transient continuity RPC rejection', async () => {
    vi.useFakeTimers();
    const fixture = globalFixture();
    const reader = globalReader(fixture.facade);
    try {
      await expectGlobalConnected(reader);
      fixture.refreshNativeEvents.mockRejectedValueOnce(new Error('Transient transport failure'));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await readSseTextFrame(reader)).toBe(': heartbeat\n\n');
      expect(fixture.releaseNativeEvents).not.toHaveBeenCalled();
      await fixture.push(11);
      await expect(readSseFrame(reader)).resolves.toMatchObject({
        payload: { type: 'message.updated' },
      });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await readSseTextFrame(reader)).toBe(': heartbeat\n\n');
      expect(fixture.refreshNativeEvents).toHaveBeenCalledTimes(2);
      expect(fixture.subscribeNativeEvents).toHaveBeenCalledOnce();
      expect(fixture.releaseNativeEvents).not.toHaveBeenCalled();
    } finally {
      await reader.cancel();
      vi.useRealTimers();
    }
  });

  it('does not resume snapshot pages after a loss arrives while their next RPC is pending', async () => {
    const fixture = globalFixture();
    const page = Promise.withResolvers<NativeAttachOutcome>();
    const attachmentId = fixture.facade.prepareNativeAttachment(
      firstWorkspaceSessionId,
      kiloSessionId,
      groupedOwnerId
    );
    const reader = fixture.facade
      .openPublicSessionEventStream(kiloSessionId, {
        attachmentId,
        fence: 10,
        continuity: fixtureContinuity,
        snapshot: [{ type: 'before-loss', properties: {} }],
        nextPage: () => page.promise,
      })
      .body!.getReader();
    try {
      await readSseFrame(reader);
      await expect(readSseFrame(reader)).resolves.toMatchObject({ type: 'before-loss' });
      await fixture.facade.publishNativeEventBatch({
        kind: 'loss',
        kiloUserId: groupedOwnerId,
        cloudAgentSessionId: firstWorkspaceSessionId,
        kiloSessionId,
        generation: 1,
        attachmentIds: [attachmentId],
        deadlineAt: Date.now() + 2_000,
      });
      await expect(readSseFrame(reader)).resolves.toMatchObject({ type: 'kilo.native.resnapshot' });
      page.resolve({
        kind: 'fenced',
        fence: 10,
        snapshot: { oversized: false, fence: 10, events: [] },
        events: [{ type: 'after-loss', properties: {} }],
      });
      await Promise.all(fixture.waitUntil.mock.calls.map(([work]) => work));
      expect(fixture.releaseNativeEvents).toHaveBeenCalledOnce();
      expect(fixture.releaseNativeEvents).toHaveBeenCalledWith({ attachmentId });
      await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
      await reader.cancel();
    } finally {
      await reader.cancel();
    }
  });

  it('releases an attachment lost before snapshot rendering without fetching more pages', async () => {
    const fixture = globalFixture();
    const attachmentId = fixture.facade.prepareNativeAttachment(
      firstWorkspaceSessionId,
      kiloSessionId,
      groupedOwnerId
    );
    await fixture.facade.publishNativeEventBatch({
      kind: 'loss',
      kiloUserId: groupedOwnerId,
      cloudAgentSessionId: firstWorkspaceSessionId,
      kiloSessionId,
      generation: 1,
      attachmentIds: [attachmentId],
      deadlineAt: Date.now() + 2_000,
    });
    const nextPage = vi.fn();
    const reader = fixture.facade
      .openPublicSessionEventStream(kiloSessionId, {
        attachmentId,
        continuity: fixtureContinuity,
        fence: 10,
        snapshot: [{ type: 'must-not-render', properties: {} }],
        nextPage,
      })
      .body!.getReader();
    try {
      await readSseFrame(reader);
      await expect(readSseFrame(reader)).resolves.toMatchObject({ type: 'kilo.native.resnapshot' });
      await Promise.all(fixture.waitUntil.mock.calls.map(([work]) => work));
      expect(nextPage).not.toHaveBeenCalled();
      expect(fixture.releaseNativeEvents).toHaveBeenCalledOnce();
      expect(fixture.releaseNativeEvents).toHaveBeenCalledWith({ attachmentId });
      await reader.cancel();
      expect(fixture.releaseNativeEvents).toHaveBeenCalledOnce();
    } finally {
      await reader.cancel();
    }
  });

  it('wakes a backpressured snapshot writer when its attachment is lost', async () => {
    vi.useFakeTimers();
    const fixture = globalFixture();
    const attachmentId = fixture.facade.prepareNativeAttachment(
      firstWorkspaceSessionId,
      kiloSessionId,
      groupedOwnerId
    );
    const reader = fixture.facade
      .openPublicSessionEventStream(kiloSessionId, {
        attachmentId,
        fence: 10,
        continuity: fixtureContinuity,
        snapshot: Array.from({ length: 70 }, (_, index) => ({
          type: 'snapshot.row',
          properties: { index },
        })),
      })
      .body!.getReader();
    try {
      await vi.advanceTimersByTimeAsync(0);
      await fixture.facade.publishNativeEventBatch({
        kind: 'loss',
        kiloUserId: groupedOwnerId,
        cloudAgentSessionId: firstWorkspaceSessionId,
        kiloSessionId,
        generation: 1,
        attachmentIds: [attachmentId],
        deadlineAt: Date.now() + 2_000,
      });
      await expect(reader.read()).rejects.toThrow('fell behind');
      await expect(
        Promise.all(fixture.waitUntil.mock.calls.map(([work]) => work))
      ).resolves.toBeDefined();
      expect(fixture.releaseNativeEvents).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await reader.cancel().catch(() => undefined);
      vi.useRealTimers();
    }
  });

  it('signals revoked ownership without exposing the unauthorized batch', async () => {
    const fixture = globalFixture();
    const reader = globalReader(fixture.facade);
    try {
      await expectGlobalConnected(reader);
      fixture.resolveRoot.mockResolvedValue(null);
      await fixture.push(11);
      await expect(readSseFrame(reader)).resolves.toMatchObject({
        payload: { type: 'kilo.native.resnapshot' },
      });
    } finally {
      await reader.cancel();
    }
  });

  it('disconnects when a full subscriber queue cannot accept the loss notice', async () => {
    const fixture = globalFixture();
    const reader = globalReader(fixture.facade);
    try {
      await expectGlobalConnected(reader);
      for (let index = 0; index < 64; index++) await fixture.push(11 + index);
      const attachmentIds = fixture.subscribeNativeEvents.mock.calls.map(
        ([input]) => input.attachmentId
      );
      await fixture.facade.publishNativeEventBatch({
        kind: 'loss',
        kiloUserId: groupedOwnerId,
        cloudAgentSessionId: firstWorkspaceSessionId,
        kiloSessionId,
        generation: 1,
        attachmentIds,
        deadlineAt: Date.now() + 2_000,
      });
      await expect(reader.read()).rejects.toThrow('fell behind');
      await Promise.all(fixture.waitUntil.mock.calls.map(([work]) => work));
      expect(fixture.releaseNativeEvents).toHaveBeenCalledOnce();
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  });

  it.each([70, 128, 240])(
    'delivers a single %i KiB native event on scoped and global streams',
    async size => {
      const fixture = globalFixture();
      const global = globalReader(fixture.facade);
      const attachmentId = fixture.facade.prepareNativeAttachment(
        firstWorkspaceSessionId,
        kiloSessionId,
        groupedOwnerId
      );
      const scoped = fixture.facade
        .openPublicSessionEventStream(kiloSessionId, {
          attachmentId,
          fence: 10,
          continuity: fixtureContinuity,
        })
        .body!.getReader();
      const publish = nativePublisher(fixture.facade);
      const event = {
        type: 'message.part.updated',
        properties: {
          sessionID: kiloSessionId,
          part: { id: 'prt_large', text: 'x'.repeat(size * 1024) },
        },
      };
      try {
        await expectGlobalConnected(global);
        await readSseFrame(scoped);
        await readSseFrame(scoped);
        await publish({
          kiloUserId: groupedOwnerId,
          cloudAgentSessionId: firstWorkspaceSessionId,
          kiloSessionId,
          eventId: 11,
          materialized: true,
          event,
        });
        await expect(readSseFrame(global)).resolves.toMatchObject({ payload: event });
        await expect(readSseFrame(scoped)).resolves.toEqual(event);
        expect(fixture.releaseNativeEvents).not.toHaveBeenCalled();
      } finally {
        await global.cancel();
        await scoped.cancel();
      }
    }
  );

  it('renders a 240 KiB snapshot event and then completes its fence', async () => {
    const fixture = globalFixture();
    const attachmentId = fixture.facade.prepareNativeAttachment(
      firstWorkspaceSessionId,
      kiloSessionId,
      groupedOwnerId
    );
    const event = { type: 'message.part.updated', properties: { text: 'x'.repeat(240 * 1024) } };
    const reader = fixture.facade
      .openPublicSessionEventStream(kiloSessionId, {
        attachmentId,
        fence: 10,
        continuity: fixtureContinuity,
        snapshot: [event],
      })
      .body!.getReader();
    try {
      await readSseFrame(reader);
      await expect(readSseFrame(reader)).resolves.toEqual(event);
      await expect(readSseFrame(reader)).resolves.toMatchObject({ type: 'kilo.native.fence' });
      expect(fixture.releaseNativeEvents).not.toHaveBeenCalled();
    } finally {
      await reader.cancel();
    }
  });

  it('completes the subscription fence before global connected and drains only uncovered pushes', async () => {
    vi.useFakeTimers();
    const fixture = globalFixture();
    const subscription = Promise.withResolvers<{
      registered: boolean;
      fence: number | null;
      kiloSessionId: string;
      continuity: typeof fixtureContinuity;
    }>();
    fixture.subscribeNativeEvents.mockReturnValueOnce(subscription.promise);
    const reader = globalReader(fixture.facade);
    const firstFrame = vi.fn();
    const pendingFrame = readSseFrame(reader).then(firstFrame);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(fixture.subscribeNativeEvents).toHaveBeenCalledOnce();
      await fixture.push(5);
      await fixture.push(11);
      await fixture.push(2, undefined, true);
      expect(firstFrame).not.toHaveBeenCalled();
      subscription.resolve({
        registered: true,
        fence: 10,
        kiloSessionId,
        continuity: fixtureContinuity,
      });
      await pendingFrame;
      expect(firstFrame).toHaveBeenCalledExactlyOnceWith({
        directory: publicCloudAgentDirectory(kiloSessionId),
        payload: { type: 'message.updated', properties: { sessionID: kiloSessionId, eventId: 11 } },
      });
      await expect(readSseFrame(reader)).resolves.toEqual({
        directory: publicCloudAgentDirectory(kiloSessionId),
        payload: { type: 'message.updated', properties: { sessionID: kiloSessionId, eventId: 2 } },
      });
      await expectGlobalConnected(reader);
      await fixture.push(10);
      await fixture.push(12);
      await expect(readSseFrame(reader)).resolves.toEqual({
        directory: publicCloudAgentDirectory(kiloSessionId),
        payload: { type: 'message.updated', properties: { sessionID: kiloSessionId, eventId: 12 } },
      });
    } finally {
      await reader.cancel();
      await pendingFrame;
      vi.useRealTimers();
    }
  });

  it('fans peer pushes to a global-only stream while rejecting foreign or mismatched roots', async () => {
    const fixture = globalFixture([
      rootSummary(),
      rootSummary(siblingKiloSessionId, siblingWorkspaceSessionId),
    ]);
    const reader = globalReader(fixture.facade);
    try {
      await expectGlobalConnected(reader);
      const denied = {
        kiloUserId: groupedOwnerId,
        cloudAgentSessionId: firstWorkspaceSessionId,
        kiloSessionId,
        eventId: 11,
        event: { type: 'denied', properties: {} },
      };
      const publishDenied = nativePublisher(fixture.facade);
      await publishDenied({ ...denied, kiloUserId: 'foreign-user' });
      await publishDenied({
        ...denied,
        cloudAgentSessionId: siblingWorkspaceSessionId,
      });
      await publishDenied({ ...denied, kiloSessionId: 'ses_unlisted' });
      await fixture.push(11);
      await fixture.push(12, rootSummary(siblingKiloSessionId, siblingWorkspaceSessionId));
      await expect(readSseFrame(reader)).resolves.toEqual({
        directory: publicCloudAgentDirectory(kiloSessionId),
        payload: { type: 'message.updated', properties: { sessionID: kiloSessionId, eventId: 11 } },
      });
      await expect(readSseFrame(reader)).resolves.toEqual({
        directory: publicCloudAgentDirectory(siblingKiloSessionId),
        payload: {
          type: 'message.updated',
          properties: { sessionID: siblingKiloSessionId, eventId: 12 },
        },
      });
      expect(fixture.resolveRoot).toHaveBeenCalledWith({
        kiloUserId: 'foreign-user',
        kiloSessionId,
      });
    } finally {
      await reader.cancel();
    }
  });

  it('refreshes a known root that registers later without snapshot reads or duplicate consumers', async () => {
    vi.useFakeTimers();
    const fixture = globalFixture();
    fixture.subscribeNativeEvents
      .mockResolvedValueOnce({
        registered: false,
        fence: null,
        kiloSessionId,
        continuity: fixtureContinuity,
      })
      .mockResolvedValue({
        registered: true,
        fence: null,
        kiloSessionId,
        continuity: fixtureContinuity,
      });
    const reader = globalReader(fixture.facade);
    try {
      await expectGlobalConnected(reader);
      await Promise.all(fixture.waitUntil.mock.calls.map(([promise]) => promise));
      expect(fixture.releaseNativeEvents).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await readSseTextFrame(reader)).toBe(': heartbeat\n\n');
      expect(fixture.subscribeNativeEvents).toHaveBeenCalledTimes(2);
      await fixture.push(1);
      await expect(readSseFrame(reader)).resolves.toEqual({
        directory: publicCloudAgentDirectory(kiloSessionId),
        payload: { type: 'message.updated', properties: { sessionID: kiloSessionId, eventId: 1 } },
      });
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await readSseTextFrame(reader)).toBe(': heartbeat\n\n');
      expect(await readSseTextFrame(reader)).toBe(': heartbeat\n\n');
      expect(fixture.listCloudAgentRootSessions).toHaveBeenCalledTimes(4);
      expect(fixture.subscribeNativeEvents).toHaveBeenCalledTimes(2);
      expect(fixture.nativeSnapshot).not.toHaveBeenCalled();
      expect(fixture.kiloRequest).not.toHaveBeenCalled();
      expect(fixture.send).not.toHaveBeenCalled();
    } finally {
      await reader.cancel();
      await Promise.all(fixture.waitUntil.mock.calls.map(([promise]) => promise));
      vi.useRealTimers();
    }
    const attachmentIds = fixture.subscribeNativeEvents.mock.calls.map(
      ([input]) => input.attachmentId
    );
    expect(new Set(attachmentIds).size).toBe(2);
    expect(fixture.releaseNativeEvents.mock.calls.map(([input]) => input.attachmentId)).toEqual(
      attachmentIds
    );
  });

  it('discovers roots added after global connection on the next heartbeat', async () => {
    vi.useFakeTimers();
    const fixture = globalFixture();
    fixture.listCloudAgentRootSessions.mockResolvedValueOnce([]);
    const reader = globalReader(fixture.facade);
    try {
      await expectGlobalConnected(reader);
      expect(fixture.subscribeNativeEvents).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await readSseTextFrame(reader)).toBe(': heartbeat\n\n');
      expect(fixture.subscribeNativeEvents).toHaveBeenCalledOnce();
      await fixture.push(11);
      await expect(readSseFrame(reader)).resolves.toMatchObject({
        directory: publicCloudAgentDirectory(kiloSessionId),
        payload: { type: 'message.updated', properties: { eventId: 11 } },
      });
      expect(fixture.listCloudAgentRootSessions.mock.calls).toEqual([
        [{ kiloUserId: groupedOwnerId, limit: 100 }],
        [{ kiloUserId: groupedOwnerId, limit: 100 }],
      ]);
    } finally {
      await reader.cancel();
      vi.useRealTimers();
    }
  });

  it('keeps an empty registered root subscribed when its native runtime starts later', async () => {
    vi.useFakeTimers();
    const fixture = globalFixture();
    fixture.subscribeNativeEvents.mockResolvedValue({
      registered: true,
      fence: null,
      kiloSessionId,
      continuity: fixtureContinuity,
    });
    const reader = globalReader(fixture.facade);
    try {
      await expectGlobalConnected(reader);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await readSseTextFrame(reader)).toBe(': heartbeat\n\n');
      expect(fixture.subscribeNativeEvents).toHaveBeenCalledOnce();
      await fixture.push(1);
      await expect(readSseFrame(reader)).resolves.toEqual({
        directory: publicCloudAgentDirectory(kiloSessionId),
        payload: { type: 'message.updated', properties: { sessionID: kiloSessionId, eventId: 1 } },
      });
      expect(fixture.nativeSnapshot).not.toHaveBeenCalled();
      expect(fixture.nativeLiveRead).not.toHaveBeenCalled();
      expect(fixture.kiloRequest).not.toHaveBeenCalled();
      expect(fixture.send).not.toHaveBeenCalled();
    } finally {
      await reader.cancel();
      vi.useRealTimers();
    }
  });

  it('releases a root removed from the owned list and stops its global delivery', async () => {
    vi.useFakeTimers();
    const fixture = globalFixture();
    const reader = globalReader(fixture.facade);
    try {
      await expectGlobalConnected(reader);
      const attachment = fixture.subscribeNativeEvents.mock.calls[0]?.[0];
      expect(attachment).toBeDefined();
      fixture.listCloudAgentRootSessions.mockResolvedValue([]);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await readSseTextFrame(reader)).toBe(': heartbeat\n\n');
      await Promise.all(fixture.waitUntil.mock.calls.map(([promise]) => promise));
      expect(fixture.releaseNativeEvents).toHaveBeenCalledExactlyOnceWith({
        attachmentId: attachment?.attachmentId,
      });
      await fixture.push(11);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await readSseTextFrame(reader)).toBe(': heartbeat\n\n');
      expect(fixture.subscribeNativeEvents).toHaveBeenCalledOnce();
    } finally {
      await reader.cancel();
      vi.useRealTimers();
    }
    expect(fixture.releaseNativeEvents).toHaveBeenCalledOnce();
  });

  it('keeps global and scoped consumers distinct when either subscriber cancels', async () => {
    const fixture = globalFixture();
    const first = globalReader(fixture.facade);
    const second = globalReader(fixture.facade);
    const scopedId = fixture.facade.prepareNativeAttachment(
      firstWorkspaceSessionId,
      kiloSessionId,
      groupedOwnerId
    );
    const scopedBody = fixture.facade.openPublicSessionEventStream(kiloSessionId, {
      attachmentId: scopedId,
      fence: 10,
      continuity: fixtureContinuity,
    }).body;
    if (!scopedBody) throw new Error('Expected scoped native event response body');
    const scoped = scopedBody.getReader();
    try {
      await expectGlobalConnected(first);
      await expectGlobalConnected(second);
      await readSseFrame(scoped);
      await expect(readSseFrame(scoped)).resolves.toMatchObject({ type: 'kilo.native.fence' });
      const [firstInput, secondInput] = fixture.subscribeNativeEvents.mock.calls.map(
        ([input]) => input
      );
      expect(firstInput).toBeDefined();
      expect(secondInput).toBeDefined();
      expect(new Set([firstInput?.attachmentId, secondInput?.attachmentId, scopedId]).size).toBe(3);
      await first.cancel();
      await Promise.all(fixture.waitUntil.mock.calls.map(([promise]) => promise));
      expect(fixture.releaseNativeEvents).toHaveBeenCalledExactlyOnceWith({
        attachmentId: firstInput?.attachmentId,
      });
      await fixture.push(11);
      await expect(readSseFrame(second)).resolves.toMatchObject({
        directory: publicCloudAgentDirectory(kiloSessionId),
        payload: { properties: { eventId: 11 } },
      });
      await expect(readSseFrame(scoped)).resolves.toEqual({
        type: 'message.updated',
        properties: { sessionID: kiloSessionId, eventId: 11 },
      });
      await scoped.cancel();
      await Promise.all(fixture.waitUntil.mock.calls.map(([promise]) => promise));
      expect(fixture.releaseNativeEvents).toHaveBeenLastCalledWith({ attachmentId: scopedId });
      await fixture.push(12);
      await expect(readSseFrame(second)).resolves.toMatchObject({
        payload: { properties: { eventId: 12 } },
      });
      await second.cancel();
      await Promise.all(fixture.waitUntil.mock.calls.map(([promise]) => promise));
      expect(fixture.releaseNativeEvents).toHaveBeenLastCalledWith({
        attachmentId: secondInput?.attachmentId,
      });
      expect(fixture.releaseNativeEvents).toHaveBeenCalledTimes(3);
    } finally {
      await first.cancel();
      await second.cancel();
      await scoped.cancel();
    }
  });

  it('releases a late DO registration after cancellation during a pending subscribe', async () => {
    vi.useFakeTimers();
    const fixture = globalFixture();
    const subscription = Promise.withResolvers<void>();
    const consumers = new Set<string>();
    fixture.subscribeNativeEvents.mockImplementation(async input => {
      await subscription.promise;
      consumers.add(input.attachmentId);
      return {
        registered: true,
        fence: 10,
        kiloSessionId: input.kiloSessionId,
        continuity: fixtureContinuity,
      };
    });
    fixture.releaseNativeEvents.mockImplementation(async input => {
      consumers.delete(input.attachmentId);
    });
    const reader = globalReader(fixture.facade);
    try {
      await vi.advanceTimersByTimeAsync(0);
      const attachment = fixture.subscribeNativeEvents.mock.calls[0]?.[0];
      expect(attachment).toBeDefined();
      await reader.cancel();
      expect(fixture.releaseNativeEvents).toHaveBeenCalledExactlyOnceWith({
        attachmentId: attachment?.attachmentId,
      });
      subscription.resolve();
      await vi.advanceTimersByTimeAsync(0);
      await Promise.all(fixture.waitUntil.mock.calls.map(([promise]) => promise));
      expect(consumers.size).toBe(0);
      expect(fixture.releaseNativeEvents).toHaveBeenCalledTimes(2);
      expect(fixture.releaseNativeEvents).toHaveBeenLastCalledWith({
        attachmentId: attachment?.attachmentId,
      });
      await fixture.push(11);
      await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(fixture.listCloudAgentRootSessions).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      subscription.resolve();
      await reader.cancel();
      vi.useRealTimers();
    }
  });

  it('handles a failed late release after cancellation during a pending subscribe', async () => {
    vi.useFakeTimers();
    const fixture = globalFixture();
    const subscription = Promise.withResolvers<void>();
    fixture.subscribeNativeEvents.mockImplementation(async input => {
      await subscription.promise;
      return {
        registered: true,
        fence: 10,
        kiloSessionId: input.kiloSessionId,
        continuity: fixtureContinuity,
      };
    });
    fixture.releaseNativeEvents
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('Release unavailable'));
    const reader = globalReader(fixture.facade);
    try {
      await vi.advanceTimersByTimeAsync(0);
      const attachment = fixture.subscribeNativeEvents.mock.calls[0]?.[0];
      expect(attachment).toBeDefined();
      await reader.cancel();
      subscription.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(fixture.releaseNativeEvents).toHaveBeenCalledTimes(2);
      expect(fixture.releaseNativeEvents).toHaveBeenLastCalledWith({
        attachmentId: attachment?.attachmentId,
      });
      await expect(
        Promise.all(fixture.waitUntil.mock.calls.map(([promise]) => promise))
      ).resolves.toEqual([undefined, undefined, undefined]);
      await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      subscription.resolve();
      await reader.cancel();
      vi.useRealTimers();
    }
  });

  it('coalesces heartbeat refreshes while subscribe is pending and avoids duplicate attachments', async () => {
    vi.useFakeTimers();
    const fixture = globalFixture();
    const subscription = Promise.withResolvers<{
      registered: boolean;
      fence: number | null;
      kiloSessionId: string;
      continuity: typeof fixtureContinuity;
    }>();
    fixture.subscribeNativeEvents.mockReturnValueOnce(subscription.promise);
    const reader = globalReader(fixture.facade);
    try {
      await vi.advanceTimersByTimeAsync(30_000);
      for (let heartbeat = 0; heartbeat < 3; heartbeat++) {
        expect(await readSseTextFrame(reader)).toBe(': heartbeat\n\n');
      }
      expect(fixture.listCloudAgentRootSessions).toHaveBeenCalledOnce();
      expect(fixture.subscribeNativeEvents).toHaveBeenCalledOnce();
      subscription.resolve({
        registered: true,
        fence: 10,
        kiloSessionId,
        continuity: fixtureContinuity,
      });
      await expectGlobalConnected(reader);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await readSseTextFrame(reader)).toBe(': heartbeat\n\n');
      expect(await readSseTextFrame(reader)).toBe(': heartbeat\n\n');
      expect(fixture.listCloudAgentRootSessions).toHaveBeenCalledTimes(3);
      expect(fixture.subscribeNativeEvents).toHaveBeenCalledOnce();
    } finally {
      subscription.resolve({
        registered: true,
        fence: 10,
        kiloSessionId,
        continuity: fixtureContinuity,
      });
      await reader.cancel();
      vi.useRealTimers();
    }
  });

  it('attaches the maximum root-list page without pagination or individual session reads', async () => {
    const roots = Array.from({ length: 100 }, (_, index) =>
      rootSummary(
        `ses_${String(index).padStart(26, '0')}`,
        `workspace_aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, '0')}`
      )
    );
    const fixture = globalFixture(roots);
    const reader = globalReader(fixture.facade);
    try {
      await expectGlobalConnected(reader);
      expect(fixture.listCloudAgentRootSessions).toHaveBeenCalledExactlyOnceWith({
        kiloUserId: groupedOwnerId,
        limit: 100,
      });
      expect(fixture.subscribeNativeEvents).toHaveBeenCalledTimes(100);
      expect(
        new Set(fixture.subscribeNativeEvents.mock.calls.map(([input]) => input.attachmentId)).size
      ).toBe(100);
      expect(fixture.resolveRoot).not.toHaveBeenCalled();
      expect(fixture.env.SESSION_INGEST.getCloudAgentRootSessionSnapshot).not.toHaveBeenCalled();
      expect(fixture.env.SESSION_INGEST.getCloudAgentRootSessionMessages).not.toHaveBeenCalled();
      expect(fixture.nativeSnapshot).not.toHaveBeenCalled();
    } finally {
      await reader.cancel();
      await Promise.all(fixture.waitUntil.mock.calls.map(([promise]) => promise));
    }
    expect(fixture.releaseNativeEvents).toHaveBeenCalledTimes(100);
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

  it.each(['snapshot_too_large', 'snapshot_unavailable'] as const)(
    'releases %s attachments once while retaining the final notice and heartbeat',
    async reason => {
      vi.useFakeTimers();
      const env = envStub();
      const releaseNativeEvents = vi.fn(async () => undefined);
      const waitUntil = vi.fn();
      env.SANDBOX_SESSION.get = vi.fn().mockReturnValue({ releaseNativeEvents });
      const facade = new UserKiloFacade({ waitUntil } as unknown as DurableObjectState, env);
      const attachmentId = facade.prepareNativeAttachment(workspaceSession, kiloSessionId, 'usr_1');
      const reader = facade
        .openPublicSessionEventStream(kiloSessionId, {
          attachmentId,
          resnapshot: reason === 'snapshot_too_large',
          ...(reason === 'snapshot_unavailable'
            ? { nextPage: async () => ({ kind: 'resnapshot' as const }) }
            : {}),
        })
        .body!.getReader();
      try {
        await reader.read();
        expect(new TextDecoder().decode((await reader.read()).value)).toContain(reason);
        await Promise.all(waitUntil.mock.calls.map(([promise]) => promise));
        expect(releaseNativeEvents).toHaveBeenCalledExactlyOnceWith({ attachmentId });
        await vi.advanceTimersByTimeAsync(10_000);
        expect(new TextDecoder().decode((await reader.read()).value)).toBe(': heartbeat\n\n');
        await reader.cancel();
        expect(releaseNativeEvents).toHaveBeenCalledTimes(1);
      } finally {
        await reader.cancel();
        vi.useRealTimers();
      }
    }
  );

  it('sends idle heartbeats after the native fence', async () => {
    vi.useFakeTimers();
    const env = envStub();
    env.SANDBOX_SESSION.get = vi
      .fn()
      .mockReturnValue({ releaseNativeEvents: vi.fn(async () => undefined) });
    const facade = new UserKiloFacade({ waitUntil: vi.fn() } as unknown as DurableObjectState, env);
    const attachmentId = facade.prepareNativeAttachment(workspaceSession, kiloSessionId, 'usr_1');
    const reader = facade
      .openPublicSessionEventStream(kiloSessionId, { attachmentId, fence: 10 })
      .body!.getReader();
    try {
      await reader.read();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('kilo.native.fence');
      await vi.advanceTimersByTimeAsync(10_000);
      expect(new TextDecoder().decode((await reader.read()).value)).toBe(': heartbeat\n\n');
    } finally {
      await reader.cancel();
      vi.useRealTimers();
    }
  });

  it('suppresses heartbeats only while snapshot delivery waits for backpressure', async () => {
    vi.useFakeTimers();
    const env = envStub();
    env.SANDBOX_SESSION.get = vi
      .fn()
      .mockReturnValue({ releaseNativeEvents: vi.fn(async () => undefined) });
    const facade = new UserKiloFacade({ waitUntil: vi.fn() } as unknown as DurableObjectState, env);
    const attachmentId = facade.prepareNativeAttachment(workspaceSession, kiloSessionId, 'usr_1');
    const reader = facade
      .openPublicSessionEventStream(kiloSessionId, {
        attachmentId,
        fence: 10,
        snapshot: Array.from({ length: 100 }, () => ({ type: 'snapshot', properties: {} })),
      })
      .body!.getReader();
    try {
      await vi.advanceTimersByTimeAsync(10_000);
      await reader.read();
      for (let i = 0; i < 100; i++) {
        expect(new TextDecoder().decode((await reader.read()).value)).toContain(
          '"type":"snapshot"'
        );
      }
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('kilo.native.fence');
      await vi.advanceTimersByTimeAsync(10_000);
      expect(new TextDecoder().decode((await reader.read()).value)).toBe(': heartbeat\n\n');
    } finally {
      await reader.cancel();
      vi.useRealTimers();
    }
  });

  it('attaches an empty registered log and uses the later snapshot watermark', async () => {
    const env = envStub();
    const subscribeNativeEvents = vi.fn(async () => ({
      registered: true,
      fence: null,
      kiloSessionId,
      continuity: fixtureContinuity,
    }));
    const nativeSnapshot = vi.fn(async () => ({ oversized: false, fence: 9, events: [] }));
    env.SANDBOX_SESSION.get = vi.fn().mockReturnValue({
      subscribeNativeEvents,
      nativeSnapshot,
    } as never);
    const openPublicSessionEventStream = vi.fn(() => new Response('stream'));
    const response = await handleKiloFacadeRequest({
      request: new Request(
        `http://worker.test/kilo/event?directory=${encodeURIComponent(publicCloudAgentDirectory(kiloSessionId))}`
      ),
      env,
      userId: 'usr_1',
      deps: hostedDeps({
        globalEvents: { openPublicSessionEventStream, openPublicGlobalEventStream: vi.fn() },
      }),
    });
    expect(response.status).toBe(200);
    expect(openPublicSessionEventStream).toHaveBeenCalledWith(
      kiloSessionId,
      expect.objectContaining({ fence: 9, snapshot: [] })
    );
  });

  it('releases only the canceled attachment when another subscriber joins the same session', async () => {
    const env = envStub();
    const releaseNativeEvents = vi.fn(async () => undefined);
    const pending: Promise<unknown>[] = [];
    env.SANDBOX_SESSION.get = vi.fn().mockReturnValue({ releaseNativeEvents });
    const facade = new UserKiloFacade(
      {
        waitUntil: (promise: Promise<unknown>) => pending.push(promise),
      } as unknown as DurableObjectState,
      env
    );
    const first = facade.prepareNativeAttachment(workspaceSession, kiloSessionId, 'usr_1');
    const second = facade.prepareNativeAttachment(workspaceSession, kiloSessionId, 'usr_1');
    const firstReader = facade
      .openPublicSessionEventStream(kiloSessionId, { attachmentId: first, fence: null })
      .body!.getReader();
    const secondReader = facade
      .openPublicSessionEventStream(kiloSessionId, { attachmentId: second, fence: null })
      .body!.getReader();
    await firstReader.cancel();
    await Promise.all(pending);
    expect(releaseNativeEvents).toHaveBeenCalledExactlyOnceWith({ attachmentId: first });
    await secondReader.cancel();
    await Promise.all(pending);
    expect(releaseNativeEvents).toHaveBeenLastCalledWith({ attachmentId: second });
  });

  it('registers before RPC pushes, streams more than 64 snapshot frames, suppresses covered pushes and releases on cancel', async () => {
    const env = envStub();
    const releaseNativeEvents = vi.fn(async () => undefined);
    const waitUntil = vi.fn();
    env.SANDBOX_SESSION.get = vi.fn().mockReturnValue({ releaseNativeEvents });
    vi.mocked(env.SESSION_INGEST.resolveCloudAgentRootSessionForKiloSession).mockResolvedValue({
      cloudAgentSessionId: workspaceSession,
    } as never);
    const facade = new UserKiloFacade({ waitUntil } as unknown as DurableObjectState, env);
    const publish = nativePublisher(facade);
    const push = (eventId: number, materialized = false) =>
      publish({
        kiloUserId: 'usr_1',
        cloudAgentSessionId: workspaceSession,
        kiloSessionId,
        eventId,
        materialized,
        event: { type: 'pushed', properties: { eventId } },
      });
    const response = await handleKiloFacadeRequest({
      request: new Request(
        `http://worker.test/kilo/event?directory=${encodeURIComponent(publicCloudAgentDirectory(kiloSessionId))}`
      ),
      env,
      userId: 'usr_1',
      deps: hostedDeps({
        globalEvents: facade,
        openNativeAttachment: async () => {
          await push(5);
          await push(11);
          return {
            kind: 'fenced',
            fence: 10,
            continuity: fixtureContinuity,
            snapshot: { oversized: false, fence: 10, events: [] },
            events: Array.from({ length: 100 }, (_, id) => ({
              type: 'snapshot',
              properties: { id },
            })),
            nextPage: async () => {
              await push(2, true);
              return {
                kind: 'fenced',
                fence: 10,
                snapshot: { oversized: false, fence: 10, events: [] },
                events: [{ type: 'last-page', properties: {} }],
              };
            },
          };
        },
      }),
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const frames: Array<{ type: string; properties: Record<string, unknown> }> = [];
    for (let i = 0; i < 105; i++) {
      const frame = await reader.read();
      frames.push(JSON.parse(new TextDecoder().decode(frame.value).slice(6).trim()));
    }
    expect(frames.filter(frame => frame.type === 'snapshot')).toHaveLength(100);
    expect(frames.slice(-4).map(frame => frame.type)).toEqual([
      'last-page',
      'kilo.native.fence',
      'pushed',
      'pushed',
    ]);
    expect(frames.at(-2)?.properties.eventId).toBe(11);
    expect(frames.at(-1)?.properties.eventId).toBe(2);
    await push(2, true);
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('"eventId":2');
    await push(12);
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('12');
    await reader.cancel();
    await Promise.all(waitUntil.mock.calls.map(([promise]) => promise));
    expect(releaseNativeEvents).toHaveBeenCalledTimes(1);
    expect(releaseNativeEvents).toHaveBeenCalledWith({ attachmentId: expect.any(String) });
  });

  it('does not send an overflowing attachment notice to a healthy same-session stream', async () => {
    const env = envStub();
    env.SANDBOX_SESSION.get = vi
      .fn()
      .mockReturnValue({ releaseNativeEvents: vi.fn(async () => undefined) });
    vi.mocked(env.SESSION_INGEST.resolveCloudAgentRootSessionForKiloSession).mockResolvedValue({
      cloudAgentSessionId: workspaceSession,
    } as never);
    const facade = new UserKiloFacade({ waitUntil: vi.fn() } as unknown as DurableObjectState, env);
    const publish = nativePublisher(facade);
    const slowId = facade.prepareNativeAttachment(workspaceSession, kiloSessionId, 'usr_1');
    const healthyId = facade.prepareNativeAttachment(workspaceSession, kiloSessionId, 'usr_1');
    const slow = facade
      .openPublicSessionEventStream(kiloSessionId, {
        attachmentId: slowId,
        fence: 0,
        continuity: fixtureContinuity,
        snapshot: Array.from({ length: 100 }, () => ({ type: 'snapshot', properties: {} })),
      })
      .body!.getReader();
    const healthy = facade
      .openPublicSessionEventStream(kiloSessionId, {
        attachmentId: healthyId,
        fence: 0,
        continuity: fixtureContinuity,
      })
      .body!.getReader();
    try {
      await healthy.read();
      await healthy.read();
      for (let eventId = 1; eventId <= 513; eventId++) {
        await publish({
          kiloUserId: 'usr_1',
          cloudAgentSessionId: workspaceSession,
          kiloSessionId,
          eventId,
          event: { type: 'pushed', properties: { eventId } },
        });
        expect(new TextDecoder().decode((await healthy.read()).value)).toContain(
          `"eventId":${eventId}`
        );
      }
    } finally {
      await slow.cancel().catch(() => undefined);
      await healthy.cancel();
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
