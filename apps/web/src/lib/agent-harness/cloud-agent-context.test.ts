import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  caller,
  fixture,
  invocation,
  message,
  org,
  reference,
  sessionId,
  userId,
} from './cloud-agent-test-fixture';
import type * as Context from './cloud-agent-context';
import type * as SessionIngest from '@/lib/session-ingest-client';

jest.mock('@/lib/config.server', () => ({
  SESSION_INGEST_WORKER_URL: 'https://ingest.test.example.com',
}));
jest.mock('@/lib/tokens', () => ({ generateInternalServiceToken: () => 'mock-jwt-token' }));
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));

// The repository transformer does not hoist mocks.
const { createHarnessCloudAgentContext } =
  jest.requireActual<typeof Context>('./cloud-agent-context');
const { fetchSessionMessagesPage } = jest.requireActual<typeof SessionIngest>(
  '@/lib/session-ingest-client'
);
const cases = [
  ['search', { query: 'scope' }],
  ['attach', reference],
  ['progress', reference],
] as const;
const invoke = async (name: (typeof cases)[number][0], args: unknown) => {
  const context = createHarnessCloudAgentContext(`kilo.sessions.${name}`, invocation(name, args));
  return context[name === 'attach' ? 'attachContext' : name]();
};
describe.each([null, org])('authorized Cloud Agent context %s', scope => {
  beforeEach(() => {
    fixture.organizationId = fixture.sessionScope = scope;
  });
  it.each(cases)(
    'returns bounded private %s output and real session linkage',
    async (name, args) => {
      const output =
        name === 'search'
          ? Array.from({ length: 20 }, () => ({ sessionId, title: fixture.text }))
          : name === 'attach'
            ? {
                ...reference,
                untrusted: true,
                messages: Array.from({ length: 20 }, () => ({
                  role: 'user',
                  content: fixture.text,
                })),
              }
            : { ...reference, status: 'running' };
      expect(await invoke(name, args)).toEqual({ status: 'succeeded', output });
    }
  );
  it('bounds history before decoding discarded non-text parts', async () => {
    const part = { sessionID: sessionId, messageID: 'msg_bounded' };
    const response = (url: string) =>
      Response.json({
        success: true,
        kiloSessionId: sessionId,
        history: {
          messages: [
            {
              info: {
                id: part.messageID,
                sessionID: sessionId,
                role: 'user',
                time: { created: 1761000000100 },
                agent: 'build',
                model: { providerID: 'openrouter', modelID: 'test-model' },
              },
              parts: [
                { ...part, id: 'prt_text', type: 'text', text: 'short context' },
                { ...part, id: 'prt_file', type: 'file', mime: 'text/plain', url },
              ],
            },
          ],
          nextCursor: 'older-history',
          omittedItemCount: 0,
        },
      });
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response('data:text/plain,small'))
      .mockResolvedValueOnce(response(`data:text/plain,${'x'.repeat(1_048_576)}`));
    const read = jest
      .spyOn(caller.cliSessionsV2, 'getSessionMessagesPage')
      .mockImplementation(async input => {
        const page = await fetchSessionMessagesPage(sessionId, userId, input);
        return page as Awaited<ReturnType<typeof caller.cliSessionsV2.getSessionMessagesPage>>;
      });
    expect(await invoke('attach', reference)).toEqual({
      status: 'succeeded',
      output: {
        ...reference,
        untrusted: true,
        messages: [{ role: 'user', content: 'short context' }],
      },
    });
    const decode = jest.spyOn(TextDecoder.prototype, 'decode');
    await expect(invoke('attach', reference)).rejects.toThrow('size limit');
    expect(decode).not.toHaveBeenCalled();
    expect(read).toHaveBeenNthCalledWith(2, { session_id: sessionId, limit: 20, bounded: true });
  });
  it.each(cases)('denies removed access for %s', async (name, args) => {
    fixture.revoked = true;
    await expect(invoke(name, args)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it.each(['attach', 'progress'] as const)('rejects a context mismatch for %s', async name => {
    fixture.sessionScope = scope === null ? org : null;
    await expect(invoke(name, reference)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it.each(['attach', 'progress'] as const)(
    'rechecks the grant after session lookup for %s',
    async name => {
      const get = caller.cliSessionsV2.get;
      jest.spyOn(caller.cliSessionsV2, 'get').mockImplementationOnce(async input => {
        const session = await get(input);
        fixture.grantRevoked = true;
        return session;
      });
      await expect(invoke(name, reference)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
  );
  it.each(cases)('retries %s without treating an outage as empty', async (name, args) => {
    const cloud = scope === null ? caller.cloudAgentNext : caller.organizations.cloudAgentNext;
    const read =
      name === 'search'
        ? jest.spyOn(caller.cliSessionsV2, 'search')
        : name === 'attach'
          ? jest.spyOn(caller.cliSessionsV2, 'getSessionMessagesPage')
          : jest.spyOn(cloud, 'getSession');
    read.mockRejectedValueOnce(new TRPCError({ code: 'SERVICE_UNAVAILABLE' }));
    await expect(invoke(name, args)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    expect(await invoke(name, args)).toMatchObject({ status: 'succeeded' });
  });
});
it('keeps empty search, history, and idle progress honest', async () => {
  fixture.hideEvidence = true;
  expect(await invoke('search', { query: 'absent' })).toEqual({ status: 'succeeded', output: [] });
  expect(await invoke('attach', reference)).toEqual({
    status: 'succeeded',
    output: { ...reference, untrusted: true, messages: [] },
  });
  expect(await invoke('progress', reference)).toEqual({
    status: 'succeeded',
    output: { ...reference, status: 'idle' },
  });
});
it.each([
  ['retryable_failure', 'SERVICE_UNAVAILABLE'],
  ['too_large', 'PAYLOAD_TOO_LARGE'],
  ['invalid_data', 'UNPROCESSABLE_CONTENT'],
])('preserves history failure %s', async (kind, code) => {
  fixture.historyKind = kind;
  await expect(invoke('attach', reference)).rejects.toMatchObject({ code });
});
it.each(['page', 'message'])('denies mismatched attachment %s identity', async level => {
  if (level === 'page') fixture.pageSessionId = 'another-session';
  else fixture.messages[0].info.sessionID = 'another-session';
  await expect(invoke('attach', reference)).rejects.toMatchObject({ code: 'FORBIDDEN' });
});
it('rejects model-supplied scope and bounds UTF-8 input and output', async () => {
  await expect(invoke('attach', { ...reference, organizationId: org })).rejects.toBeInstanceOf(
    z.ZodError
  );
  fixture.text = '界'.repeat(22_000);
  fixture.messages = [message('msg_large', fixture.text)];
  for (const [name, args] of [...cases, ['search', { query: fixture.text }]] as const) {
    if (name !== 'progress')
      await expect(invoke(name, args)).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
  }
});
it('keeps replay identity stable without colliding across dispatches or inputs', () => {
  const input = invocation('continue', { ...reference, message: 'one' });
  const identity = (value: unknown) => createHarnessCloudAgentContext('token', value).messageId;
  expect(identity(input)).toBe(identity({ ...input, arguments: { message: 'one', ...reference } }));
  for (const change of [
    { operationId: org },
    { conversationId: org },
    { arguments: { ...reference, message: 'two' } },
  ])
    expect(identity({ ...input, ...change })).not.toBe(identity(input));
});
