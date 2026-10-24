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
  expect(await readLogs()).toEqual({
    logs: [],
    transcript: null,
    processStatus: 'captured',
    logsReady: false,
  });
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
  expect(await readLogs()).toEqual({
    logs: [],
    transcript: null,
    processStatus: 'inprogress',
    logsReady: false,
  });
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

it('converts v1 persisted UI messages into logs and a structured transcript', async () => {
  mockLimit.mockResolvedValueOnce([{ blobUrl: 'blob-key' }]);
  jest.mocked(getBlobContent).mockResolvedValue([
    { ts: 1, type: 'say', say: 'user_feedback', text: 'review this' },
    { ts: 2, type: 'say', say: 'text', text: 'looking' },
    {
      ts: 3,
      type: 'ask',
      ask: 'tool',
      text: JSON.stringify({ tool: 'readFile', path: 'src/app.ts' }),
    },
  ]);
  const result = await readLogs();
  expect(result.logsReady).toBe(true);
  expect(result.logs).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ message: 'review this' }),
      expect.objectContaining({ message: 'looking' }),
      expect.objectContaining({ message: 'Tool: readFile', content: 'src/app.ts' }),
    ])
  );
  expect(result.transcript).toEqual({
    version: 'v1',
    messages: [
      expect.objectContaining({
        ts: 1,
        type: 'user',
        say: 'user_feedback',
        text: 'review this',
      }),
      expect.objectContaining({ ts: 2, type: 'assistant', say: 'text', text: 'looking' }),
      expect.objectContaining({
        ts: 3,
        type: 'assistant',
        ask: 'tool',
        metadata: { tool: 'readFile', path: 'src/app.ts' },
      }),
    ],
  });
  expect(getBlobContent).toHaveBeenCalledWith('blob-key');
  expect(fetchSessionSnapshot).not.toHaveBeenCalled();
});

it('labels v1 say:tool entries so legacy bubbles have a tool summary', async () => {
  mockLimit.mockResolvedValueOnce([{ blobUrl: 'blob-key' }]);
  jest.mocked(getBlobContent).mockResolvedValue([
    {
      ts: 1,
      type: 'say',
      say: 'tool',
      text: JSON.stringify({ tool: 'readFile', path: 'src/app.ts' }),
    },
  ]);

  const result = await getWebhookRequestLogs(undefined, 'org-id', 'trigger', requestId);

  expect(result.transcript).toEqual({
    version: 'v1',
    messages: [
      expect.objectContaining({
        ts: 1,
        type: 'assistant',
        say: 'tool',
        ask: 'tool',
        text: '',
        content: '',
        metadata: { tool: 'readFile', path: 'src/app.ts' },
      }),
    ],
  });
});

it('ignores non-record v1 blob entries in the structured transcript', async () => {
  mockLimit.mockResolvedValueOnce([{ blobUrl: 'blob-key' }]);
  jest
    .mocked(getBlobContent)
    .mockResolvedValue([null, 'ignored', { ts: 1, type: 'say', say: 'text', text: 'kept' }]);
  const result = await readLogs();
  expect(result.transcript).toEqual({
    version: 'v1',
    messages: [expect.objectContaining({ text: 'kept' })],
  });
});

it('converts v2 snapshots using the stored owner for storage access', async () => {
  mockLimit
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ sessionId: 'ses_123', userId: 'bot' }]);
  jest.mocked(fetchSessionSnapshot).mockResolvedValue({
    info: { id: 'ses_123' },
    messages: [
      {
        info: { id: 'msg_1', role: 'user', time: { created: 1 } },
        parts: [{ id: 'part_1', type: 'text', text: 'prompt' }],
      },
      {
        info: { id: 'msg_2', role: 'assistant', time: { created: 2 } },
        parts: [
          { id: 'part_2', type: 'text', text: 'Reading the file' },
          {
            id: 'part_3',
            type: 'tool',
            tool: 'read',
            state: {
              status: 'completed',
              input: { filePath: 'src/index.ts' },
              output: 'contents',
              time: { start: 1, end: 2 },
            },
          },
        ],
      },
    ],
  });
  const result = await readLogs();
  expect(fetchSessionSnapshot).toHaveBeenCalledWith('ses_123', 'bot');
  expect(result.logs).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ message: 'prompt' }),
      expect.objectContaining({ message: 'Reading the file' }),
      expect.objectContaining({ message: 'Tool: read', content: 'src/index.ts' }),
    ])
  );
  expect(result.transcript).toEqual({
    version: 'v2',
    messages: [
      expect.objectContaining({
        info: expect.objectContaining({ id: 'msg_1', role: 'user' }),
        parts: [expect.objectContaining({ type: 'text', text: 'prompt' })],
      }),
      expect.objectContaining({
        info: expect.objectContaining({ id: 'msg_2', role: 'assistant' }),
        parts: expect.arrayContaining([
          expect.objectContaining({ type: 'text', text: 'Reading the file' }),
          expect.objectContaining({
            type: 'tool',
            tool: 'read',
            state: expect.objectContaining({
              status: 'completed',
              input: { filePath: 'src/index.ts' },
              output: 'contents',
            }),
          }),
        ]),
      }),
    ],
  });
  expect(result.logsReady).toBe(true);
});

it('minimizes v1 organization transcripts to the content the flat logs exposed', async () => {
  mockLimit.mockResolvedValueOnce([{ blobUrl: 'blob-key' }]);
  jest.mocked(getBlobContent).mockResolvedValue([
    { ts: 1, type: 'say', say: 'user_feedback', text: 'review this' },
    { ts: 2, type: 'say', say: 'text', text: 'looking' },
    {
      ts: 3,
      type: 'ask',
      ask: 'tool',
      text: JSON.stringify({ tool: 'readFile', path: 'src/app.ts', content: 'SECRET_CONTENT' }),
      metadata: { tool: 'readFile', path: 'src/app.ts', output: 'SECRET_OUTPUT' },
    },
    {
      ts: 4,
      type: 'ask',
      ask: 'command',
      text: JSON.stringify({ command: 'npm test', output: 'SECRET_COMMAND_OUTPUT' }),
      metadata: { command: 'npm test', output: 'SECRET_COMMAND_OUTPUT', token: 'SECRET_TOKEN' },
    },
    {
      ts: 5,
      type: 'say',
      say: 'completion_result',
      text: 'done',
      metadata: { output: 'SECRET_DONE' },
    },
    {
      ts: 6,
      type: 'say',
      say: 'api_req_started',
      text: JSON.stringify({ token: 'SECRET_API' }),
      metadata: { token: 'SECRET_API' },
    },
    { ts: 7, type: 'say', say: 'error', text: 'boom' },
    { ts: 8, type: 'say', say: 'reasoning', text: 'SECRET_REASONING' },
    { ts: 9, type: 'system', text: 'SECRET_SYSTEM' },
  ]);
  const result = await getWebhookRequestLogs(undefined, 'org-id', 'trigger', requestId);
  if (!result.transcript || result.transcript.version !== 'v1') {
    throw new Error('Expected a v1 transcript');
  }

  expect(result.transcript.messages).toEqual([
    expect.objectContaining({ ts: 1, type: 'user', text: 'review this' }),
    expect.objectContaining({ ts: 2, type: 'assistant', say: 'text', text: 'looking' }),
    expect.objectContaining({
      ts: 3,
      type: 'assistant',
      ask: 'tool',
      text: '',
      content: '',
      metadata: { tool: 'readFile', path: 'src/app.ts' },
    }),
    expect.objectContaining({
      ts: 4,
      type: 'assistant',
      ask: 'command',
      text: '',
      content: '',
      metadata: { tool: 'command', command: 'npm test' },
    }),
    expect.objectContaining({ ts: 5, type: 'assistant', say: 'completion_result', text: 'done' }),
    expect.objectContaining({
      ts: 6,
      type: 'assistant',
      say: 'api_req_started',
      text: '',
      content: '',
    }),
    expect.objectContaining({ ts: 7, type: 'assistant', say: 'error', text: 'boom' }),
  ]);
  expect(JSON.stringify(result.transcript)).not.toContain('SECRET_');
  expect(result.logs).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ message: 'review this' }),
      expect.objectContaining({ message: 'Tool: readFile', content: 'src/app.ts' }),
      expect.objectContaining({ message: 'Tool: command', content: 'npm test' }),
    ])
  );
});

it('minimizes v2 organization transcripts without tool outputs, private inputs, reasoning, or files', async () => {
  mockLimit
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ sessionId: 'ses_org', userId: 'bot' }]);
  jest.mocked(fetchSessionSnapshot).mockResolvedValue({
    info: { id: 'ses_org' },
    messages: [
      {
        info: {
          id: 'msg_1',
          sessionID: 'ses_org',
          role: 'user',
          time: { created: 1 },
          agent: 'SECRET_AGENT',
          model: { providerID: 'SECRET_PROVIDER', modelID: 'SECRET_MODEL' },
        },
        parts: [
          {
            id: 'part_1',
            sessionID: 'ses_org',
            messageID: 'msg_1',
            type: 'text',
            text: 'prompt',
          },
        ],
      },
      {
        info: {
          id: 'msg_2',
          sessionID: 'ses_org',
          parentID: 'msg_1',
          role: 'assistant',
          time: { created: 2, completed: 3 },
          error: {
            name: 'ApiError',
            data: { message: 'message error', responseBody: 'SECRET_BODY' },
          },
          modelID: 'SECRET_MODEL',
          providerID: 'SECRET_PROVIDER',
          mode: 'SECRET_MODE',
          agent: 'SECRET_AGENT',
          path: { cwd: '/secret/cwd', root: '/secret/root' },
          cost: 42,
          tokens: {
            input: 1,
            output: 2,
            reasoning: 3,
            cache: { read: 4, write: 5 },
          },
        },
        parts: [
          {
            id: 'part_2',
            sessionID: 'ses_org',
            messageID: 'msg_2',
            type: 'text',
            text: 'Reading',
            metadata: { secret: 'SECRET_TEXT_METADATA' },
          },
          {
            id: 'part_3',
            sessionID: 'ses_org',
            messageID: 'msg_2',
            type: 'tool',
            callID: 'call_1',
            tool: 'read',
            metadata: { secret: 'SECRET_TOOL_METADATA' },
            state: {
              status: 'completed',
              input: {
                filePath: 'src/index.ts',
                content: 'SECRET_INPUT_CONTENT',
                oldString: 'SECRET_OLD_STRING',
              },
              output: 'SECRET_TOOL_OUTPUT',
              title: 'SECRET_TOOL_TITLE',
              metadata: { secret: 'SECRET_STATE_METADATA' },
              time: { start: 10, end: 20 },
              attachments: [
                {
                  id: 'part_file',
                  sessionID: 'ses_org',
                  messageID: 'msg_2',
                  type: 'file',
                  mime: 'text/plain',
                  filename: 'secret.txt',
                  url: 'data:SECRET_FILE',
                },
              ],
            },
          },
          {
            id: 'part_4',
            sessionID: 'ses_org',
            messageID: 'msg_2',
            type: 'reasoning',
            text: 'SECRET_REASONING',
            time: { start: 21, end: 22 },
          },
          {
            id: 'part_5',
            sessionID: 'ses_org',
            messageID: 'msg_2',
            type: 'file',
            mime: 'image/png',
            filename: 'secret.png',
            url: 'data:SECRET_FILE_URL',
          },
          {
            id: 'part_6',
            sessionID: 'ses_org',
            messageID: 'msg_2',
            type: 'tool',
            callID: 'call_plan',
            tool: 'plan_enter',
            state: {
              status: 'completed',
              input: {},
              output: 'SECRET_PLAN_OUTPUT',
              title: '',
              metadata: {},
              time: { start: 23, end: 24 },
            },
          },
          {
            id: 'part_7',
            sessionID: 'ses_org',
            messageID: 'msg_2',
            type: 'text',
            text: 'Initializing snapshot',
            synthetic: true,
          },
          {
            id: 'part_8',
            sessionID: 'ses_org',
            messageID: 'msg_2',
            type: 'step-start',
          },
          {
            id: 'part_9',
            sessionID: 'ses_org',
            messageID: 'msg_2',
            type: 'tool',
            callID: 'call_2',
            tool: 'bash',
            state: {
              status: 'error',
              input: { command: 'npm test', output: 'SECRET_COMMAND_OUTPUT' },
              error: 'command failed',
              time: { start: 30, end: 40 },
            },
          },
        ],
      },
    ],
  });
  const result = await getWebhookRequestLogs(undefined, 'org-id', 'trigger', requestId);
  if (!result.transcript || result.transcript.version !== 'v2') {
    throw new Error('Expected a v2 transcript');
  }

  expect(result.transcript.messages).toHaveLength(2);
  expect(result.transcript.messages[0]?.parts).toEqual([
    expect.objectContaining({ type: 'text', text: 'prompt' }),
  ]);
  expect(result.transcript.messages[1]?.parts).toEqual([
    expect.objectContaining({ type: 'text', text: 'Reading' }),
    expect.objectContaining({
      type: 'tool',
      tool: 'read',
      state: expect.objectContaining({
        status: 'completed',
        input: { filePath: 'src/index.ts' },
        output: '',
        title: '',
        metadata: {},
        time: { start: 10, end: 20 },
      }),
    }),
    expect.objectContaining({
      type: 'tool',
      tool: 'bash',
      state: expect.objectContaining({
        status: 'error',
        input: { command: 'npm test' },
        error: 'command failed',
        time: { start: 30, end: 40 },
      }),
    }),
  ]);
  expect(result.transcript.messages[1]?.info).toMatchObject({
    role: 'assistant',
    path: { cwd: '', root: '' },
    error: { name: 'UnknownError', data: { message: 'message error' } },
  });
  const serialized = JSON.stringify(result.transcript);
  expect(serialized).not.toContain('SECRET_');
  expect(serialized).not.toContain('/secret/');
  expect(serialized).not.toContain('Initializing snapshot');
  expect(result.logs).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ message: 'prompt' }),
      expect.objectContaining({ message: 'Tool: read', content: 'src/index.ts' }),
      expect.objectContaining({ message: 'Tool: bash — error', content: 'command failed' }),
    ])
  );
});

it.each(['v1', 'v2'])('returns empty for ambiguous %s session matches', async version => {
  if (version === 'v2') mockLimit.mockResolvedValueOnce([]);
  mockLimit.mockResolvedValueOnce([{}, {}]);
  const result = await readLogs();
  expect(result.logsReady).toBe(false);
  expect(result.transcript).toBeNull();
  expect(getBlobContent).not.toHaveBeenCalled();
  expect(fetchSessionSnapshot).not.toHaveBeenCalled();
});

it('returns empty when the v2 snapshot is not ready', async () => {
  mockLimit
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ sessionId: 'ses_123', userId: 'owner' }]);
  jest.mocked(fetchSessionSnapshot).mockResolvedValue(null);
  const result = await readLogs();
  expect(result.logsReady).toBe(false);
  expect(result.transcript).toBeNull();
});

it('returns empty when a v1 blob is missing', async () => {
  mockLimit.mockResolvedValueOnce([{ blobUrl: 'missing' }]);
  jest
    .mocked(getBlobContent)
    .mockRejectedValue(Object.assign(new Error('missing'), { name: 'NoSuchKey' }));
  const result = await readLogs();
  expect(result.logsReady).toBe(false);
  expect(result.transcript).toBeNull();
});
