import { describe, expect, it, vi } from 'vitest';

const drizzleMocks = vi.hoisted(() => ({
  db: undefined as unknown,
  migrate: vi.fn(),
}));

vi.mock('cloudflare:workers', () => ({
  DurableObject: class DurableObject {
    constructor(_state: unknown, _env: unknown) {}
  },
  WorkerEntrypoint: class WorkerEntrypoint {
    env: unknown;
    ctx: ExecutionContext;
    constructor() {
      this.env = undefined;
      this.ctx = {
        waitUntil: () => {},
        passThroughOnException: () => {},
      } as unknown as ExecutionContext;
    }
  },
}));

vi.mock('drizzle-orm/durable-sqlite', () => ({
  drizzle: vi.fn(() => drizzleMocks.db),
}));

vi.mock('drizzle-orm/durable-sqlite/migrator', () => ({
  migrate: drizzleMocks.migrate,
}));

vi.mock('@kilocode/db/client', () => ({
  getWorkerDb: vi.fn(),
}));

vi.mock('../dos/SessionIngestDO', () => ({
  getSessionIngestDO: vi.fn(),
}));

vi.mock('../dos/UserConnectionDO', () => ({
  getUserConnectionDO: vi.fn(),
}));

import { getWorkerDb } from '@kilocode/db/client';
import { getSessionIngestDO } from '../dos/SessionIngestDO';
import { getUserConnectionDO } from '../dos/UserConnectionDO';
import { handleDirectIngestRequest } from './direct-ingest';
import type { DirectIngestRequest } from './direct-ingest';

const encoder = new TextEncoder();

type AgentNotificationItem = {
  type: 'agent_notification';
  data: { id: string; message: string };
};

function makeReadableStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function makeRequest(params: {
  items: unknown[];
  sessionRow: { parentSessionId: string | null } | null;
  sessionLookupError?: Error;
  ingest?: ReturnType<typeof vi.fn>;
  sendAgentSessionNotification?: ReturnType<typeof vi.fn>;
  sendCloudAgentSessionNotification?: ReturnType<typeof vi.fn>;
  hasActiveCliSession?: ReturnType<typeof vi.fn>;
}) {
  const bytes = encoder.encode(JSON.stringify({ data: params.items }));
  const defaultIngest = vi.fn(async (items: unknown[]) => ({
    accepted: true,
    changes: [],
    attentionSignals: items
      .filter(
        (item): item is AgentNotificationItem =>
          typeof item === 'object' &&
          item !== null &&
          (item as { type?: string }).type === 'agent_notification'
      )
      .map(item => ({
        kind: 'agent_notification' as const,
        notificationId: item.data.id,
        message: item.data.message,
      })),
  }));
  const ingest = params.ingest ?? defaultIngest;
  const markAgentNotificationDispatched = vi.fn();
  vi.mocked(getSessionIngestDO).mockReturnValue({
    ingest,
    markAgentNotificationDispatched,
  } as never);

  const sessionRows =
    params.sessionRow === null ? [] : [{ parentSessionId: params.sessionRow.parentSessionId }];
  const limit = vi.fn(async () => {
    if (params.sessionLookupError) throw params.sessionLookupError;
    return sessionRows;
  });
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  vi.mocked(getWorkerDb).mockReturnValue({ select } as never);

  const sendAgentSessionNotification =
    params.sendAgentSessionNotification ?? vi.fn(async () => ({ dispatched: true }));
  const sendCloudAgentSessionNotification =
    params.sendCloudAgentSessionNotification ?? vi.fn(async () => ({ dispatched: true }));
  const env = {
    DIRECT_INGEST_PERCENT: '100',
    DIRECT_INGEST_MAX_BYTES: '4194304',
    DIRECT_INGEST_USER_IDS: 'usr_agent',
    // Enable legacy (completed / needs_input) attention pushes for this user so the
    // per-user rollout gate does not suppress them. agent_notification pushes bypass
    // this gate regardless.
    REMOTE_SESSION_ATTENTION_PUSH_USER_ID: 'usr_agent',
    HYPERDRIVE: { connectionString: 'postgres://unused' },
    SESSION_INGEST_R2: { put: vi.fn(), delete: vi.fn() },
    NOTIFICATIONS: { sendAgentSessionNotification, sendCloudAgentSessionNotification },
  } as never;

  const hasActiveCliSession = params.hasActiveCliSession ?? vi.fn(async () => true);
  vi.mocked(getUserConnectionDO).mockReturnValue({
    hasActiveCliSession,
  } as never);

  return {
    request: {
      env,
      body: makeReadableStream(bytes),
      contentLength: String(bytes.byteLength),
      kiloUserId: 'usr_agent',
      sessionId: 'ses_agent',
      ingestVersion: 1,
      ingestedAt: 1,
      ingestRequestId: 'req_1',
    } as DirectIngestRequest,
    sendAgentSessionNotification,
    sendCloudAgentSessionNotification,
    hasActiveCliSession,
    markAgentNotificationDispatched,
    ingest,
  };
}

describe('agent_notification direct ingest', () => {
  it('dispatches a valid agent_notification and marks it dispatched', async () => {
    const { request, sendAgentSessionNotification, markAgentNotificationDispatched } = makeRequest({
      items: [{ type: 'agent_notification', data: { id: 'note_1', message: 'Build done' } }],
      sessionRow: { parentSessionId: null },
    });

    const result = await handleDirectIngestRequest(request);

    expect(result.status).toBe(200);
    expect(sendAgentSessionNotification).toHaveBeenCalledWith({
      userId: 'usr_agent',
      cliSessionId: 'ses_agent',
      notificationId: 'note_1',
      message: 'Build done',
    });
    expect(markAgentNotificationDispatched).toHaveBeenCalledWith('note_1');
  });

  it('drops an invalid agent_notification item and dispatches the valid one', async () => {
    const { request, sendAgentSessionNotification, markAgentNotificationDispatched, ingest } =
      makeRequest({
        items: [
          { type: 'agent_notification', data: { id: 'note_bad', message: '' } },
          { type: 'agent_notification', data: { id: 'note_ok', message: 'OK' } },
        ],
        sessionRow: { parentSessionId: null },
      });

    const result = await handleDirectIngestRequest(request);

    expect(result.status).toBe(200);
    expect(ingest).toHaveBeenCalledWith(
      [{ type: 'agent_notification', data: { id: 'note_ok', message: 'OK' } }],
      'usr_agent',
      'ses_agent',
      1,
      1
    );
    expect(sendAgentSessionNotification).toHaveBeenCalledTimes(1);
    expect(sendAgentSessionNotification).toHaveBeenCalledWith({
      userId: 'usr_agent',
      cliSessionId: 'ses_agent',
      notificationId: 'note_ok',
      message: 'OK',
    });
    expect(markAgentNotificationDispatched).toHaveBeenCalledWith('note_ok');
  });

  it('dispatches several distinct notifications in one batch', async () => {
    const { request, sendAgentSessionNotification, markAgentNotificationDispatched } = makeRequest({
      items: [
        { type: 'agent_notification', data: { id: 'a', message: 'one' } },
        { type: 'agent_notification', data: { id: 'b', message: 'two' } },
        { type: 'agent_notification', data: { id: 'c', message: 'three' } },
      ],
      sessionRow: { parentSessionId: null },
    });

    const result = await handleDirectIngestRequest(request);

    expect(result.status).toBe(200);
    expect(sendAgentSessionNotification).toHaveBeenCalledTimes(3);
    expect(markAgentNotificationDispatched).toHaveBeenCalledTimes(3);
  });

  it('leaves the marker pending when the RPC throws', async () => {
    const sendAgentSessionNotification = vi.fn(async () => {
      throw new Error('Notifications service unreachable');
    });
    const { request, markAgentNotificationDispatched } = makeRequest({
      items: [{ type: 'agent_notification', data: { id: 'note_throw', message: 'Will fail' } }],
      sessionRow: { parentSessionId: null },
      sendAgentSessionNotification,
    });

    const result = await handleDirectIngestRequest(request);

    expect(result.status).toBe(200);
    expect(sendAgentSessionNotification).toHaveBeenCalledTimes(1);
    expect(markAgentNotificationDispatched).not.toHaveBeenCalled();
  });

  it('marks the identity dispatched for an ineligible child session and skips the RPC', async () => {
    const { request, sendAgentSessionNotification, markAgentNotificationDispatched } = makeRequest({
      items: [{ type: 'agent_notification', data: { id: 'note_child', message: 'Child session' } }],
      sessionRow: { parentSessionId: 'ses_parent' },
    });

    const result = await handleDirectIngestRequest(request);

    expect(result.status).toBe(200);
    expect(sendAgentSessionNotification).not.toHaveBeenCalled();
    expect(markAgentNotificationDispatched).toHaveBeenCalledWith('note_child');
  });

  it('marks the identity dispatched when the post-commit session lookup finds no session', async () => {
    const { request, sendAgentSessionNotification, markAgentNotificationDispatched } = makeRequest({
      items: [{ type: 'agent_notification', data: { id: 'note_gone', message: 'Session gone' } }],
      sessionRow: null,
    });

    const result = await handleDirectIngestRequest(request);

    expect(result.status).toBe(200);
    expect(sendAgentSessionNotification).not.toHaveBeenCalled();
    expect(markAgentNotificationDispatched).toHaveBeenCalledWith('note_gone');
  });

  it('still dispatches legacy signals when the agent_notification RPC throws and leaves the agent identity pending', async () => {
    const sendAgentSessionNotification = vi.fn(async () => {
      throw new Error('Notifications service unreachable');
    });
    const ingest = vi.fn(async () => ({
      accepted: true,
      changes: [],
      attentionSignals: [
        { kind: 'agent_notification', notificationId: 'note_throw', message: 'Will fail' },
        { kind: 'completed', signalId: 'sig_1', messageExcerpt: 'All done' },
      ],
    }));
    const { request, sendCloudAgentSessionNotification, markAgentNotificationDispatched } =
      makeRequest({
        items: [{ type: 'message', data: { id: 'msg_1' } }],
        sessionRow: { parentSessionId: null },
        ingest,
        sendAgentSessionNotification,
      });

    const result = await handleDirectIngestRequest(request);

    expect(result.status).toBe(200);
    expect(sendAgentSessionNotification).toHaveBeenCalledTimes(1);
    expect(sendCloudAgentSessionNotification).toHaveBeenCalledWith({
      userId: 'usr_agent',
      cliSessionId: 'ses_agent',
      executionId: 'remote:sig_1',
      status: 'completed',
      body: 'All done',
      suppressIfViewingSession: true,
    });
    expect(markAgentNotificationDispatched).not.toHaveBeenCalled();
  });

  it('leaves the marker pending when the post-commit session lookup fails', async () => {
    const { request, sendAgentSessionNotification, markAgentNotificationDispatched } = makeRequest({
      items: [
        { type: 'agent_notification', data: { id: 'note_lookup_fail', message: 'Lookup fails' } },
      ],
      sessionRow: { parentSessionId: null },
      sessionLookupError: new Error('Postgres unavailable'),
    });

    const result = await handleDirectIngestRequest(request);

    expect(result.status).toBe(200);
    expect(sendAgentSessionNotification).not.toHaveBeenCalled();
    expect(markAgentNotificationDispatched).not.toHaveBeenCalled();
  });

  it('marks agent_notification dispatched for ineligible session with both legacy and agent signals', async () => {
    const ingest = vi.fn(async () => ({
      accepted: true,
      changes: [],
      attentionSignals: [
        { kind: 'completed', signalId: 'sig_1', messageExcerpt: 'All done' },
        { kind: 'agent_notification', notificationId: 'note_mixed', message: 'Mixed signals' },
      ],
    }));
    const {
      request,
      sendCloudAgentSessionNotification,
      sendAgentSessionNotification,
      markAgentNotificationDispatched,
    } = makeRequest({
      items: [{ type: 'message', data: { id: 'msg_1' } }],
      sessionRow: { parentSessionId: 'ses_parent' }, // child session = ineligible
      ingest,
    });

    const result = await handleDirectIngestRequest(request);

    expect(result.status).toBe(200);
    // Legacy signal should not dispatch for ineligible session
    expect(sendCloudAgentSessionNotification).not.toHaveBeenCalled();
    // Agent notification should be marked dispatched via its own lookup path
    expect(sendAgentSessionNotification).not.toHaveBeenCalled();
    expect(markAgentNotificationDispatched).toHaveBeenCalledWith('note_mixed');
  });
});
