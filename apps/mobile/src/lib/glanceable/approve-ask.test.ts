/* eslint-disable require-await, @typescript-eslint/require-await -- fakes settle without await */
/* eslint-disable max-lines -- one cohesive suite for the shared answer path and its republish poll */
import { type CloudAgentEvent, type ConnectionConfig } from '@kilocode/cloud-agent-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Keep this suite on the pure vitest project: mock every RN / Expo / SDK
// side-effect import that `approve-ask.ts` pulls transitively before loading the
// module under test. The record store and the publisher factory are sibling
// modules (`waiting-ask`, `create-publisher`); their own suites cover them.
const answerPermissionMutate = vi.fn();
const orgAnswerPermissionMutate = vi.fn();
const getSessionQuery = vi.fn();
const listActiveSessionsQuery = vi.fn();
vi.mock('@/lib/trpc', () => ({
  trpcClient: {
    activeSessions: { list: { query: listActiveSessionsQuery } },
    cliSessionsV2: { get: { query: getSessionQuery } },
    cloudAgentNext: { answerPermission: { mutate: answerPermissionMutate } },
    organizations: {
      cloudAgentNext: { answerPermission: { mutate: orgAnswerPermissionMutate } },
    },
  },
}));
const fetchCloudAgentStreamTicket = vi.fn();
vi.mock('@/lib/cloud-agent-stream-ticket', () => ({ fetchCloudAgentStreamTicket }));
const createConnection = vi.fn();
vi.mock('@kilocode/cloud-agent-sdk', () => ({ createConnection }));
vi.mock('@/lib/config', () => ({
  API_BASE_URL: 'https://api.test',
  CLOUD_AGENT_WS_URL: 'wss://ws.test',
  WEB_BASE_URL: 'https://web.test',
}));
vi.mock('@/lib/user-web-connection-lifecycle', () => ({
  createNativeUserWebConnectionLifecycleHooks: vi.fn(() => ({})),
}));
const buildActiveSessionsTrayInput = vi.fn((organizationId: string | null) => ({
  includeCloudAgentSessions: true,
  organizationId,
}));
vi.mock('@/lib/active-sessions-live', () => ({ buildActiveSessionsTrayInput }));
const readWaitingAsk = vi.fn();
const recordWaitingAsk = vi.fn();
vi.mock('./waiting-ask', () => ({ readWaitingAsk, recordWaitingAsk }));
const createGlanceablePublisher = vi.fn();
vi.mock('./create-publisher', () => ({ createGlanceablePublisher }));

const { trpcClient } = await import('@/lib/trpc');
const {
  answerSessionPermission,
  NotApprovableError,
  refreshGlanceableSnapshot,
  resolvePendingPermissionId,
  runGlanceableApprove,
} = await import('@/lib/glanceable/approve-ask');

function connectedFrame(permissionIds: readonly string[]): CloudAgentEvent {
  return {
    eventId: 1,
    sessionId: 'agent_1',
    streamEventType: 'connected',
    timestamp: '2026-01-01T00:00:00.000Z',
    data: {
      pendingInteractions: {
        revision: 1,
        questions: [],
        permissions: permissionIds.map(id => ({ id })),
      },
    },
  };
}

/** A fake stream: every frame fires on the next microtask once connect runs. */
function fakeStream(frames: readonly CloudAgentEvent[]) {
  const connect = vi.fn();
  const destroy = vi.fn();
  const open = (config: ConnectionConfig): { connect: () => void; destroy: () => void } => ({
    connect: () => {
      connect();
      for (const frame of frames) {
        queueMicrotask(() => {
          config.onEvent(frame);
        });
      }
    },
    destroy: () => {
      destroy();
    },
  });
  return { connect, destroy, open };
}

const resolveTicket = async () => ({ ticket: 'ticket', expiresAt: Date.now() + 60_000 });

const PERMISSION_ASK = {
  kiloSessionId: 'ses_1',
  status: 'permission',
  isCloudAgent: true,
  scopeKey: 'scope',
  organizationId: null,
  userId: 'user_1',
  recordedAt: 1,
};

function withCode(code: string): Error {
  return Object.assign(new Error(code), { data: { code } });
}

describe('answerSessionPermission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('answers through the organization client when an organization is set', async () => {
    orgAnswerPermissionMutate.mockResolvedValue(undefined);
    await answerSessionPermission({
      kiloSessionId: 'ses_1',
      cloudAgentSessionId: 'agent_1',
      organizationId: 'org_1',
      requestId: 'perm_1',
      response: 'once',
    });
    expect(orgAnswerPermissionMutate).toHaveBeenCalledWith(
      { sessionId: 'agent_1', permissionId: 'perm_1', response: 'once', organizationId: 'org_1' },
      { context: { skipBatch: true } }
    );
    expect(answerPermissionMutate).not.toHaveBeenCalled();
    expect(getSessionQuery).not.toHaveBeenCalled();
  });

  it('answers through the personal client when no organization is set', async () => {
    answerPermissionMutate.mockResolvedValue(undefined);
    await answerSessionPermission({
      kiloSessionId: 'ses_1',
      cloudAgentSessionId: 'agent_1',
      organizationId: null,
      requestId: 'perm_1',
      response: 'always',
    });
    expect(answerPermissionMutate).toHaveBeenCalledWith(
      { sessionId: 'agent_1', permissionId: 'perm_1', response: 'always' },
      { context: { skipBatch: true } }
    );
    expect(orgAnswerPermissionMutate).not.toHaveBeenCalled();
  });

  it('resolves the cloud-agent id from the row when the caller does not know it', async () => {
    getSessionQuery.mockResolvedValue({ cloud_agent_session_id: 'agent_2' });
    answerPermissionMutate.mockResolvedValue(undefined);
    await answerSessionPermission({
      kiloSessionId: 'ses_2',
      requestId: 'perm_2',
      response: 'reject',
    });
    expect(getSessionQuery).toHaveBeenCalledWith({ session_id: 'ses_2' });
    expect(answerPermissionMutate).toHaveBeenCalledWith(
      { sessionId: 'agent_2', permissionId: 'perm_2', response: 'reject' },
      { context: { skipBatch: true } }
    );
  });

  it('throws NOT_APPROVABLE when the row has no cloud-agent session id', async () => {
    getSessionQuery.mockResolvedValue({ cloud_agent_session_id: null });
    await expect(
      answerSessionPermission({ kiloSessionId: 'ses_3', requestId: 'perm_3', response: 'once' })
    ).rejects.toBeInstanceOf(NotApprovableError);
    expect(answerPermissionMutate).not.toHaveBeenCalled();
    expect(orgAnswerPermissionMutate).not.toHaveBeenCalled();
  });
});

describe('resolvePendingPermissionId', () => {
  it('returns the id from the first connected payload and closes the stream', async () => {
    const stream = fakeStream([connectedFrame(['perm_first']), connectedFrame(['perm_second'])]);
    const permissionId = await resolvePendingPermissionId(
      { cloudAgentSessionId: 'agent_1' },
      { getTicket: resolveTicket, createConnection: stream.open }
    );
    expect(permissionId).toBe('perm_first');
    expect(stream.connect).toHaveBeenCalledTimes(1);
    expect(stream.destroy).toHaveBeenCalledTimes(1);
  });

  it('returns null when the connect carries no pending permission', async () => {
    const stream = fakeStream([connectedFrame([])]);
    const permissionId = await resolvePendingPermissionId(
      { cloudAgentSessionId: 'agent_1' },
      { getTicket: resolveTicket, createConnection: stream.open }
    );
    expect(permissionId).toBeNull();
    expect(stream.destroy).toHaveBeenCalledTimes(1);
  });

  it('returns null when the deadline fires', async () => {
    const stream = fakeStream([]);
    const deadlines: (() => void)[] = [];
    const cancelled = vi.fn();
    const pending = resolvePendingPermissionId(
      { cloudAgentSessionId: 'agent_1', timeoutMs: 50 },
      {
        getTicket: resolveTicket,
        createConnection: stream.open,
        setTimeout: handler => {
          deadlines.push(handler);
          return () => {
            cancelled();
          };
        },
      }
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(deadlines).toHaveLength(1);
    deadlines[0]?.();
    await expect(pending).resolves.toBeNull();
  });

  it('returns null when the connected frame lands after the deadline', async () => {
    const stream = fakeStream([connectedFrame(['perm_late'])]);
    const clock = { now: 1000 };
    const cancelled = vi.fn();
    const permissionId = await resolvePendingPermissionId(
      { cloudAgentSessionId: 'agent_1', timeoutMs: 50 },
      {
        getTicket: resolveTicket,
        createConnection: stream.open,
        // The second read (the frame check) is past startedAt + timeoutMs.
        now: () => {
          const read = clock.now;
          clock.now += 1000;
          return read;
        },
        setTimeout: () => () => {
          cancelled();
        },
      }
    );
    expect(permissionId).toBeNull();
  });
});

describe('runGlanceableApprove', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionQuery.mockResolvedValue({ cloud_agent_session_id: 'agent_1' });
    fetchCloudAgentStreamTicket.mockImplementation(resolveTicket);
    createConnection.mockImplementation(fakeStream([connectedFrame(['perm_1'])]).open);
  });

  it('is none when no ask is recorded', async () => {
    readWaitingAsk.mockResolvedValue(null);
    await expect(runGlanceableApprove()).resolves.toEqual({ kind: 'none' });
    expect(answerPermissionMutate).not.toHaveBeenCalled();
  });

  it('is none for a question ask', async () => {
    readWaitingAsk.mockResolvedValue({ ...PERMISSION_ASK, status: 'question' });
    await expect(runGlanceableApprove()).resolves.toEqual({ kind: 'none' });
    expect(answerPermissionMutate).not.toHaveBeenCalled();
  });

  it('is none for a legacy wrapper session', async () => {
    readWaitingAsk.mockResolvedValue({ ...PERMISSION_ASK, isCloudAgent: false });
    await expect(runGlanceableApprove()).resolves.toEqual({ kind: 'none' });
    expect(fetchCloudAgentStreamTicket).not.toHaveBeenCalled();
  });

  it('answers the recorded permission and clears the record', async () => {
    readWaitingAsk.mockResolvedValue(PERMISSION_ASK);
    answerPermissionMutate.mockResolvedValue(undefined);
    await expect(runGlanceableApprove()).resolves.toEqual({ kind: 'approved' });
    expect(answerPermissionMutate).toHaveBeenCalledWith(
      { sessionId: 'agent_1', permissionId: 'perm_1', response: 'once' },
      { context: { skipBatch: true } }
    );
    expect(recordWaitingAsk).toHaveBeenCalledWith(null);
  });

  it.each([
    ['a transport error', new Error('network down')],
    ['a 5xx server rejection', withCode('INTERNAL_SERVER_ERROR')],
  ])('is retryable for %s and keeps the record', async (_label, error) => {
    readWaitingAsk.mockResolvedValue(PERMISSION_ASK);
    answerPermissionMutate.mockRejectedValue(error);
    await expect(runGlanceableApprove()).resolves.toEqual({ kind: 'retryable' });
    expect(recordWaitingAsk).not.toHaveBeenCalled();
  });

  it('is gone when the permission is already answered elsewhere', async () => {
    readWaitingAsk.mockResolvedValue(PERMISSION_ASK);
    answerPermissionMutate.mockRejectedValue(withCode('NOT_FOUND'));
    await expect(runGlanceableApprove()).resolves.toEqual({ kind: 'gone' });
    expect(recordWaitingAsk).not.toHaveBeenCalled();
  });

  it('is gone when the projection has no pending permission', async () => {
    readWaitingAsk.mockResolvedValue(PERMISSION_ASK);
    createConnection.mockImplementation(fakeStream([connectedFrame([])]).open);
    await expect(runGlanceableApprove()).resolves.toEqual({ kind: 'gone' });
    expect(answerPermissionMutate).not.toHaveBeenCalled();
  });

  it('is gone when the session has no cloud-agent permission (NOT_APPROVABLE)', async () => {
    readWaitingAsk.mockResolvedValue(PERMISSION_ASK);
    getSessionQuery.mockResolvedValue({ cloud_agent_session_id: null });
    await expect(runGlanceableApprove()).resolves.toEqual({ kind: 'gone' });
    expect(answerPermissionMutate).not.toHaveBeenCalled();
  });
});

describe('refreshGlanceableSnapshot', () => {
  const ctx = { userId: 'user_1', organizationId: null };

  function makePublisher() {
    return { handleSessions: vi.fn() };
  }

  it('publishes the first response immediately', async () => {
    const publisher = makePublisher();
    const rows = [{ id: 'ses_1', status: 'idle' }];
    const fetchRows = vi.fn(async () => rows);
    await refreshGlanceableSnapshot(
      { userId: 'user_1', organizationId: null, answeredKiloSessionId: 'ses_1' },
      { fetchRows, createPublisher: () => publisher, sleep: vi.fn() }
    );
    expect(fetchRows).toHaveBeenCalledTimes(1);
    expect(publisher.handleSessions).toHaveBeenCalledTimes(1);
    expect(publisher.handleSessions).toHaveBeenCalledWith(rows, ctx);
  });

  it('polls every interval while the answered session still waits', async () => {
    const publisher = makePublisher();
    const responses = [
      [{ id: 'ses_1', status: 'permission' }],
      [{ id: 'ses_1', status: 'permission' }],
      [{ id: 'ses_1', status: 'busy' }],
    ];
    const fetchRows = vi.fn(async () => responses.shift() ?? []);
    const sleep = vi.fn();
    await refreshGlanceableSnapshot(
      { userId: 'user_1', organizationId: null, answeredKiloSessionId: 'ses_1' },
      { fetchRows, createPublisher: () => publisher, sleep }
    );
    expect(fetchRows).toHaveBeenCalledTimes(3);
    expect(publisher.handleSessions).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('stops at the deadline while the session still waits', async () => {
    const publisher = makePublisher();
    const rows = [{ id: 'ses_1', status: 'permission' }];
    const fetchRows = vi.fn(async () => rows);
    const sleep = vi.fn();
    await refreshGlanceableSnapshot(
      { userId: 'user_1', organizationId: null, answeredKiloSessionId: 'ses_1' },
      {
        fetchRows,
        createPublisher: () => publisher,
        sleep,
        pollIntervalMs: 1000,
        deadlineMs: 3000,
      }
    );
    // t=0, 1 s, 2 s, 3 s: four real responses, then the budget ends the poll.
    expect(fetchRows).toHaveBeenCalledTimes(4);
    expect(publisher.handleSessions).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it('stops on a fetch error without publishing fabricated data', async () => {
    const publisher = makePublisher();
    const fetchRows = vi.fn(async () => {
      throw new Error('offline');
    });
    await refreshGlanceableSnapshot(
      { userId: 'user_1', organizationId: null, answeredKiloSessionId: 'ses_1' },
      { fetchRows, createPublisher: () => publisher, sleep: vi.fn() }
    );
    expect(publisher.handleSessions).not.toHaveBeenCalled();
  });

  it('keeps the last real snapshot when a later fetch fails', async () => {
    const publisher = makePublisher();
    const rows = [{ id: 'ses_1', status: 'permission' }];
    const fetchRows = vi
      .fn()
      .mockResolvedValueOnce(rows)
      .mockRejectedValueOnce(new Error('offline'));
    await refreshGlanceableSnapshot(
      { userId: 'user_1', organizationId: null, answeredKiloSessionId: 'ses_1' },
      { fetchRows, createPublisher: () => publisher, sleep: vi.fn() }
    );
    expect(fetchRows).toHaveBeenCalledTimes(2);
    expect(publisher.handleSessions).toHaveBeenCalledTimes(1);
    expect(publisher.handleSessions).toHaveBeenCalledWith(rows, ctx);
  });

  it('refetches the tray through the shared tray input and the shared publisher', async () => {
    const publisher = makePublisher();
    const sessions = [{ id: 'ses_1', status: 'idle' }];
    listActiveSessionsQuery.mockResolvedValue({ sessions });
    createGlanceablePublisher.mockReturnValue(publisher);
    await refreshGlanceableSnapshot({
      userId: 'user_1',
      organizationId: 'org_9',
      answeredKiloSessionId: 'ses_1',
    });
    expect(buildActiveSessionsTrayInput).toHaveBeenCalledWith('org_9');
    expect(listActiveSessionsQuery).toHaveBeenCalledWith(buildActiveSessionsTrayInput('org_9'));
    expect(createGlanceablePublisher).toHaveBeenCalledTimes(1);
    expect(publisher.handleSessions).toHaveBeenCalledWith(sessions, {
      userId: 'user_1',
      organizationId: 'org_9',
    });
  });

  it('reads the tray through the same trpc client surface the manager uses', () => {
    expect(trpcClient.activeSessions.list.query).toBe(listActiveSessionsQuery);
  });
});
