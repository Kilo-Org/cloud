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

/**
 * The session-ingest read's share of that budget
 * (`SESSION_INGEST_READ_BUDGET_MS` in the module under test), which covers the
 * response body as well as the headers.
 */
const READ_BUDGET_MS = 4_500;

const limitCalls = jest.fn();

/** Organization the filtered caller asks for; both fixture rows belong to it. */
const ORGANIZATION_ID = '123e4567-e89b-42d3-a456-426614174000';

/** One enriched `cli_sessions_v2` row for the heartbeat `live-1`. */
function enrichmentRow(): Record<string, unknown> {
  return {
    session_id: 'live-1',
    created_on_platform: 'cli',
    created_at: '2026-11-01T00:00:00.000Z',
    updated_at: '2026-11-01T00:05:00.000Z',
    status: null,
    title: null,
    organization_id: ORGANIZATION_ID,
    organization_is_accessible: true,
    git_url: null,
    last_activity_at: null,
    status_updated_at: null,
    total_cost_microdollars: null,
  };
}

/** One live cloud-agent candidate the answer merges after the heartbeat rows. */
function cloudCandidateRow(): Record<string, unknown> {
  return {
    session_id: 'cloud-1',
    created_on_platform: 'cloud',
    created_at: '2026-11-01T00:10:00.000Z',
    updated_at: '2026-11-01T00:20:00.000Z',
    status: 'busy',
    title: 'Cloud',
    organization_id: ORGANIZATION_ID,
    git_url: null,
    git_branch: null,
    last_activity_at: null,
    status_updated_at: null,
    total_cost_microdollars: null,
    cloud_agent_session_id: 'cas-1',
    run_open: true,
  };
}

/**
 * One fake Drizzle select chain. `rows` resolves the terminal await, `'stall'`
 * never settles, and `'fail'` rejects, so one phase can be stalled while the
 * other still settles. Every builder method — `orderBy`/`limit` included, as the
 * cloud query ends with them — returns the same thenable. `resolveAfterMs`
 * makes the read slow instead of instant, for tests that need one phase to
 * consume part of the answer's budget; fake timers drive that delay, so no
 * test waits on the real clock.
 */
function fakeQuery(outcome: unknown[] | 'stall' | 'fail', resolveAfterMs = 0): unknown {
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
    if (resolveAfterMs > 0) {
      setTimeout(() => resolve(outcome), resolveAfterMs);
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

const workerAnswer = () => ({ ok: true, json: async () => ({ sessions: liveSessions }) });
const mockFetchWithinBudget = jest.fn(async (_url: string, _init?: RequestInit, _deps?: object) =>
  workerAnswer()
);

jest.mock('@/lib/bounded-service-fetch', () => ({
  // The real body reader stays in place: the answer must bound the body read
  // as well as the fetch, so the tests drive it through the real helper.
  ...jest.requireActual('@/lib/bounded-service-fetch'),
  fetchWithinBudget: (url: string, init?: RequestInit, deps?: object) =>
    mockFetchWithinBudget(url, init, deps),
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
  mockFetchWithinBudget.mockClear();
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

  it('gives the cloud read its own time when the enrichment read is slow but inside the budget', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    try {
      // The enrichment read spends 6,500 ms of the 7,000 ms answer budget and
      // the cloud read answers in 1,500 ms. Read one after the other, the cloud
      // read would only have the 500 ms the enrichment left, expire before its
      // (fast) query answered, and degrade an organization-filtered answer to
      // SERVICE_UNAVAILABLE. Started together, both fit.
      const ENRICHMENT_DELAY_MS = 6_500;
      const CLOUD_DELAY_MS = 1_500;
      selectMock
        .mockReturnValueOnce(fakeQuery([enrichmentRow()], ENRICHMENT_DELAY_MS))
        .mockReturnValueOnce(fakeQuery([cloudCandidateRow()], CLOUD_DELAY_MS));

      const pending = listActiveSessions({
        userId: 'user-1',
        organizationId: ORGANIZATION_ID,
        includeCloudAgentSessions: true,
      });
      const { settled } = trackSettled(pending);

      await jest.advanceTimersByTimeAsync(ENRICHMENT_DELAY_MS - 1);
      expect(settled()).toBe(false);

      await jest.advanceTimersByTimeAsync(1);
      const { sessions } = await pending;
      expect(sessions.map(session => session.id)).toEqual(['live-1', 'cloud-1']);
      expect(sessions[0]).toMatchObject({ organizationId: ORGANIZATION_ID, title: 'Live' });
      expect(sessions[1]).toMatchObject({ connectionId: 'cloud-agent', status: 'busy' });
    } finally {
      jest.useRealTimers();
    }
  });

  it('answers a worker read whose body never arrives as retryable', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      // Headers arrived, the body never does. The read's own budget must end
      // the wait, or this answer hangs past the point the caller can use it.
      mockFetchWithinBudget.mockResolvedValueOnce({
        ok: true,
        json: () => new Promise<never>(() => {}),
      });
      selectMock.mockImplementation(() => fakeQuery([]));

      const pending = listActiveSessions({
        userId: 'user-1',
        organizationId: undefined,
        includeCloudAgentSessions: true,
      });
      const assertion = expect(pending).rejects.toMatchObject({
        code: 'SERVICE_UNAVAILABLE',
        message: 'Session ingest is unavailable',
      });
      const { settled } = trackSettled(pending);

      await jest.advanceTimersByTimeAsync(READ_BUDGET_MS - 1);
      expect(settled()).toBe(false);

      await jest.advanceTimersByTimeAsync(1);
      await assertion;
    } finally {
      warn.mockRestore();
      jest.useRealTimers();
    }
  });

  it('gives the body only what the headers left of the read budget', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      // Headers land 3,000 ms in, the body never does. The read must still end
      // the answer inside the read budget measured from the request, so the
      // boundary below is 4,500 ms and not 7,500: a body that took a fresh
      // READ_BUDGET_MS of its own would answer 3,000 ms after the headers.
      const HEADER_DELAY_MS = 3_000;
      mockFetchWithinBudget.mockImplementationOnce(async () => {
        await new Promise(resolve => setTimeout(resolve, HEADER_DELAY_MS));
        return { ok: true, json: () => new Promise<never>(() => {}) };
      });
      selectMock.mockImplementation(() => fakeQuery([]));

      const pending = listActiveSessions({
        userId: 'user-1',
        organizationId: undefined,
        includeCloudAgentSessions: true,
      });
      const assertion = expect(pending).rejects.toMatchObject({
        code: 'SERVICE_UNAVAILABLE',
        message: 'Session ingest is unavailable',
      });
      const { settled } = trackSettled(pending);

      await jest.advanceTimersByTimeAsync(READ_BUDGET_MS - 1);
      expect(settled()).toBe(false);

      await jest.advanceTimersByTimeAsync(1);
      await assertion;
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
