/**
 * @jest-environment node
 *
 * The cloud-candidate query must keep a hard ceiling. `livePredicate` only
 * time-bounds its warm-idle branch: an open `cloud_agent_session_runs` row with
 * no `terminal_at` keeps its session a candidate until the 90-day session
 * cascade, so a removed `LIMIT` left the tray's row count unbounded. The
 * ceiling is asserted against a capturing fake so the check needs no database.
 */
/* eslint-disable import/first -- the fake db must be installed before the module under test loads */

const limitMock = jest.fn();
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a chainable query-builder double
const chain: Record<string, jest.Mock> = {
  from: jest.fn((): unknown => chain),
  leftJoin: jest.fn((): unknown => chain),
  where: jest.fn((): unknown => chain),
  orderBy: jest.fn((): unknown => chain),
  limit: limitMock,
};
const selectMock = jest.fn((): unknown => chain);
const dbMock = { select: selectMock };

jest.mock('@/lib/drizzle', () => ({
  get db() {
    return dbMock;
  },
}));

// Undefined skips phase 1 (the worker fetch), leaving the cloud-candidate
// query as the only db read this test drives.
jest.mock('@/lib/config.server', () => ({
  SESSION_INGEST_WORKER_URL: undefined,
}));

jest.mock('@/lib/tokens', () => ({
  generateBoundedInternalServiceToken: () => 'test-token',
}));

jest.mock('@/routers/cli-sessions-v2-router', () => {
  const { z } = jest.requireActual('zod');
  return {
    associatedPrSchema: z.object({}).passthrough(),
    formatAssociatedPr: () => null,
    sessionPrJoinPredicate: undefined,
  };
});

import { CLOUD_AGENT_CANDIDATE_LIMIT, listActiveSessions } from './active-sessions-list';

beforeEach(() => {
  for (const method of ['from', 'leftJoin', 'where', 'orderBy']) {
    chain[method].mockClear();
  }
  selectMock.mockClear();
  limitMock.mockReset();
  limitMock.mockResolvedValue([]);
});

describe('listActiveSessions cloud candidates', () => {
  it('applies a hard ceiling far above the live-agent target', async () => {
    const result = await listActiveSessions({
      userId: 'user-1',
      organizationId: undefined,
      includeCloudAgentSessions: true,
    });

    expect(result).toEqual({ sessions: [] });
    // The cloud-candidate query is the only db read, and it is ordered
    // newest-first and then capped.
    expect(selectMock).toHaveBeenCalledTimes(1);
    expect(chain.orderBy).toHaveBeenCalledTimes(1);
    expect(limitMock).toHaveBeenCalledTimes(1);
    expect(limitMock).toHaveBeenCalledWith(CLOUD_AGENT_CANDIDATE_LIMIT);
    // The owner's target is 100 live agents; the ceiling may not drop one.
    expect(CLOUD_AGENT_CANDIDATE_LIMIT).toBeGreaterThan(100);
  });

  it('does not cap the query below the 60 live candidates the tray must show', async () => {
    const sixty = Array.from({ length: 60 }, (_value, index) => ({
      session_id: `session-${index}`,
      created_on_platform: null,
      created_at: '2026-09-22T09:00:00.000Z',
      updated_at: '2026-09-22T09:30:00.000Z',
      status: 'busy',
      title: `Session ${index}`,
      organization_id: null,
      git_url: null,
      git_branch: null,
      last_activity_at: null,
      status_updated_at: null,
      total_cost_microdollars: null,
      cloud_agent_session_id: `cas-${index}`,
      run_open: true,
      session_pr_platform: null,
      session_pr_url: null,
      session_pr_number: null,
      pr_url: null,
      pr_number: null,
      pr_state: null,
      pr_title: null,
      pr_head_sha: null,
      pr_last_synced_at: null,
      pr_review_decision: null,
      review_decision_pending: null,
    }));
    limitMock.mockResolvedValue(sixty);

    const result = await listActiveSessions({
      userId: 'user-1',
      organizationId: undefined,
      includeCloudAgentSessions: true,
    });

    expect(limitMock).toHaveBeenCalledWith(CLOUD_AGENT_CANDIDATE_LIMIT);
    expect(result.sessions).toHaveLength(60);
  });
});
