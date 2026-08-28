import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { db } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import {
  cli_sessions_v2,
  cloud_agent_worktrees,
  github_branch_pull_requests,
  organization_memberships,
  organizations,
  type CliSessionV2,
  type NewCliSessionV2,
  type User,
} from '@kilocode/db/schema';
import type { CloudAgentWorktreeId } from '@kilocode/session-ingest-contracts';
import { TRPCClientError } from '@trpc/client';
import type * as TrpcServerModule from '@trpc/server';
import { and, eq, inArray, isNotNull, or } from 'drizzle-orm';
import type { TRPCContext } from '@/lib/trpc/init';
import type { cliSessionsV2Router } from './cli-sessions-v2-router';
import type {
  DeleteWorktreeInput,
  DeleteWorktreeOutput,
} from '@/lib/cloud-agent-next/cloud-agent-client';

const UUID = '12345678-1234-4234-9234-123456789abc';
const ORGANIZATION_ID = '9a283301-b75d-4375-a1ba-e319a02e18b7';
const OTHER_ORGANIZATION_ID = '4a283301-b75d-4375-a1ba-e319a02e18b7';
const SESSION_ID = 'ses_12345678901234567890123456';
const WORKSPACE_ID = `workspace_${UUID}`;
const WORKTREE_ID = `worktree_${UUID}` as const;
const USER_ID = 'oauth/github|worktree-owner';
const OTHER_USER_ID = 'oauth/github|other-worktree-owner';
const INITIAL_TIME = '2026-08-26T00:00:00.000Z';
const LATER_TIME = '2026-08-26T01:00:00.000Z';
const GIT_URL = 'https://github.com/worktree-tests/repository';
const BRANCH = 'feature/worktree';
const PR_URL = `${GIT_URL}/pull/42`;

const mockRuntimeDelete = jest.fn<(sessionId: string) => Promise<{ success: boolean }>>();
const mockWorktreeDelete = jest.fn<(input: DeleteWorktreeInput) => Promise<DeleteWorktreeOutput>>();
const mockGetRuntimeSession = jest.fn<(sessionId: string) => Promise<Record<string, unknown>>>();
const mockDeleteSessionIngest = jest.fn<(sessionId: string, userId: string) => Promise<void>>();
const mockFetchSessionSnapshot = jest.fn<() => Promise<null>>();
const mockCaptureException = jest.fn();
const afterCallbacks: Array<() => void | Promise<void>> = [];
const mockBatchReviewDecisionFetch =
  jest.fn<(pending: boolean, owner: { userId: string; organizationId: string | null }) => void>();
const mockGenerateCloudAgentToken = jest.fn((_user: User) => 'cloud-agent-token');
const mockCreateCloudAgentNextClient = jest.fn((_token: string) => ({
  deleteSession: mockRuntimeDelete,
  deleteWorktree: mockWorktreeDelete,
  getSession: mockGetRuntimeSession,
}));

jest.mock('@/lib/trpc/init', () => {
  const { initTRPC } = jest.requireActual<typeof TrpcServerModule>('@trpc/server');
  const trpc = initTRPC.context<TRPCContext>().create();

  return {
    baseProcedure: trpc.procedure,
    createTRPCRouter: trpc.router,
    createCallerFactory: trpc.createCallerFactory,
  };
});

jest.mock('@sentry/nextjs', () => ({
  captureException: mockCaptureException,
}));

jest.mock('@/lib/cloud-agent-next/cloud-agent-client', () => ({
  createCloudAgentNextClient: mockCreateCloudAgentNextClient,
}));

jest.mock('@/lib/tokens', () => ({
  generateApiToken: jest.fn(() => 'cloud-agent-token'),
  generateCloudAgentToken: mockGenerateCloudAgentToken,
}));

jest.mock('@/lib/session-ingest-client', () => ({
  fetchSessionSnapshot: mockFetchSessionSnapshot,
  fetchSessionMessagesPage: jest.fn(),
  deleteSession: mockDeleteSessionIngest,
  shareSession: jest.fn(),
  unshareSession: jest.fn(),
}));

jest.mock('@/lib/admin/admin-access-log', () => ({
  recordKiloAdminElevation: jest.fn(),
  UNSCOPED_TARGET: 'unscoped',
}));

jest.mock('@/lib/webhook-trigger-ownership', () => ({
  verifyWebhookTriggerAccess: jest.fn(),
}));

jest.mock('@/lib/integrations/platforms/github/adapter', () => ({
  fetchPullRequestByNumber: jest.fn(),
  fetchPullRequestReviewDecision: jest.fn(),
  GitHubRateLimitError: class GitHubRateLimitError extends Error {},
}));

jest.mock('@/lib/integrations/db/platform-integrations', () => ({
  getIntegrationForOwner: jest.fn(),
}));

jest.mock('@/lib/integrations/platforms/github/batch-review-decisions', () => ({
  triggerBatchReviewDecisionFetchIfNeeded: mockBatchReviewDecisionFetch,
}));

jest.mock('@/lib/cloud-agent/session-events', () => ({
  notifyCliSessionRenamed: jest.fn(),
}));

jest.mock('next/server', () => ({
  after: (callback: () => void | Promise<void>) => {
    afterCallbacks.push(callback);
  },
}));

type WorktreeCaller = ReturnType<typeof cliSessionsV2Router.createCaller>;
let createCaller: (ctx: TRPCContext) => WorktreeCaller;
let user: User;
let otherUser: User;

const ownershipRow = {
  session_id: SESSION_ID,
  kilo_user_id: USER_ID,
  version: 0,
  title: 'Grouped worktree session',
  public_id: null,
  parent_session_id: null,
  organization_id: null,
  cloud_agent_session_id: WORKSPACE_ID,
  cloud_agent_session_scope_id: null,
  cloud_agent_worktree_id: WORKTREE_ID,
  created_on_platform: 'cloud-agent-web',
  git_url: null,
  git_branch: null,
  platform: null,
  pr_url: null,
  pr_number: null,
  status: null,
  status_updated_at: null,
  last_activity_at: null,
  total_cost_microdollars: null,
  created_at: INITIAL_TIME,
  updated_at: INITIAL_TIME,
} satisfies CliSessionV2;

function makeSession(overrides: Partial<NewCliSessionV2> = {}): NewCliSessionV2 {
  return {
    ...ownershipRow,
    session_id: `ses_${crypto.randomUUID().replaceAll('-', '').slice(0, 26)}`,
    cloud_agent_session_id: `workspace_${crypto.randomUUID()}`,
    created_at: LATER_TIME,
    updated_at: LATER_TIME,
    ...overrides,
  };
}

function newWorktreeId(): CloudAgentWorktreeId {
  return `worktree_${crypto.randomUUID()}`;
}

async function insertSession(overrides: Partial<NewCliSessionV2> = {}) {
  const [session] = await db.insert(cli_sessions_v2).values(makeSession(overrides)).returning();
  return session;
}

async function readWorktree() {
  const [worktree] = await db
    .select()
    .from(cloud_agent_worktrees)
    .where(eq(cloud_agent_worktrees.worktree_id, WORKTREE_ID));
  return worktree;
}

async function readSessions() {
  return db
    .select()
    .from(cli_sessions_v2)
    .where(eq(cli_sessions_v2.cloud_agent_worktree_id, WORKTREE_ID))
    .orderBy(cli_sessions_v2.session_id);
}

beforeAll(async () => {
  user = await insertTestUser({ id: USER_ID, is_admin: false });
  otherUser = await insertTestUser({ id: OTHER_USER_ID, is_admin: false });
  await db.insert(organizations).values([
    { id: ORGANIZATION_ID, name: 'Worktree organization', created_by_kilo_user_id: USER_ID },
    {
      id: OTHER_ORGANIZATION_ID,
      name: 'Other worktree organization',
      created_by_kilo_user_id: USER_ID,
    },
  ]);
  const { createCallerFactory } = await import('@/lib/trpc/init');
  const { cliSessionsV2Router } = await import('./cli-sessions-v2-router');
  createCaller = createCallerFactory(cliSessionsV2Router);
});

beforeEach(async () => {
  jest.clearAllMocks();
  afterCallbacks.length = 0;
  const userIds = [USER_ID, OTHER_USER_ID];
  await db
    .delete(cli_sessions_v2)
    .where(
      and(
        inArray(cli_sessions_v2.kilo_user_id, userIds),
        isNotNull(cli_sessions_v2.parent_session_id)
      )
    );
  await db.delete(cli_sessions_v2).where(inArray(cli_sessions_v2.kilo_user_id, userIds));
  await db
    .delete(cloud_agent_worktrees)
    .where(inArray(cloud_agent_worktrees.kilo_user_id, userIds));
  await db
    .delete(github_branch_pull_requests)
    .where(
      or(
        inArray(github_branch_pull_requests.owned_by_user_id, userIds),
        inArray(github_branch_pull_requests.owned_by_organization_id, [
          ORGANIZATION_ID,
          OTHER_ORGANIZATION_ID,
        ])
      )
    );
  await db
    .delete(organization_memberships)
    .where(inArray(organization_memberships.kilo_user_id, userIds));
  await db.insert(organization_memberships).values([
    { kilo_user_id: USER_ID, organization_id: ORGANIZATION_ID, role: 'member' },
    { kilo_user_id: USER_ID, organization_id: OTHER_ORGANIZATION_ID, role: 'member' },
    { kilo_user_id: OTHER_USER_ID, organization_id: ORGANIZATION_ID, role: 'member' },
  ]);
  await db.insert(cli_sessions_v2).values(ownershipRow);
  mockRuntimeDelete.mockReset().mockResolvedValue({ success: true });
  mockWorktreeDelete
    .mockReset()
    .mockResolvedValue({ success: true, deletedSessionIds: [SESSION_ID] });
  mockGetRuntimeSession.mockReset().mockRejectedValue(new Error('Runtime not configured'));
  mockDeleteSessionIngest.mockReset().mockImplementation(async (sessionId, userId) => {
    await db
      .delete(cli_sessions_v2)
      .where(
        and(eq(cli_sessions_v2.session_id, sessionId), eq(cli_sessions_v2.kilo_user_id, userId))
      );
  });
  mockFetchSessionSnapshot.mockReset().mockResolvedValue(null);
});

describe('cliSessionsV2 worktree projections and session deletion', () => {
  it('projects personal worktree rows without including other owners or organization scopes', async () => {
    await insertSession({ kilo_user_id: OTHER_USER_ID });
    await insertSession({ organization_id: ORGANIZATION_ID });
    const result = await createCaller({ user }).list({
      organizationId: null,
      worktreeId: WORKTREE_ID,
    });

    expect(result.cliSessions).toEqual([
      expect.objectContaining({ session_id: SESSION_ID, cloud_agent_worktree_id: WORKTREE_ID }),
    ]);
    expect(result.cliSessions[0]).not.toHaveProperty('workspacePath');
  });

  it('retains exact organization authorization when filtering sibling lists', async () => {
    const orgSession = await insertSession({ organization_id: ORGANIZATION_ID });
    await insertSession({ organization_id: OTHER_ORGANIZATION_ID });
    const result = await createCaller({ user }).list({
      organizationId: ORGANIZATION_ID,
      worktreeId: WORKTREE_ID,
    });

    expect(result.cliSessions.map(session => session.session_id)).toEqual([orgSession.session_id]);
  });

  it('projects and filters the canonical worktree during search', async () => {
    await insertSession({ cloud_agent_worktree_id: newWorktreeId() });
    const result = await createCaller({ user }).search({
      search_string: 'Grouped',
      organizationId: null,
      worktreeId: WORKTREE_ID,
    });

    expect(result.results).toEqual([
      expect.objectContaining({ session_id: SESSION_ID, cloud_agent_worktree_id: WORKTREE_ID }),
    ]);
    expect(result.nextCursor).toBeNull();
  });

  it('returns the ownership worktree in runtime state without exposing the private checkout path', async () => {
    mockGetRuntimeSession.mockResolvedValueOnce({
      sessionId: WORKSPACE_ID,
      userId: USER_ID,
      execution: null,
      timestamp: 1,
      version: 1,
      workspacePath: '/private/shared-checkout',
    });
    const result = await createCaller({ user }).getWithRuntimeState({ session_id: SESSION_ID });

    expect(result.cloud_agent_worktree_id).toBe(WORKTREE_ID);
    expect(result).not.toHaveProperty('workspacePath');
    expect(result.runtimeState).not.toHaveProperty('workspacePath');
  });

  it('preserves the empty-history fallback for a lazily created sibling', async () => {
    await expect(
      createCaller({ user }).getSessionMessages({ session_id: SESSION_ID })
    ).resolves.toEqual({
      info: {},
      messages: [],
    });
    expect(mockGetRuntimeSession).not.toHaveBeenCalled();
  });

  it.each([
    ['reports success false', () => mockRuntimeDelete.mockResolvedValueOnce({ success: false })],
    ['throws', () => mockRuntimeDelete.mockRejectedValueOnce(new Error('Worker unavailable'))],
  ])('preserves ownership when runtime deletion %s', async (_, failDeletion) => {
    failDeletion();
    await expect(createCaller({ user }).delete({ session_id: SESSION_ID })).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to clean up cloud-agent session',
    });

    expect(await readSessions()).toHaveLength(1);
    expect(mockDeleteSessionIngest).not.toHaveBeenCalled();
    expect(mockCaptureException).toHaveBeenCalled();
  });

  it('removes ownership only after runtime deletion confirms success', async () => {
    await expect(createCaller({ user }).delete({ session_id: SESSION_ID })).resolves.toEqual({
      success: true,
      session_id: SESSION_ID,
    });

    expect(await readSessions()).toHaveLength(0);
    expect(mockRuntimeDelete.mock.invocationCallOrder[0]).toBeLessThan(
      mockDeleteSessionIngest.mock.invocationCallOrder[0]
    );
  });
});

describe('cliSessionsV2 worktreeDetails and persistent names', () => {
  it('returns defaults for existing worktrees without metadata and omits unknown or foreign groups', async () => {
    const foreignId = newWorktreeId();
    await insertSession({ kilo_user_id: OTHER_USER_ID, cloud_agent_worktree_id: foreignId });
    const result = await createCaller({ user }).worktreeDetails({
      worktreeIds: [WORKTREE_ID, WORKTREE_ID, newWorktreeId(), foreignId],
      organizationId: null,
    });

    expect(result).toEqual({
      worktrees: {
        [WORKTREE_ID]: {
          name: null,
          defaultTitle: ownershipRow.title,
          prSession: null,
          sessions: [{ sessionId: SESSION_ID, sessionStatus: null, sessionStatusUpdatedAt: null }],
        },
      },
    });
    expect(await readWorktree()).toBeUndefined();
  });

  it('returns activity membership only for owned roots in the exact current scope', async () => {
    const sibling = await insertSession({
      status: 'busy',
      status_updated_at: '2026-04-29 01:16:12.945+00',
    });
    await insertSession({ kilo_user_id: OTHER_USER_ID, status: 'question' });
    await insertSession({ organization_id: ORGANIZATION_ID, status: 'permission' });
    await insertSession({ organization_id: OTHER_ORGANIZATION_ID, status: 'question' });
    await insertSession({ parent_session_id: SESSION_ID, status: 'permission' });
    const otherWorktreeId = newWorktreeId();
    const otherWorktreeSession = await insertSession({
      cloud_agent_worktree_id: otherWorktreeId,
      status: 'retry',
    });

    const details = await createCaller({ user }).worktreeDetails({
      worktreeIds: [WORKTREE_ID, otherWorktreeId],
      organizationId: null,
    });

    expect(details.worktrees[WORKTREE_ID].sessions).toEqual(
      [
        { sessionId: SESSION_ID, sessionStatus: null, sessionStatusUpdatedAt: null },
        {
          sessionId: sibling.session_id,
          sessionStatus: 'busy',
          sessionStatusUpdatedAt: '2026-04-29T01:16:12.945Z',
        },
      ].sort((a, b) => a.sessionId.localeCompare(b.sessionId))
    );
    expect(details.worktrees[otherWorktreeId].sessions).toEqual([
      {
        sessionId: otherWorktreeSession.session_id,
        sessionStatus: 'retry',
        sessionStatusUpdatedAt: null,
      },
    ]);
    expect(mockFetchSessionSnapshot).not.toHaveBeenCalled();
    expect(mockGetRuntimeSession).not.toHaveBeenCalled();
  });

  it('derives the first root from full history rather than recent, searched, filtered, or capped rows', async () => {
    await db
      .update(cli_sessions_v2)
      .set({
        title: 'Original worktree purpose',
        created_on_platform: 'cli',
        git_url: 'https://github.com/worktree-tests/original',
        created_at: '2020-01-01T00:00:00.000Z',
        updated_at: '2020-01-01T00:00:00.000Z',
        status: 'question',
        status_updated_at: '2020-01-01 00:00:00+00',
      })
      .where(eq(cli_sessions_v2.session_id, SESSION_ID));
    await db.insert(cli_sessions_v2).values(
      Array.from({ length: 205 }, () =>
        makeSession({
          title: 'Visible sibling',
          git_url: GIT_URL,
        })
      )
    );
    const caller = createCaller({ user });
    const recent = await caller.list({
      organizationId: null,
      worktreeId: WORKTREE_ID,
      limit: 200,
      createdOnPlatform: 'cloud-agent-web',
      gitUrl: GIT_URL,
      updatedSince: INITIAL_TIME,
    });
    const search = await caller.search({
      search_string: 'Visible',
      organizationId: null,
      limit: 50,
    });
    const details = await caller.worktreeDetails({
      worktreeIds: [WORKTREE_ID],
      organizationId: null,
    });

    expect(recent.cliSessions).toHaveLength(200);
    expect(recent.cliSessions.some(session => session.session_id === SESSION_ID)).toBe(false);
    expect(search.results.some(session => session.session_id === SESSION_ID)).toBe(false);
    expect(details.worktrees[WORKTREE_ID].defaultTitle).toBe('Original worktree purpose');
    expect(details.worktrees[WORKTREE_ID].sessions).toHaveLength(206);
    expect(details.worktrees[WORKTREE_ID].sessions).toContainEqual({
      sessionId: SESSION_ID,
      sessionStatus: 'question',
      sessionStatusUpdatedAt: '2020-01-01T00:00:00.000Z',
    });
    expect(mockFetchSessionSnapshot).not.toHaveBeenCalled();
  });

  it.each([null, '', '  \t\n', `New session - ${INITIAL_TIME}`, `Child session - ${INITIAL_TIME}`])(
    'does not use a later real title when the first title is %p',
    async title => {
      await db
        .update(cli_sessions_v2)
        .set({ title })
        .where(eq(cli_sessions_v2.session_id, SESSION_ID));
      await insertSession({ title: 'Later real title' });

      const details = await createCaller({ user }).worktreeDetails({
        worktreeIds: [WORKTREE_ID],
        organizationId: null,
      });

      expect(details.worktrees[WORKTREE_ID]).toMatchObject({
        name: null,
        defaultTitle: null,
        prSession: null,
      });
    }
  );

  it.each(['New session - implementation plan', `New session - ${INITIAL_TIME} notes`])(
    'does not suppress a real title that only resembles a CLI placeholder: %s',
    async title => {
      await db
        .update(cli_sessions_v2)
        .set({ title })
        .where(eq(cli_sessions_v2.session_id, SESSION_ID));
      const details = await createCaller({ user }).worktreeDetails({
        worktreeIds: [WORKTREE_ID],
        organizationId: null,
      });
      expect(details.worktrees[WORKTREE_ID].defaultTitle).toBe(title);
    }
  );

  it('keeps a hidden first placeholder authoritative and observes its later real title without caching', async () => {
    await db
      .update(cli_sessions_v2)
      .set({ title: null, created_on_platform: 'unknown' })
      .where(eq(cli_sessions_v2.session_id, SESSION_ID));
    const sibling = await insertSession({ title: 'Visible sibling' });
    const caller = createCaller({ user });
    const list = await caller.list({ organizationId: null, worktreeId: WORKTREE_ID });
    expect(list.cliSessions.map(session => session.session_id)).toEqual([sibling.session_id]);
    expect(
      (await caller.worktreeDetails({ worktreeIds: [WORKTREE_ID], organizationId: null }))
        .worktrees[WORKTREE_ID].defaultTitle
    ).toBeNull();

    await db
      .update(cli_sessions_v2)
      .set({ title: 'Generated first title' })
      .where(eq(cli_sessions_v2.session_id, SESSION_ID));
    expect(
      (
        await createCaller({ user }).worktreeDetails({
          worktreeIds: [WORKTREE_ID],
          organizationId: null,
        })
      ).worktrees[WORKTREE_ID].defaultTitle
    ).toBe('Generated first title');
  });

  it('breaks creation ties by session ID, ignores child titles, and advances only when the first root is removed', async () => {
    const tied = await insertSession({
      session_id: 'ses_00000000000000000000000000',
      title: 'First tied root',
      created_at: INITIAL_TIME,
    });
    await insertSession({
      parent_session_id: SESSION_ID,
      title: 'Child must not name the worktree',
      created_at: '2020-01-01T00:00:00.000Z',
    });
    const caller = createCaller({ user });
    expect(
      (await caller.worktreeDetails({ worktreeIds: [WORKTREE_ID], organizationId: null }))
        .worktrees[WORKTREE_ID].defaultTitle
    ).toBe(tied.title);

    await db.delete(cli_sessions_v2).where(eq(cli_sessions_v2.session_id, tied.session_id));
    expect(
      (await caller.worktreeDetails({ worktreeIds: [WORKTREE_ID], organizationId: null }))
        .worktrees[WORKTREE_ID].defaultTitle
    ).toBe(ownershipRow.title);
  });

  it('persists trimmed worktree names for OAuth owners independently of chat titles, timestamps, and later title promotion', async () => {
    await insertSession({ title: 'Independent sibling' });
    const before = await readSessions();
    const caller = createCaller({ user });
    await expect(
      caller.renameWorktree({
        worktreeId: WORKTREE_ID,
        organizationId: null,
        name: '  Custom worktree name  ',
      })
    ).resolves.toEqual({ name: 'Custom worktree name' });

    const persisted = await readWorktree();
    expect(persisted).toMatchObject({
      worktree_id: WORKTREE_ID,
      kilo_user_id: USER_ID,
      organization_id: null,
      name: 'Custom worktree name',
    });
    expect(await readSessions()).toEqual(before);
    expect(mockCreateCloudAgentNextClient).not.toHaveBeenCalled();
    expect(user.total_microdollars_acquired).toBe(0);

    await db
      .update(cli_sessions_v2)
      .set({ title: 'New automatic first title' })
      .where(eq(cli_sessions_v2.session_id, SESSION_ID));
    const reloaded = await createCaller({ user }).worktreeDetails({
      worktreeIds: [WORKTREE_ID],
      organizationId: null,
    });
    expect(reloaded.worktrees[WORKTREE_ID]).toMatchObject({
      name: 'Custom worktree name',
      defaultTitle: 'New automatic first title',
      prSession: null,
    });

    await db
      .update(cloud_agent_worktrees)
      .set({ updated_at: INITIAL_TIME })
      .where(eq(cloud_agent_worktrees.worktree_id, WORKTREE_ID));
    await caller.renameWorktree({
      worktreeId: WORKTREE_ID,
      organizationId: null,
      name: 'Second name',
    });
    const renamed = await readWorktree();
    expect(renamed.created_at).toBe(persisted.created_at);
    expect(new Date(renamed.updated_at).getTime()).toBeGreaterThan(
      new Date(INITIAL_TIME).getTime()
    );
    expect(renamed.name).toBe('Second name');
  });

  it.each([null, ORGANIZATION_ID])(
    'backdates lazy rename metadata to the oldest authorized member (organization=%s)',
    async organizationId => {
      await db
        .update(cli_sessions_v2)
        .set({ organization_id: organizationId })
        .where(eq(cli_sessions_v2.session_id, SESSION_ID));
      const oldest = await insertSession({
        organization_id: organizationId,
        created_at: '2020-01-02 03:04:05.678+00',
      });
      await insertSession({
        kilo_user_id: OTHER_USER_ID,
        organization_id: organizationId,
        created_at: '2010-01-01T00:00:00.000Z',
      });
      await insertSession({
        organization_id: organizationId === null ? ORGANIZATION_ID : null,
        created_at: '2010-01-01T00:00:00.000Z',
      });
      const sessionsBeforeRename = await readSessions();
      expect(await readWorktree()).toBeUndefined();

      await expect(
        createCaller({ user }).renameWorktree({
          worktreeId: WORKTREE_ID,
          organizationId,
          name: 'Historical worktree',
        })
      ).resolves.toEqual({ name: 'Historical worktree' });

      const worktree = await readWorktree();
      expect(worktree).toMatchObject({
        kilo_user_id: USER_ID,
        organization_id: organizationId,
        name: 'Historical worktree',
      });
      expect(worktree.created_at).toBe(oldest.created_at);
      expect(await readSessions()).toEqual(sessionsBeforeRename);
    }
  );

  it('safely serializes concurrent first renames without duplicating metadata or changing ownership', async () => {
    const caller = createCaller({ user });
    const results = await Promise.all(
      ['First name', 'Second name'].map(name =>
        caller.renameWorktree({
          worktreeId: WORKTREE_ID,
          organizationId: null,
          name,
        })
      )
    );

    expect(results).toEqual([{ name: 'First name' }, { name: 'Second name' }]);
    const worktree = await readWorktree();
    expect(['First name', 'Second name']).toContain(worktree.name);
    expect(worktree).toMatchObject({ kilo_user_id: USER_ID, organization_id: null });
    expect((await readSessions())[0].title).toBe(ownershipRow.title);
  });

  it('requires an existing owned worktree and never inserts metadata for a foreign or missing group', async () => {
    const missingId = newWorktreeId();
    await expect(
      createCaller({ user: otherUser }).renameWorktree({
        worktreeId: WORKTREE_ID,
        organizationId: null,
        name: 'Stolen name',
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      createCaller({ user }).renameWorktree({
        worktreeId: missingId,
        organizationId: null,
        name: 'Missing name',
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(
      await db
        .select()
        .from(cloud_agent_worktrees)
        .where(inArray(cloud_agent_worktrees.worktree_id, [WORKTREE_ID, missingId]))
    ).toEqual([]);
  });

  it.each([
    { kilo_user_id: OTHER_USER_ID, organization_id: null },
    { kilo_user_id: USER_ID, organization_id: ORGANIZATION_ID },
  ])('never claims or exposes conflicting immutable metadata: %p', async owner => {
    await db
      .insert(cloud_agent_worktrees)
      .values({ worktree_id: WORKTREE_ID, ...owner, name: 'Private name' });
    const before = await readWorktree();
    const caller = createCaller({ user });

    await expect(
      caller.renameWorktree({ worktreeId: WORKTREE_ID, organizationId: null, name: 'Wrong name' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      caller.worktreeDetails({ worktreeIds: [WORKTREE_ID], organizationId: null })
    ).resolves.toEqual({ worktrees: {} });
    expect(await readWorktree()).toEqual(before);
  });

  it('enforces owner and exact personal/organization scope for worktree reads and renames', async () => {
    const orgWorktreeId = newWorktreeId();
    await insertSession({
      cloud_agent_worktree_id: orgWorktreeId,
      organization_id: ORGANIZATION_ID,
      title: 'Organization first chat',
    });
    const caller = createCaller({ user });
    await caller.renameWorktree({
      worktreeId: orgWorktreeId,
      organizationId: ORGANIZATION_ID,
      name: 'Organization name',
    });

    expect(
      (
        await caller.worktreeDetails({
          worktreeIds: [WORKTREE_ID, orgWorktreeId],
          organizationId: null,
        })
      ).worktrees
    ).toEqual({
      [WORKTREE_ID]: {
        name: null,
        defaultTitle: ownershipRow.title,
        prSession: null,
        sessions: [{ sessionId: SESSION_ID, sessionStatus: null, sessionStatusUpdatedAt: null }],
      },
    });
    expect(
      (
        await caller.worktreeDetails({
          worktreeIds: [WORKTREE_ID, orgWorktreeId],
          organizationId: ORGANIZATION_ID,
        })
      ).worktrees
    ).toEqual({
      [orgWorktreeId]: expect.objectContaining({
        name: 'Organization name',
        defaultTitle: 'Organization first chat',
        prSession: null,
      }),
    });
    for (const organizationId of [null, OTHER_ORGANIZATION_ID]) {
      await expect(
        caller.renameWorktree({ worktreeId: orgWorktreeId, organizationId, name: 'Wrong scope' })
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    }
    await expect(
      caller.renameWorktree({
        worktreeId: WORKTREE_ID,
        organizationId: ORGANIZATION_ID,
        name: 'Wrong scope',
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      createCaller({ user: otherUser }).worktreeDetails({
        worktreeIds: [orgWorktreeId],
        organizationId: ORGANIZATION_ID,
      })
    ).resolves.toEqual({ worktrees: {} });
    await expect(
      createCaller({ user: otherUser }).renameWorktree({
        worktreeId: orgWorktreeId,
        organizationId: ORGANIZATION_ID,
        name: 'Other member',
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('requires current organization membership even for an owner marked as a Kilo admin', async () => {
    await db
      .update(cli_sessions_v2)
      .set({ organization_id: ORGANIZATION_ID })
      .where(eq(cli_sessions_v2.session_id, SESSION_ID));
    await createCaller({ user }).renameWorktree({
      worktreeId: WORKTREE_ID,
      organizationId: ORGANIZATION_ID,
      name: 'Owned org group',
    });
    await db
      .delete(organization_memberships)
      .where(
        and(
          eq(organization_memberships.kilo_user_id, USER_ID),
          eq(organization_memberships.organization_id, ORGANIZATION_ID)
        )
      );

    for (const currentUser of [user, { ...user, is_admin: true }]) {
      const caller = createCaller({ user: currentUser });
      await expect(
        caller.worktreeDetails({ worktreeIds: [WORKTREE_ID], organizationId: ORGANIZATION_ID })
      ).resolves.toEqual({ worktrees: {} });
      await expect(
        caller.renameWorktree({
          worktreeId: WORKTREE_ID,
          organizationId: ORGANIZATION_ID,
          name: 'No longer authorized',
        })
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    }
    expect((await readWorktree()).name).toBe('Owned org group');
  });

  it.each([false, true])(
    'refuses renames and hides deleting metadata (completed=%s)',
    async completed => {
      await db.insert(cloud_agent_worktrees).values({
        worktree_id: WORKTREE_ID,
        kilo_user_id: USER_ID,
        name: completed ? null : 'Preserved pending name',
        deletion_started_at: INITIAL_TIME,
        deletion_completed_at: completed ? LATER_TIME : null,
      });
      const before = await readWorktree();
      const caller = createCaller({ user });

      await expect(
        caller.renameWorktree({
          worktreeId: WORKTREE_ID,
          organizationId: null,
          name: 'Resurrected name',
        })
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      await expect(
        caller.worktreeDetails({ worktreeIds: [WORKTREE_ID], organizationId: null })
      ).resolves.toEqual({ worktrees: {} });
      expect(await readWorktree()).toEqual(before);
    }
  );
});

describe('cliSessionsV2 worktree PR projection', () => {
  it.each([null, ORGANIZATION_ID])(
    'refreshes a historical search-only pending PR through the existing tenant batch (organization=%s)',
    async organizationId => {
      await db
        .update(cli_sessions_v2)
        .set({
          organization_id: organizationId,
          title: 'Historical pending PR',
          git_url: GIT_URL,
          git_branch: BRANCH,
          created_at: '2020-01-01T00:00:00.000Z',
          updated_at: '2020-01-01T00:00:00.000Z',
        })
        .where(eq(cli_sessions_v2.session_id, SESSION_ID));
      await db.insert(github_branch_pull_requests).values({
        git_url: GIT_URL,
        git_branch: BRANCH,
        owned_by_user_id: organizationId === null ? USER_ID : null,
        owned_by_organization_id: organizationId,
        pr_url: PR_URL,
        pr_number: 42,
        pr_state: 'open',
        review_decision_pending: true,
      });
      const caller = createCaller({ user });
      const search = await caller.search({ search_string: 'Historical pending', organizationId });
      expect(search.results.map(session => session.session_id)).toEqual([SESSION_ID]);
      expect(afterCallbacks).toHaveLength(0);
      await expect(
        createCaller({ user: otherUser }).worktreeDetails({
          worktreeIds: [WORKTREE_ID],
          organizationId,
        })
      ).resolves.toEqual({ worktrees: {} });
      expect(afterCallbacks).toHaveLength(0);

      const details = await caller.worktreeDetails({ worktreeIds: [WORKTREE_ID], organizationId });
      expect(details.worktrees[WORKTREE_ID].prSession?.associatedPr?.reviewDecisionPending).toBe(
        true
      );
      expect(mockBatchReviewDecisionFetch).not.toHaveBeenCalled();
      expect(afterCallbacks).toHaveLength(1);
      await Promise.all(afterCallbacks.splice(0).map(callback => callback()));
      expect(mockBatchReviewDecisionFetch).toHaveBeenCalledTimes(1);
      expect(mockBatchReviewDecisionFetch).toHaveBeenCalledWith(true, {
        userId: USER_ID,
        organizationId,
      });

      await db
        .update(github_branch_pull_requests)
        .set({ review_decision_pending: false, pr_review_decision: 'approved' })
        .where(eq(github_branch_pull_requests.git_url, GIT_URL));
      const refreshed = await caller.worktreeDetails({
        worktreeIds: [WORKTREE_ID],
        organizationId,
      });
      expect(refreshed.worktrees[WORKTREE_ID].prSession?.associatedPr).toMatchObject({
        reviewDecision: 'approved',
        reviewDecisionPending: false,
      });
      expect(afterCallbacks).toHaveLength(0);
    }
  );

  it('does not schedule a batch for empty, non-pending, or no-longer-authorized worktrees', async () => {
    const caller = createCaller({ user });
    await caller.worktreeDetails({ worktreeIds: [], organizationId: null });
    await caller.worktreeDetails({ worktreeIds: [WORKTREE_ID], organizationId: null });
    expect(afterCallbacks).toHaveLength(0);
    await db
      .update(cli_sessions_v2)
      .set({ organization_id: ORGANIZATION_ID, git_url: GIT_URL, git_branch: BRANCH })
      .where(eq(cli_sessions_v2.session_id, SESSION_ID));
    await db.insert(github_branch_pull_requests).values({
      git_url: GIT_URL,
      git_branch: BRANCH,
      owned_by_organization_id: ORGANIZATION_ID,
      pr_url: PR_URL,
      pr_number: 42,
      pr_state: 'open',
      review_decision_pending: true,
    });
    await db
      .delete(organization_memberships)
      .where(
        and(
          eq(organization_memberships.organization_id, ORGANIZATION_ID),
          eq(organization_memberships.kilo_user_id, USER_ID)
        )
      );

    await expect(
      caller.worktreeDetails({ worktreeIds: [WORKTREE_ID], organizationId: ORGANIZATION_ID })
    ).resolves.toEqual({ worktrees: {} });
    expect(afterCallbacks).toHaveLength(0);
    expect(mockBatchReviewDecisionFetch).not.toHaveBeenCalled();
  });

  it('selects an older real PR source beyond the 200-session sidebar cap', async () => {
    await db
      .update(cli_sessions_v2)
      .set({
        pr_url: PR_URL,
        pr_number: 42,
        platform: 'github',
        updated_at: INITIAL_TIME,
        total_cost_microdollars: 123,
      })
      .where(eq(cli_sessions_v2.session_id, SESSION_ID));
    await db
      .insert(cli_sessions_v2)
      .values(Array.from({ length: 205 }, () => makeSession({ title: 'Newer chat without PR' })));
    const caller = createCaller({ user });
    expect(
      (
        await caller.list({ organizationId: null, worktreeId: WORKTREE_ID, limit: 200 })
      ).cliSessions.some(session => session.session_id === SESSION_ID)
    ).toBe(false);

    const details = await caller.worktreeDetails({
      worktreeIds: [WORKTREE_ID],
      organizationId: null,
    });
    const prSession = details.worktrees[WORKTREE_ID].prSession;
    expect(prSession).toMatchObject({
      session_id: SESSION_ID,
      title: ownershipRow.title,
      total_cost_microdollars: 123,
      associatedPr: {
        url: PR_URL,
        number: 42,
        state: 'unknown',
        title: null,
        reviewDecisionPending: false,
        platform: 'github',
      },
    });
    expect(Object.keys(prSession ?? {}).sort()).toEqual(
      [
        'session_id',
        'title',
        'cloud_agent_session_id',
        'cloud_agent_worktree_id',
        'parent_session_id',
        'organization_id',
        'created_on_platform',
        'git_url',
        'git_branch',
        'status',
        'status_updated_at',
        'created_at',
        'updated_at',
        'version',
        'total_cost_microdollars',
        'associatedPr',
      ].sort()
    );
    expect(mockGetRuntimeSession).not.toHaveBeenCalled();
  });

  it('selects the most recently updated PR-bearing root with a stable session-ID tie-break', async () => {
    await db
      .update(cli_sessions_v2)
      .set({ pr_url: `${GIT_URL}/pull/1`, updated_at: INITIAL_TIME })
      .where(eq(cli_sessions_v2.session_id, SESSION_ID));
    const winner = await insertSession({
      session_id: 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa',
      pr_url: PR_URL,
    });
    await insertSession({
      session_id: 'ses_bbbbbbbbbbbbbbbbbbbbbbbbbb',
      pr_url: `${GIT_URL}/pull/43`,
    });
    await insertSession({ updated_at: '2026-08-26T02:00:00.000Z' });
    await insertSession({
      parent_session_id: SESSION_ID,
      pr_url: `${GIT_URL}/pull/99`,
      updated_at: '2026-08-26T03:00:00.000Z',
    });

    const details = await createCaller({ user }).worktreeDetails({
      worktreeIds: [WORKTREE_ID],
      organizationId: null,
    });
    expect(details.worktrees[WORKTREE_ID].prSession?.session_id).toBe(winner.session_id);
    expect(details.worktrees[WORKTREE_ID].prSession?.associatedPr?.number).toBe(42);
  });

  it('uses the existing branch-cache fallback and preserves pending review flags with normalized DB timestamps', async () => {
    const timestamp = '2026-04-29 01:16:12.945+00';
    const isoTimestamp = '2026-04-29T01:16:12.945Z';
    await db
      .update(cli_sessions_v2)
      .set({
        git_url: GIT_URL,
        git_branch: BRANCH,
        created_at: timestamp,
        updated_at: timestamp,
        status_updated_at: timestamp,
      })
      .where(eq(cli_sessions_v2.session_id, SESSION_ID));
    await db.insert(github_branch_pull_requests).values({
      git_url: GIT_URL,
      git_branch: BRANCH,
      owned_by_user_id: USER_ID,
      pr_url: PR_URL,
      pr_number: 42,
      pr_state: 'open',
      pr_title: 'Cached pull request',
      pr_head_sha: 'abc123',
      pr_review_decision: 'approved',
      review_decision_pending: true,
      pr_last_synced_at: timestamp,
    });
    const details = await createCaller({ user }).worktreeDetails({
      worktreeIds: [WORKTREE_ID],
      organizationId: null,
    });

    expect(details.worktrees[WORKTREE_ID].prSession).toMatchObject({
      session_id: SESSION_ID,
      created_at: isoTimestamp,
      updated_at: isoTimestamp,
      status_updated_at: isoTimestamp,
      associatedPr: {
        url: PR_URL,
        number: 42,
        state: 'open',
        title: 'Cached pull request',
        headSha: 'abc123',
        reviewDecision: 'approved',
        reviewDecisionPending: true,
        lastSyncedAt: isoTimestamp,
        platform: 'github',
      },
    });
  });

  it('prefers a stored PR link to a different branch-cache PR instead of copying the wrong PR fields', async () => {
    await db
      .update(cli_sessions_v2)
      .set({ git_url: GIT_URL, git_branch: BRANCH, pr_url: PR_URL, updated_at: INITIAL_TIME })
      .where(eq(cli_sessions_v2.session_id, SESSION_ID));
    await db.insert(github_branch_pull_requests).values({
      git_url: GIT_URL,
      git_branch: BRANCH,
      owned_by_user_id: USER_ID,
      pr_url: `${GIT_URL}/pull/99`,
      pr_number: 99,
      pr_state: 'closed',
      pr_title: 'Wrong PR',
      review_decision_pending: true,
    });
    const caller = createCaller({ user });
    const details = await caller.worktreeDetails({
      worktreeIds: [WORKTREE_ID],
      organizationId: null,
    });
    const list = await caller.list({ worktreeId: WORKTREE_ID, organizationId: null });

    expect(details.worktrees[WORKTREE_ID].prSession?.associatedPr).toEqual(
      list.cliSessions[0].associatedPr
    );
    expect(details.worktrees[WORKTREE_ID].prSession?.associatedPr).toMatchObject({
      url: PR_URL,
      number: 42,
      state: 'unknown',
      title: null,
      reviewDecisionPending: false,
    });
  });

  it('uses live cache fields for the same stored PR even with URL subpaths and query strings', async () => {
    await db
      .update(cli_sessions_v2)
      .set({
        git_url: GIT_URL,
        git_branch: BRANCH,
        pr_url: `${PR_URL}/files?view=all`,
        updated_at: INITIAL_TIME,
      })
      .where(eq(cli_sessions_v2.session_id, SESSION_ID));
    await db.insert(github_branch_pull_requests).values({
      git_url: GIT_URL,
      git_branch: BRANCH,
      owned_by_user_id: USER_ID,
      pr_url: PR_URL,
      pr_number: 42,
      pr_state: 'merged',
      pr_title: 'Same linked PR',
      pr_review_decision: 'approved',
    });

    const details = await createCaller({ user }).worktreeDetails({
      worktreeIds: [WORKTREE_ID],
      organizationId: null,
    });
    expect(details.worktrees[WORKTREE_ID].prSession?.associatedPr).toMatchObject({
      url: PR_URL,
      state: 'merged',
      title: 'Same linked PR',
      reviewDecision: 'approved',
    });
  });

  it('correlates branch-cache PRs with the exact personal or organization tenant', async () => {
    const orgWorktreeId = newWorktreeId();
    await db
      .update(cli_sessions_v2)
      .set({ git_url: GIT_URL, git_branch: BRANCH, updated_at: INITIAL_TIME })
      .where(eq(cli_sessions_v2.session_id, SESSION_ID));
    const orgSession = await insertSession({
      organization_id: ORGANIZATION_ID,
      cloud_agent_worktree_id: orgWorktreeId,
      git_url: GIT_URL,
      git_branch: BRANCH,
    });
    await db.insert(github_branch_pull_requests).values([
      {
        git_url: GIT_URL,
        git_branch: BRANCH,
        owned_by_user_id: OTHER_USER_ID,
        pr_url: `${GIT_URL}/pull/99`,
        pr_number: 99,
        pr_state: 'open',
      },
      {
        git_url: GIT_URL,
        git_branch: BRANCH,
        owned_by_organization_id: ORGANIZATION_ID,
        pr_url: PR_URL,
        pr_number: 42,
        pr_state: 'open',
      },
    ]);
    const caller = createCaller({ user });
    expect(
      (await caller.worktreeDetails({ worktreeIds: [WORKTREE_ID], organizationId: null }))
        .worktrees[WORKTREE_ID].prSession
    ).toBeNull();
    const orgDetails = await caller.worktreeDetails({
      worktreeIds: [WORKTREE_ID, orgWorktreeId],
      organizationId: ORGANIZATION_ID,
    });
    expect(Object.keys(orgDetails.worktrees)).toEqual([orgWorktreeId]);
    expect(orgDetails.worktrees[orgWorktreeId].prSession).toMatchObject({
      session_id: orgSession.session_id,
      associatedPr: { number: 42 },
    });
  });
});

describe('cliSessionsV2 worktree name search', () => {
  it('matches persistent names case-insensitively and treats %, underscore, and backslash literally', async () => {
    const sibling = await insertSession({ title: 'Independent sibling' });
    const otherWorktreeId = newWorktreeId();
    await insertSession({ cloud_agent_worktree_id: otherWorktreeId });
    const caller = createCaller({ user });
    await caller.renameWorktree({
      worktreeId: WORKTREE_ID,
      organizationId: null,
      name: 'Release 100%_Ready\\now',
    });
    await caller.renameWorktree({
      worktreeId: otherWorktreeId,
      organizationId: null,
      name: 'Release 100XXReadyXnow',
    });

    const result = await caller.search({ search_string: '%_READY\\', organizationId: null });
    expect(result.results.map(session => session.session_id).sort()).toEqual(
      [SESSION_ID, sibling.session_id].sort()
    );
    expect(result.results.every(session => session.cloud_agent_worktree_id === WORKTREE_ID)).toBe(
      true
    );
    await caller.renameWorktree({
      worktreeId: WORKTREE_ID,
      organizationId: null,
      name: 'Renamed release',
    });
    expect(
      (await caller.search({ search_string: '%_READY\\', organizationId: null })).results
    ).toEqual([]);
    expect(
      (await caller.search({ search_string: 'RENAMED RELEASE', organizationId: null })).results
    ).toHaveLength(2);
  });

  it.each([
    { kilo_user_id: OTHER_USER_ID, organization_id: null },
    { kilo_user_id: USER_ID, organization_id: ORGANIZATION_ID },
  ])('does not match a worktree name from another owner or scope: %p', async owner => {
    await db
      .insert(cloud_agent_worktrees)
      .values({ worktree_id: WORKTREE_ID, ...owner, name: 'Private worktree name' });
    expect(
      (
        await createCaller({ user }).search({
          search_string: 'Private worktree name',
          organizationId: null,
        })
      ).results
    ).toEqual([]);
  });

  it('keeps exact organization and worktree filters for names and hides names after membership removal', async () => {
    const orgWorktreeId = newWorktreeId();
    const orgSession = await insertSession({
      cloud_agent_worktree_id: orgWorktreeId,
      organization_id: ORGANIZATION_ID,
    });
    const caller = createCaller({ user });
    await caller.renameWorktree({
      worktreeId: WORKTREE_ID,
      organizationId: null,
      name: 'Shared search name',
    });
    await caller.renameWorktree({
      worktreeId: orgWorktreeId,
      organizationId: ORGANIZATION_ID,
      name: 'Shared search name',
    });

    expect(
      (
        await caller.search({ search_string: 'Shared search name', organizationId: null })
      ).results.map(session => session.session_id)
    ).toEqual([SESSION_ID]);
    expect(
      (
        await caller.search({
          search_string: 'Shared search name',
          organizationId: ORGANIZATION_ID,
          worktreeId: orgWorktreeId,
        })
      ).results.map(session => session.session_id)
    ).toEqual([orgSession.session_id]);
    await db
      .delete(organization_memberships)
      .where(
        and(
          eq(organization_memberships.kilo_user_id, USER_ID),
          eq(organization_memberships.organization_id, ORGANIZATION_ID)
        )
      );
    expect(
      (await caller.search({ search_string: 'Shared search name' })).results.map(
        session => session.session_id
      )
    ).toEqual([SESSION_ID]);
  });

  it('does not use a deleting worktree name for matching', async () => {
    await db.insert(cloud_agent_worktrees).values({
      worktree_id: WORKTREE_ID,
      kilo_user_id: USER_ID,
      name: 'Deleting name',
      deletion_started_at: INITIAL_TIME,
    });
    expect(
      (
        await createCaller({ user }).search({
          search_string: 'Deleting name',
          organizationId: null,
        })
      ).results
    ).toEqual([]);
  });
});

describe('cliSessionsV2 worktree API validation', () => {
  it.each(['worktree_invalid', 'worktree_../../private', `workspace_${UUID}`])(
    'rejects noncanonical worktree IDs across filters and operations: %s',
    async value => {
      const worktreeId = value as CloudAgentWorktreeId;
      const caller = createCaller({ user });
      await expect(caller.list({ worktreeId })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      await expect(caller.search({ search_string: 'Grouped', worktreeId })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
      await expect(
        caller.worktreeDetails({ worktreeIds: [worktreeId], organizationId: null })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      await expect(
        caller.renameWorktree({ worktreeId, organizationId: null, name: 'Valid name' })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      await expect(
        caller.deleteWorktree({ worktreeId, organizationId: null })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(await readWorktree()).toBeUndefined();
      expect(mockWorktreeDelete).not.toHaveBeenCalled();
    }
  );

  it.each(['', '  \n\t', 'x'.repeat(201)])('rejects an invalid worktree name: %p', async name => {
    await expect(
      createCaller({ user }).renameWorktree({ worktreeId: WORKTREE_ID, organizationId: null, name })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(await readWorktree()).toBeUndefined();
  });

  it('validates name length after trimming', async () => {
    await expect(
      createCaller({ user }).renameWorktree({
        worktreeId: WORKTREE_ID,
        organizationId: null,
        name: `  ${'x'.repeat(200)}  `,
      })
    ).resolves.toEqual({ name: 'x'.repeat(200) });
  });

  it('bounds the batch before deduplication and permits empty requests', async () => {
    const caller = createCaller({ user });
    await expect(
      caller.worktreeDetails({
        worktreeIds: Array.from({ length: 201 }, () => WORKTREE_ID),
        organizationId: null,
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller.worktreeDetails({ worktreeIds: [], organizationId: null })
    ).resolves.toEqual({ worktrees: {} });
    expect(
      Object.keys(
        (
          await caller.worktreeDetails({
            worktreeIds: Array.from({ length: 200 }, () => WORKTREE_ID),
            organizationId: null,
          })
        ).worktrees
      )
    ).toEqual([WORKTREE_ID]);
  });

  it.each([undefined, 'not-an-organization-id'])(
    'requires an explicit valid organization scope: %p',
    async organizationId => {
      const caller = createCaller({ user });
      await expect(
        caller.worktreeDetails({ worktreeIds: [WORKTREE_ID], organizationId } as Parameters<
          WorktreeCaller['worktreeDetails']
        >[0])
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      await expect(
        caller.renameWorktree({
          worktreeId: WORKTREE_ID,
          organizationId,
          name: 'Valid name',
        } as Parameters<WorktreeCaller['renameWorktree']>[0])
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      await expect(
        caller.deleteWorktree({ worktreeId: WORKTREE_ID, organizationId } as Parameters<
          WorktreeCaller['deleteWorktree']
        >[0])
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(mockWorktreeDelete).not.toHaveBeenCalled();
    }
  );
});

describe('cliSessionsV2 deleteWorktree adapter', () => {
  it.each([null, ORGANIZATION_ID])(
    'forwards the authenticated exact scope without per-session deletion: %p',
    async organizationId => {
      const deletedSessionIds = Array.from({ length: 205 }, (_, index) => `ses_deleted_${index}`);
      mockWorktreeDelete.mockResolvedValueOnce({ success: true, deletedSessionIds });
      const caller = createCaller({
        user,
        headersList: new Headers({ 'x-client-source': 'browser' }),
      });

      await expect(
        caller.deleteWorktree({ worktreeId: WORKTREE_ID, organizationId })
      ).resolves.toEqual({ success: true, deletedSessionIds });
      expect(mockGenerateCloudAgentToken).toHaveBeenCalledWith(user);
      expect(mockCreateCloudAgentNextClient).toHaveBeenCalledWith('cloud-agent-token');
      expect(mockWorktreeDelete).toHaveBeenCalledTimes(1);
      expect(mockWorktreeDelete).toHaveBeenCalledWith({
        worktreeId: WORKTREE_ID,
        ...(organizationId === null ? {} : { kilocodeOrganizationId: organizationId }),
      });
      expect(mockRuntimeDelete).not.toHaveBeenCalled();
      expect(mockDeleteSessionIngest).not.toHaveBeenCalled();
      expect(await readSessions()).toHaveLength(1);
    }
  );

  it.each([
    ['CONFLICT', 409, 'worktree_deletion_pending'],
    ['SERVICE_UNAVAILABLE', 503, 'worktree_cleanup_failed'],
    ['NOT_FOUND', 404, 'Worktree not found'],
    ['FORBIDDEN', 403, 'Worktree access denied'],
  ])(
    'preserves Worker %s failures rather than returning success',
    async (code, httpStatus, message) => {
      const error = new TRPCClientError(message, {
        result: { error: { code: -32000, message, data: { code, httpStatus } } },
      });
      mockWorktreeDelete.mockRejectedValueOnce(error);
      const before = await readSessions();

      await expect(
        createCaller({ user }).deleteWorktree({ worktreeId: WORKTREE_ID, organizationId: null })
      ).rejects.toMatchObject({ code, message });
      expect(await readSessions()).toEqual(before);
      expect(mockDeleteSessionIngest).not.toHaveBeenCalled();
      expect(mockRuntimeDelete).not.toHaveBeenCalled();
    }
  );

  it('rejects transport failures and unconfirmed Worker output', async () => {
    const caller = createCaller({ user });
    mockWorktreeDelete.mockRejectedValueOnce(new Error('Worker unavailable'));
    await expect(
      caller.deleteWorktree({ worktreeId: WORKTREE_ID, organizationId: null })
    ).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
    mockWorktreeDelete.mockResolvedValueOnce({
      success: false,
      deletedSessionIds: [],
    } as unknown as DeleteWorktreeOutput);
    await expect(
      caller.deleteWorktree({ worktreeId: WORKTREE_ID, organizationId: null })
    ).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
    expect(await readSessions()).toHaveLength(1);
  });

  it.each([null, ORGANIZATION_ID])(
    'allows an authenticated same-owner retry after sessions are gone and only a tombstone remains: %p',
    async organizationId => {
      await db.delete(cli_sessions_v2).where(eq(cli_sessions_v2.session_id, SESSION_ID));
      await db.insert(cloud_agent_worktrees).values({
        worktree_id: WORKTREE_ID,
        kilo_user_id: USER_ID,
        organization_id: organizationId,
        deletion_started_at: INITIAL_TIME,
        deletion_completed_at: LATER_TIME,
        deleted_session_ids: [SESSION_ID],
      });
      const before = await readWorktree();
      const caller = createCaller({ user });
      await expect(
        caller.deleteWorktree({ worktreeId: WORKTREE_ID, organizationId })
      ).resolves.toEqual({ success: true, deletedSessionIds: [SESSION_ID] });
      await expect(
        createCaller({ user }).deleteWorktree({ worktreeId: WORKTREE_ID, organizationId })
      ).resolves.toEqual({ success: true, deletedSessionIds: [SESSION_ID] });
      expect(mockWorktreeDelete).toHaveBeenCalledTimes(2);
      expect(await readWorktree()).toEqual(before);
      expect(await readSessions()).toEqual([]);
    }
  );
});
