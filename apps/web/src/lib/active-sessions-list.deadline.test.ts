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

/**
 * The answer's own budget (`ACTIVE_SESSIONS_LIST_BUDGET_MS` in the module under
 * test). Restated here so the boundary assertions below read as the time the
 * caller actually waits.
 */
const ANSWER_BUDGET_MS = 7_000;

const limitCalls = jest.fn();

/**
 * One fake Drizzle select chain. `rows` resolves the terminal await, `'stall'`
 * never settles, and `'fail'` rejects, so one phase can be stalled while the
 * other still settles. Every builder method — `orderBy`/`limit` included, as the
 * cloud query ends with them — returns the same thenable.
 */
function fakeQuery(outcome: unknown[] | 'stall' | 'fail'): unknown {
  const query: Record<string, unknown> = {
    from: () => query,
    leftJoinLateral: () => query,
    where: () => query,
    orderBy: () => query,
    limit: () => {
      limitCalls();
      return query;
    },
  };
  query.then = (resolve: (value: unknown[]) => void, reject: (error: unknown) => void): void => {
    if (outcome === 'stall') return;
    if (outcome === 'fail') {
      reject(new Error('read failed'));
      return;
    }
    resolve(outcome);
  };
  return query;
}

const selectMock = jest.fn((): unknown => fakeQuery('stall'));

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

/**
 * Resolves once the answer settles, and says whether it had by then. A phase
 * that no budget bounds would leave this pending until the test times out,
 * which is the failure this file exists to catch.
 */
function trackSettled(pending: Promise<unknown>): { settled: () => boolean } {
  let settled = false;
  void pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  return { settled: () => settled };
}

beforeEach(() => {
  selectMock.mockReset();
  selectMock.mockImplementation(() => fakeQuery('stall'));
  limitCalls.mockClear();
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
      const { settled } = trackSettled(pending);

      await jest.advanceTimersByTimeAsync(ANSWER_BUDGET_MS - 1);
      expect(settled()).toBe(false);

      await jest.advanceTimersByTimeAsync(1);
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
      // The enrichment read fails fast, so the only phase left to end is the
      // cloud read's own stall. Its chain ends with `orderBy`/`limit`, which is
      // also what makes this the regression for a chain that threw instead of
      // waiting.
      selectMock.mockReturnValueOnce(fakeQuery('fail'));
      selectMock.mockImplementation(() => fakeQuery('stall'));

      const pending = listActiveSessions({
        userId: 'user-1',
        organizationId: undefined,
        includeCloudAgentSessions: true,
      });
      const { settled } = trackSettled(pending);

      await jest.advanceTimersByTimeAsync(ANSWER_BUDGET_MS - 1);
      expect(settled()).toBe(false);

      await jest.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toEqual({ sessions: liveSessions });
      expect(limitCalls).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        '[active-sessions] cloud candidates db query failed:',
        expect.anything()
      );
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
      const { settled } = trackSettled(pending);

      await jest.advanceTimersByTimeAsync(ANSWER_BUDGET_MS - 1);
      expect(settled()).toBe(false);

      await jest.advanceTimersByTimeAsync(1);
      await assertion;
    } finally {
      warn.mockRestore();
      jest.useRealTimers();
    }
  });
});
