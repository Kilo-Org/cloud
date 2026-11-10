/**
 * @jest-environment node
 *
 * Heartbeat rows come from the worker without organization metadata. The
 * enrichment query must therefore decide access after fetching the row:
 * dropping the row while it is still live would leave the mapper to treat a
 * missing join as a personal session.
 */
/* eslint-disable import/first -- the fakes must be installed before the module under test loads */

const enrichmentRows = [
  {
    session_id: 'former-org',
    organization_id: 'org-former',
    organization_is_accessible: false,
  },
  {
    session_id: 'personal',
    organization_id: null,
    organization_is_accessible: true,
  },
  {
    session_id: 'active-org',
    organization_id: 'org-active',
    organization_is_accessible: true,
  },
].map(row => ({
  created_on_platform: null,
  created_at: '2026-09-22T09:00:00.000Z',
  updated_at: '2026-09-22T09:30:00.000Z',
  status: 'busy',
  title: `Title ${row.session_id}`,
  git_url: null,
  last_activity_at: null,
  status_updated_at: null as string | null,
  total_cost_microdollars: null,
  session_pr_platform: null,
  session_pr_url: null,
  session_pr_number: null,
  session_pr_verified_at: null,
  pr_url: null,
  pr_number: null,
  pr_state: null,
  pr_title: null,
  pr_head_sha: null,
  pr_last_synced_at: null,
  pr_review_decision: null,
  review_decision_pending: null,
  ...row,
}));

const liveSessions = ['former-org', 'personal', 'active-org', 'unattributed'].map(id => ({
  id,
  status: 'busy',
  title: `Live ${id}`,
  connectionId: 'cli',
}));

const where = jest.fn(async () => enrichmentRows);
const chain = {
  from: jest.fn((): unknown => chain),
  leftJoin: jest.fn((): unknown => chain),
  where,
};
const selectMock = jest.fn((): unknown => chain);
const dbMock = { select: selectMock };

jest.mock('@kilocode/web-shared/lib/drizzle', () => ({
  get db() {
    return dbMock;
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
    json: async () => ({
      sessions: liveSessions,
    }),
  })),
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
  selectMock.mockClear();
  chain.from.mockClear();
  chain.leftJoin.mockClear();
  where.mockClear();
  for (const session of liveSessions) {
    session.status = 'busy';
  }
});

describe('listActiveSessions heartbeat enrichment', () => {
  it('drops former-organization rows while keeping personal, accessible, and unattributed rows', async () => {
    const result = await listActiveSessions({
      userId: 'user-1',
      organizationId: undefined,
      includeCloudAgentSessions: false,
    });

    expect(result.sessions.map(session => session.id).sort()).toEqual([
      'active-org',
      'personal',
      'unattributed',
    ]);
    const byId = new Map(result.sessions.map(session => [session.id, session]));
    expect(byId.get('personal')?.organizationId).toBeNull();
    expect(byId.get('active-org')?.organizationId).toBe('org-active');
    expect(byId.get('unattributed')?.organizationId).toBeNull();
    expect(byId.has('former-org')).toBe(false);
  });

  it.each([
    ['question', 'idle'],
    ['question', 'busy'],
    ['permission', 'idle'],
    ['permission', 'busy'],
  ])(
    'omits an earlier timestamp for live %s ahead of stored %s',
    async (liveStatus, storedStatus) => {
      liveSessions.forEach(session => {
        session.status = liveStatus;
      });
      where.mockResolvedValueOnce(
        enrichmentRows.map(row => ({
          ...row,
          status: storedStatus,
          status_updated_at: '2026-09-22 09:15:00+00',
        }))
      );

      const result = await listActiveSessions({
        userId: 'user-1',
        organizationId: undefined,
        includeCloudAgentSessions: false,
      });

      expect(result.sessions.find(session => session.id === 'personal')).toMatchObject({
        status: liveStatus,
      });
      expect(result.sessions.find(session => session.id === 'personal')).not.toHaveProperty(
        'statusUpdatedAt'
      );
    }
  );

  it.each(['question', 'permission', 'busy'])(
    'keeps the dated stored %s status when it remains the resolved status',
    async storedStatus => {
      where.mockResolvedValueOnce(
        enrichmentRows.map(row => ({
          ...row,
          status: storedStatus,
          status_updated_at: '2026-09-22 09:15:00+00',
        }))
      );

      const result = await listActiveSessions({
        userId: 'user-1',
        organizationId: undefined,
        includeCloudAgentSessions: false,
      });

      expect(result.sessions.find(session => session.id === 'personal')).toMatchObject({
        status: storedStatus,
        statusUpdatedAt: '2026-09-22T09:15:00.000Z',
      });
    }
  );
});
