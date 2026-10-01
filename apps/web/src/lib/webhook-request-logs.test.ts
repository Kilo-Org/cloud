import { getWebhookRequestLogs } from './webhook-request-logs';
import { getWorkerRequest } from '@/lib/webhook-agent/webhook-agent-client';
import { fetchSessionSnapshot } from '@/lib/session-ingest-client';
import { getBlobContent } from '@/lib/r2/cli-sessions';
import { cliSessions, cli_sessions_v2 } from '@kilocode/db/schema';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

jest.mock('@/lib/webhook-agent/webhook-agent-client', () => ({ getWorkerRequest: jest.fn() }));
jest.mock('@/lib/session-ingest-client', () => ({ fetchSessionSnapshot: jest.fn() }));
jest.mock('@/lib/r2/cli-sessions', () => ({ getBlobContent: jest.fn() }));
const mockLimit = jest.fn();
const mockWhere = jest.fn((_where: SQL) => ({ limit: mockLimit }));
const mockFrom = jest.fn((_table: typeof cliSessions | typeof cli_sessions_v2) => ({
  where: mockWhere,
}));
jest.mock('@kilocode/web-shared/lib/drizzle', () => ({
  db: { select: () => ({ from: mockFrom }) },
}));

const requestId = '00000000-0000-4000-8000-000000000001';
const readLogs = () => getWebhookRequestLogs('oauth/owner', undefined, 'trigger', requestId);

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(getWorkerRequest).mockResolvedValue({
    success: true,
    status: 200,
    data: { id: requestId, processStatus: 'inprogress', cloudAgentSessionId: 'cloud-session' },
  });
  mockLimit.mockResolvedValue([]);
});

it('looks up the request in the supplied trigger namespace', async () => {
  await readLogs();
  expect(getWorkerRequest).toHaveBeenCalledWith('oauth/owner', undefined, 'trigger', requestId);
});

it('returns empty logs without a session lookup for an unstarted request', async () => {
  jest.mocked(getWorkerRequest).mockResolvedValue({
    success: true,
    status: 200,
    data: { id: requestId, processStatus: 'captured', cloudAgentSessionId: null },
  });
  expect(await readLogs()).toEqual({ logs: [], processStatus: 'captured', logsReady: false });
  expect(mockFrom).not.toHaveBeenCalled();
});

it.each([404, 500])('surfaces worker failure %s without session access', async status => {
  jest.mocked(getWorkerRequest).mockResolvedValue({ success: false, status, error: 'failure' });
  await expect(readLogs()).rejects.toMatchObject({
    code: status === 404 ? 'NOT_FOUND' : 'INTERNAL_SERVER_ERROR',
  });
  expect(mockFrom).not.toHaveBeenCalled();
});

it('constrains personal v1 and v2 lookups to owner and null organization', async () => {
  expect(await readLogs()).toEqual({ logs: [], processStatus: 'inprogress', logsReady: false });
  expect(mockFrom.mock.calls).toEqual([[cliSessions], [cli_sessions_v2]]);
  for (const [where] of mockWhere.mock.calls) {
    const query = new PgDialect().sqlToQuery(where);
    expect(query.sql).toContain('"organization_id" is null');
    expect(query.sql).toContain('"kilo_user_id" =');
    expect(query.params).toEqual(['cloud-session', 'oauth/owner']);
  }
});

it('constrains organization lookups without restricting the bot owner', async () => {
  await getWebhookRequestLogs(undefined, 'org-id', 'trigger', requestId);
  for (const [where] of mockWhere.mock.calls) {
    const query = new PgDialect().sqlToQuery(where);
    expect(query.sql).toContain('"organization_id" =');
    expect(query.sql).not.toContain('"kilo_user_id"');
    expect(query.params).toEqual(['cloud-session', 'org-id']);
  }
});

it('converts v1 persisted UI messages', async () => {
  mockLimit.mockResolvedValueOnce([{ blobUrl: 'blob-key' }]);
  jest
    .mocked(getBlobContent)
    .mockResolvedValue([{ type: 'say', say: 'text', text: 'hello', ts: 1 }]);
  const result = await readLogs();
  expect(result.logsReady).toBe(true);
  expect(result.logs).toEqual(
    expect.arrayContaining([expect.objectContaining({ message: 'hello' })])
  );
  expect(getBlobContent).toHaveBeenCalledWith('blob-key');
  expect(fetchSessionSnapshot).not.toHaveBeenCalled();
});

it('converts v2 snapshots using the stored owner for storage access', async () => {
  mockLimit
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ sessionId: 'ses_123', userId: 'bot' }]);
  jest.mocked(fetchSessionSnapshot).mockResolvedValue({
    info: { id: 'ses_123' },
    messages: [
      {
        info: { id: 'msg_123', role: 'user', time: { created: 1 } },
        parts: [{ id: 'part_123', type: 'text', text: 'prompt' }],
      },
    ],
  });
  const result = await getWebhookRequestLogs(undefined, 'org-id', 'trigger', requestId);
  expect(fetchSessionSnapshot).toHaveBeenCalledWith('ses_123', 'bot');
  expect(result.logs).toEqual([expect.objectContaining({ message: 'prompt' })]);
  expect(result.logsReady).toBe(true);
});

it.each(['v1', 'v2'])('returns empty for ambiguous %s session matches', async version => {
  if (version === 'v2') mockLimit.mockResolvedValueOnce([]);
  mockLimit.mockResolvedValueOnce([{}, {}]);
  expect((await readLogs()).logsReady).toBe(false);
  expect(getBlobContent).not.toHaveBeenCalled();
  expect(fetchSessionSnapshot).not.toHaveBeenCalled();
});

it('returns empty when the v2 snapshot is not ready', async () => {
  mockLimit
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ sessionId: 'ses_123', userId: 'owner' }]);
  jest.mocked(fetchSessionSnapshot).mockResolvedValue(null);
  expect((await readLogs()).logsReady).toBe(false);
});

it('returns empty when a v1 blob is missing', async () => {
  mockLimit.mockResolvedValueOnce([{ blobUrl: 'missing' }]);
  jest
    .mocked(getBlobContent)
    .mockRejectedValue(Object.assign(new Error('missing'), { name: 'NoSuchKey' }));
  expect((await readLogs()).logsReady).toBe(false);
});
