/**
 * @jest-environment node
 *
 * The non-OK branch must report the failed upstream call by status alone: the
 * session-ingest response body is unclassified upstream text, so reading it
 * into the server log is never part of the failure report.
 */
/* eslint-disable import/first -- the fakes must be installed before the module under test loads */

const bodyText = jest.fn(async () => 'upstream failure detail');
const mockFetchWithinBudget = jest.fn(async () => ({
  ok: false,
  status: 503,
  statusText: 'Service Unavailable',
  json: async () => ({}),
  text: bodyText,
}));

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  SESSION_INGEST_WORKER_URL: 'https://session-ingest.test',
}));

jest.mock('@kilocode/web-shared/lib/tokens', () => ({
  generateBoundedInternalServiceToken: () => 'test-token',
}));

jest.mock('@/lib/bounded-service-fetch', () => ({
  fetchWithinBudget: () => mockFetchWithinBudget(),
}));

jest.mock('@kilocode/web-shared/lib/drizzle', () => ({
  db: {
    select: () => {
      throw new Error('the failure branch must not fall through to a database read');
    },
  },
}));

jest.mock('@/routers/cli-sessions-v2-router', () => {
  const { z } = jest.requireActual('zod');
  return {
    associatedPrSchema: z.object({}).passthrough(),
    formatAssociatedPr: () => null,
    sessionPrJoinPredicate: undefined,
  };
});

import { listActiveSessions } from './active-sessions-list';

beforeEach(() => {
  bodyText.mockClear();
  mockFetchWithinBudget.mockClear();
});

describe('listActiveSessions upstream failure', () => {
  it('logs the status line only and never reads the response body', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await listActiveSessions({
      userId: 'user-1',
      organizationId: undefined,
      includeCloudAgentSessions: false,
    });

    expect(result).toEqual({ sessions: [] });
    expect(warn).toHaveBeenCalledTimes(1);
    const call = warn.mock.calls[0];
    expect(call).toHaveLength(1);
    expect(call[0]).toBe('[active-sessions] fetch failed: 503 Service Unavailable');
    expect(bodyText).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
