import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import {
  cli_sessions_v2,
  cloud_agent_worktrees,
  organization_memberships,
  organizations,
  type CliSessionV2,
  type NewCliSessionV2,
  type User,
} from '@kilocode/db/schema';
import { TRPCClientError } from '@trpc/client';
import { and, eq, inArray } from 'drizzle-orm';
import type { createCallerForUser as createCallerForUserType } from './test-utils';

const UUID = '12345678-1234-4234-9234-123456789abc';
const PARENT_UUID = '87654321-4321-4321-8321-cba987654321';
const ORGANIZATION_ID = '9a283302-b75d-4375-a1ba-e319a02e18b7';
const OTHER_ORGANIZATION_ID = '4a283302-b75d-4375-a1ba-e319a02e18b7';
const USER_ID = 'oauth/github|worktree-parent-owner';
const OTHER_USER_ID = 'oauth/github|worktree-parent-other';
const ANCHOR_KILO_SESSION_ID = 'ses_anchor_parent_navigation_1';
const PARENT_KILO_SESSION_ID = 'ses_parent_navigation_1';
const ANCHOR_SESSION_ID = `workspace_${UUID}`;
const PARENT_SESSION_ID = `workspace_${PARENT_UUID}`;
const WORKTREE_ID = `worktree_${UUID}`;
const PARENT_WORKTREE_ID = `worktree_${PARENT_UUID}`;
const INITIAL_TIME = '2026-08-26T00:00:00.000Z';

const mockGetSession = jest.fn<(sessionId: string) => Promise<Record<string, unknown>>>();

jest.mock('@/lib/cloud-agent-next/cloud-agent-client', () => ({
  createCloudAgentNextClient: jest.fn(() => ({ getSession: mockGetSession })),
  rethrowCloudAgentError: jest.fn(),
  InsufficientCreditsError: class InsufficientCreditsError extends Error {},
}));

jest.mock('@/lib/auth/resource-delegation', () => ({
  createControlTokenForRequest: jest.fn(async () => ({ token: 'cloud-agent-control-token' })),
}));

jest.mock('@kilocode/web-shared/lib/tokens', () => {
  const actual: Record<string, unknown> = jest.requireActual('@kilocode/web-shared/lib/tokens');
  return {
    ...actual,
    generateApiToken: jest.fn(() => 'api-token'),
  };
});

jest.mock('next/server', () => {
  const actual: Record<string, unknown> = jest.requireActual('next/server');
  return {
    ...actual,
    after: jest.fn(),
  };
});

jest.mock('@/lib/cloud-agent/session-events', () => ({
  notifyCliSessionRenamed: jest.fn(),
}));

jest.mock('@sentry/nextjs', () => {
  const actual: Record<string, unknown> = jest.requireActual('@sentry/nextjs');
  return {
    ...actual,
    captureException: jest.fn(),
  };
});

const baseSession: CliSessionV2 = {
  session_id: ANCHOR_KILO_SESSION_ID,
  kilo_user_id: USER_ID,
  version: 0,
  title: 'Anchor',
  public_id: null,
  parent_session_id: null,
  organization_id: null,
  cloud_agent_session_id: ANCHOR_SESSION_ID,
  profile_id: null,
  cloud_agent_session_scope_id: null,
  cloud_agent_worktree_id: WORKTREE_ID,
  created_on_platform: 'cloud-agent-web',
  chat_kind: 'user',
  maintenance_watch_id: null,
  maintenance_attempt_id: null,
  git_url: null,
  git_branch: null,
  platform: null,
  pr_url: null,
  pr_number: null,
  pr_head_ref: null,
  pr_head_sha: null,
  pr_link_verified_at: null,
  status: null,
  status_updated_at: null,
  status_transition_id: null,
  last_activity_at: null,
  total_cost_microdollars: null,
  live_summary: null,
  briefing_excerpt: null,
  briefing_excerpt_scope_changed_at: null,
  created_at: INITIAL_TIME,
  updated_at: INITIAL_TIME,
};

function makeSession(overrides: Partial<NewCliSessionV2> = {}): NewCliSessionV2 {
  return { ...baseSession, ...overrides };
}

async function insertAnchor(overrides: Partial<NewCliSessionV2> = {}) {
  await db.insert(cli_sessions_v2).values(makeSession(overrides));
}

async function insertParent(overrides: Partial<NewCliSessionV2> = {}) {
  await db.insert(cli_sessions_v2).values(
    makeSession({
      session_id: PARENT_KILO_SESSION_ID,
      title: 'Parent chat',
      cloud_agent_session_id: PARENT_SESSION_ID,
      cloud_agent_worktree_id: null,
      ...overrides,
    })
  );
}

async function insertWorktree(overrides: {
  worktreeId: string;
  userId?: string;
  organizationId?: string | null;
  name?: string | null;
  deletionStartedAt?: string | null;
  deletionCompletedAt?: string | null;
}) {
  await db.insert(cloud_agent_worktrees).values({
    worktree_id: overrides.worktreeId,
    kilo_user_id: overrides.userId ?? USER_ID,
    organization_id: overrides.organizationId ?? null,
    name: overrides.name ?? null,
    created_at: INITIAL_TIME,
    deletion_started_at: overrides.deletionStartedAt ?? null,
    deletion_completed_at: overrides.deletionCompletedAt ?? null,
  });
}

function trpcFailure(code: 'FORBIDDEN' | 'NOT_FOUND') {
  return new TRPCClientError(code === 'FORBIDDEN' ? 'denied' : 'missing', {
    result: {
      error: {
        code: -32000,
        message: code,
        data: { code, httpStatus: code === 'FORBIDDEN' ? 403 : 404 },
      },
    },
  });
}

let createCallerForUser: typeof createCallerForUserType;
let user: User;

beforeAll(async () => {
  createCallerForUser = (await import('./test-utils')).createCallerForUser;
  user = await insertTestUser({
    id: USER_ID,
    google_user_email: 'worktree-parent-owner@example.com',
    google_user_name: 'Worktree Parent Owner',
    is_admin: false,
  });
  await insertTestUser({
    id: OTHER_USER_ID,
    google_user_email: 'worktree-parent-other@example.com',
    google_user_name: 'Worktree Parent Other',
    is_admin: false,
  });
  await db.insert(organizations).values([
    { id: ORGANIZATION_ID, name: 'Worktree parent org', created_by_kilo_user_id: user.id },
    {
      id: OTHER_ORGANIZATION_ID,
      name: 'Other worktree parent org',
      created_by_kilo_user_id: user.id,
    },
  ]);
}, 30_000);

beforeEach(async () => {
  jest.clearAllMocks();
  const userIds = [USER_ID, OTHER_USER_ID];
  await db.delete(cli_sessions_v2).where(inArray(cli_sessions_v2.kilo_user_id, userIds));
  await db
    .delete(cloud_agent_worktrees)
    .where(inArray(cloud_agent_worktrees.kilo_user_id, userIds));
  await db
    .delete(organization_memberships)
    .where(inArray(organization_memberships.kilo_user_id, userIds));
  await db.insert(organization_memberships).values([
    { kilo_user_id: USER_ID, organization_id: ORGANIZATION_ID, role: 'member' },
    { kilo_user_id: USER_ID, organization_id: OTHER_ORGANIZATION_ID, role: 'member' },
    { kilo_user_id: OTHER_USER_ID, organization_id: ORGANIZATION_ID, role: 'member' },
  ]);
  mockGetSession.mockReset().mockResolvedValue({ parentCloudAgentSessionId: PARENT_SESSION_ID });
});

describe('cliSessionsV2.worktreeParent', () => {
  it('returns the canonical parent for a personal worktree', async () => {
    await insertAnchor();
    await insertParent();

    const caller = await createCallerForUser(USER_ID);
    const result = await caller.cliSessionsV2.worktreeParent({
      worktreeId: WORKTREE_ID,
      organizationId: null,
    });

    expect(result).toEqual({
      session_id: PARENT_KILO_SESSION_ID,
      title: 'Parent chat',
      organization_id: null,
    });
    expect(mockGetSession).toHaveBeenCalledWith(ANCHOR_SESSION_ID);
  });

  it('returns an organization parent only within the exact organization', async () => {
    await insertAnchor({ organization_id: ORGANIZATION_ID });
    await insertParent({ organization_id: ORGANIZATION_ID });

    const caller = await createCallerForUser(USER_ID);
    const result = await caller.cliSessionsV2.worktreeParent({
      worktreeId: WORKTREE_ID,
      organizationId: ORGANIZATION_ID,
    });

    expect(result).toEqual({
      session_id: PARENT_KILO_SESSION_ID,
      title: 'Parent chat',
      organization_id: ORGANIZATION_ID,
    });
  });

  it('rejects a caller whose organization membership was removed before any Worker read', async () => {
    await db
      .delete(organization_memberships)
      .where(
        and(
          eq(organization_memberships.kilo_user_id, USER_ID),
          eq(organization_memberships.organization_id, ORGANIZATION_ID)
        )
      );

    const caller = await createCallerForUser(USER_ID);
    await expect(
      caller.cliSessionsV2.worktreeParent({
        worktreeId: WORKTREE_ID,
        organizationId: ORGANIZATION_ID,
      })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  it('returns null for a worktree owned by another user', async () => {
    await insertAnchor({ kilo_user_id: OTHER_USER_ID });
    await insertParent({ kilo_user_id: OTHER_USER_ID });

    const caller = await createCallerForUser(USER_ID);
    await expect(
      caller.cliSessionsV2.worktreeParent({ worktreeId: WORKTREE_ID, organizationId: null })
    ).resolves.toBeNull();
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  it('returns null when the anchor belongs to a different organization scope', async () => {
    await insertAnchor({ organization_id: ORGANIZATION_ID });
    await insertParent({ organization_id: ORGANIZATION_ID });

    const caller = await createCallerForUser(USER_ID);
    await expect(
      caller.cliSessionsV2.worktreeParent({
        worktreeId: WORKTREE_ID,
        organizationId: OTHER_ORGANIZATION_ID,
      })
    ).resolves.toBeNull();
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  it('returns null without a Worker read when the anchor row is missing', async () => {
    await insertParent();

    const caller = await createCallerForUser(USER_ID);
    await expect(
      caller.cliSessionsV2.worktreeParent({ worktreeId: WORKTREE_ID, organizationId: null })
    ).resolves.toBeNull();
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  it.each([
    [null, ORGANIZATION_ID],
    [ORGANIZATION_ID, OTHER_ORGANIZATION_ID],
  ])(
    'does not expose a parent from another organization scope: %s to %s',
    async (scope, parentScope) => {
      await insertAnchor({ organization_id: scope });
      await insertParent({ organization_id: parentScope });

      const caller = await createCallerForUser(USER_ID);
      await expect(
        caller.cliSessionsV2.worktreeParent({ worktreeId: WORKTREE_ID, organizationId: scope })
      ).resolves.toBeNull();
      expect(mockGetSession).toHaveBeenCalledWith(ANCHOR_SESSION_ID);
    }
  );

  it('does not expose a parent owned by another user', async () => {
    await insertAnchor();
    await insertParent({ kilo_user_id: OTHER_USER_ID });

    const caller = await createCallerForUser(USER_ID);
    await expect(
      caller.cliSessionsV2.worktreeParent({ worktreeId: WORKTREE_ID, organizationId: null })
    ).resolves.toBeNull();
  });

  it('hides the link when the parent root chat was deleted', async () => {
    await insertAnchor();

    const caller = await createCallerForUser(USER_ID);
    await expect(
      caller.cliSessionsV2.worktreeParent({ worktreeId: WORKTREE_ID, organizationId: null })
    ).resolves.toBeNull();
  });

  it('returns null without a Worker read while the worktree is being deleted', async () => {
    await insertAnchor();
    await insertParent();
    await insertWorktree({ worktreeId: WORKTREE_ID, deletionStartedAt: INITIAL_TIME });

    const caller = await createCallerForUser(USER_ID);
    await expect(
      caller.cliSessionsV2.worktreeParent({ worktreeId: WORKTREE_ID, organizationId: null })
    ).resolves.toBeNull();
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  it('returns null when the parent worktree is being deleted', async () => {
    await insertAnchor();
    await insertParent({ cloud_agent_worktree_id: PARENT_WORKTREE_ID });
    await insertWorktree({ worktreeId: PARENT_WORKTREE_ID, deletionStartedAt: INITIAL_TIME });

    const caller = await createCallerForUser(USER_ID);
    await expect(
      caller.cliSessionsV2.worktreeParent({ worktreeId: WORKTREE_ID, organizationId: null })
    ).resolves.toBeNull();
  });

  it.each(['FORBIDDEN', 'NOT_FOUND'] as const)(
    'returns null when the Worker reports %s',
    async code => {
      await insertAnchor();
      await insertParent();
      mockGetSession.mockRejectedValueOnce(trpcFailure(code));

      const caller = await createCallerForUser(USER_ID);
      await expect(
        caller.cliSessionsV2.worktreeParent({ worktreeId: WORKTREE_ID, organizationId: null })
      ).resolves.toBeNull();
    }
  );

  it('rethrows transient Worker failures so the client can retry', async () => {
    await insertAnchor();
    await insertParent();
    mockGetSession.mockRejectedValueOnce(new Error('worker unavailable'));

    const caller = await createCallerForUser(USER_ID);
    await expect(
      caller.cliSessionsV2.worktreeParent({ worktreeId: WORKTREE_ID, organizationId: null })
    ).rejects.toThrow('worker unavailable');
  });

  it('prefers the parent worktree custom name over the parent chat title', async () => {
    await insertAnchor();
    await insertParent({ cloud_agent_worktree_id: PARENT_WORKTREE_ID });
    await insertWorktree({ worktreeId: PARENT_WORKTREE_ID, name: 'Authentication investigation' });

    const caller = await createCallerForUser(USER_ID);
    const result = await caller.cliSessionsV2.worktreeParent({
      worktreeId: WORKTREE_ID,
      organizationId: null,
    });

    expect(result).toEqual({
      session_id: PARENT_KILO_SESSION_ID,
      title: 'Authentication investigation',
      organization_id: null,
    });
  });

  it('returns null when the anchor has no parent lineage', async () => {
    await insertAnchor();
    await insertParent();
    mockGetSession.mockResolvedValueOnce({});

    const caller = await createCallerForUser(USER_ID);
    await expect(
      caller.cliSessionsV2.worktreeParent({ worktreeId: WORKTREE_ID, organizationId: null })
    ).resolves.toBeNull();
  });
});
