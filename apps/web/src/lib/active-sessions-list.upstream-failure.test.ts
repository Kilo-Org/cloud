/**
 * @jest-environment node
 *
 * The upstream failure branches must report the failed call as a retryable
 * outage — with or without the cloud-agent merge — instead of answering a bare
 * `{ sessions: [] }` that reads as "nothing runs".
 */
/* eslint-disable import/first -- the fakes must be installed before the module under test loads */

const bodyText = jest.fn(async () => 'upstream failure detail');
const cancelBody = jest.fn(async () => undefined);
const nonOkResponse = {
  ok: false,
  status: 503,
  statusText: 'Service Unavailable',
  json: async () => ({}),
  body: { cancel: cancelBody },
  text: bodyText,
};
const mockFetchWithinBudget = jest.fn<Promise<unknown>, []>(async () => nonOkResponse);

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  SESSION_INGEST_WORKER_URL: 'https://session-ingest.test',
}));

jest.mock('@/lib/auth/kilo-token-signing', () => ({
  generateBoundedInternalServiceToken: () => 'test-token',
}));

jest.mock('@/lib/bounded-service-fetch', () => ({
  ...jest.requireActual('@/lib/bounded-service-fetch'),
  fetchWithinBudget: () => mockFetchWithinBudget(),
}));

jest.mock('@kilocode/web-shared/lib/drizzle', () => ({
  db: {
    select: () => {
      throw new Error('the failure branch must not fall through to a database read');
    },
  },
}));

jest.mock('@/lib/session-associated-pr', () => {
  const { z } = jest.requireActual('zod');
  const actual = jest.requireActual('@/lib/session-associated-pr');
  return {
    sessionAssociatedPr: actual.sessionAssociatedPr,
    associatedPrSchema: z.object({}).passthrough(),
    formatAssociatedPr: () => null,
  };
});

import { listActiveSessions } from './active-sessions-list';

const unavailable = { code: 'SERVICE_UNAVAILABLE', message: 'Session ingest is unavailable' };

beforeEach(() => {
  bodyText.mockClear();
  cancelBody.mockClear();
  mockFetchWithinBudget.mockClear();
  mockFetchWithinBudget.mockImplementation(async () => nonOkResponse);
});

describe('listActiveSessions upstream failure', () => {
  it('reports a non-OK status as unavailable, logging the status line only', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = listActiveSessions({
      userId: 'user-1',
      organizationId: undefined,
      includeCloudAgentSessions: false,
    });

    await expect(result).rejects.toMatchObject(unavailable);
    expect(warn).toHaveBeenCalledTimes(1);
    const call = warn.mock.calls[0];
    expect(call).toHaveLength(1);
    expect(call[0]).toBe('[active-sessions] fetch failed: 503 Service Unavailable');
    expect(bodyText).not.toHaveBeenCalled();
    expect(cancelBody).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('reports a transport failure as unavailable', async () => {
    mockFetchWithinBudget.mockImplementation(() => Promise.reject(new Error('socket hang up')));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = listActiveSessions({
      userId: 'user-1',
      organizationId: undefined,
      includeCloudAgentSessions: false,
    });

    await expect(result).rejects.toMatchObject(unavailable);
    expect(warn).toHaveBeenCalledTimes(1);
    const call = warn.mock.calls[0];
    expect(call[0]).toBe('[active-sessions] error:');
    expect(call[1]).toBeInstanceOf(Error);
    expect((call[1] as Error).message).toBe('socket hang up');
    warn.mockRestore();
  });
});
