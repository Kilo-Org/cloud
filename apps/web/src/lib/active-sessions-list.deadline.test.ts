/**
 * @jest-environment node
 *
 * Every phase of an active-sessions answer shares one budget. A Postgres read
 * that never settles used to hold the whole request open past the point where
 * the caller could still use the answer, and the request then died without a
 * response body. The answer must instead degrade to what it already has.
 */
/* eslint-disable import/first -- the fakes must be installed before the module under test loads */

const liveSessions = [{ id: 'live-1', status: 'busy', title: 'Live', connectionId: 'cli' }];

const where = jest.fn(() => new Promise<never>(() => {}));
const chain: Record<string, jest.Mock> = {
  from: jest.fn((): unknown => chain),
  leftJoinLateral: jest.fn((): unknown => chain),
  where,
};
const selectMock = jest.fn((): unknown => chain);

jest.mock('@kilocode/web-shared/lib/drizzle', () => ({
  get db() {
    return { select: selectMock };
  },
}));

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  SESSION_INGEST_WORKER_URL: 'https://session-ingest.test',
}));

jest.mock('@kilocode/web-shared/lib/tokens', () => ({
  generateBoundedInternalServiceToken: () => 'test-token',
}));

jest.mock('@/lib/bounded-service-fetch', () => ({
  fetchWithinBudget: jest.fn(async () => ({
    ok: true,
    json: async () => ({ sessions: liveSessions }),
  })),
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

beforeEach(() => {
  selectMock.mockClear();
  where.mockClear();
});

describe('listActiveSessions budgets', () => {
  it('answers the heartbeat rows instead of waiting for a stalled enrichment read', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const pending = listActiveSessions({
        userId: 'user-1',
        organizationId: undefined,
        includeCloudAgentSessions: false,
      });
      await jest.advanceTimersByTimeAsync(8_000);

      await expect(pending).resolves.toEqual({ sessions: liveSessions });
      expect(warn).toHaveBeenCalledWith(
        '[active-sessions] enrichment db query failed:',
        expect.anything()
      );
    } finally {
      warn.mockRestore();
      jest.useRealTimers();
    }
  });

  it('answers the rows it has when the cloud-candidate read never settles', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const pending = listActiveSessions({
        userId: 'user-1',
        organizationId: undefined,
        includeCloudAgentSessions: true,
      });
      await jest.advanceTimersByTimeAsync(8_000);

      await expect(pending).resolves.toEqual({ sessions: liveSessions });
    } finally {
      warn.mockRestore();
      jest.useRealTimers();
    }
  });

  it('reports a stalled merge as retryable for an organization-filtered caller', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const pending = listActiveSessions({
        userId: 'user-1',
        organizationId: '123e4567-e89b-42d3-a456-426614174000',
        includeCloudAgentSessions: false,
      });
      const assertion = expect(pending).rejects.toMatchObject({
        code: 'SERVICE_UNAVAILABLE',
        message: 'Active sessions took too long to resolve',
      });
      await jest.advanceTimersByTimeAsync(8_000);
      await assertion;
    } finally {
      warn.mockRestore();
      jest.useRealTimers();
    }
  });
});
