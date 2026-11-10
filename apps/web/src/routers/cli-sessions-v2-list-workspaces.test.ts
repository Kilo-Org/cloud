import { beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import {
  cli_sessions_v2,
  cloud_agent_user_settings,
  cloud_agent_worktrees,
  github_branch_pull_requests,
  organization_memberships,
  organizations,
  type NewCliSessionV2,
  type User,
} from '@kilocode/db/schema';
import { eq, inArray, or } from 'drizzle-orm';
import { getBuiltinAgentSettings, setBuiltinAgentSettings } from '@kilocode/cloud-agent-profile';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createCallerFactory } from '@kilocode/web-shared/lib/trpc/init';
import { cliSessionsV2Router } from './cli-sessions-v2-router';
import { cloudAgentSettingsRouter } from './cloud-agent-settings-router';

const USER_ID = 'oauth/github|workspace-list-owner';
const OTHER_USER_ID = 'oauth/github|workspace-list-other';
const ORGANIZATION_ID = '7a283301-b75d-4375-a1ba-e319a02e18b7';
const GIT_URL = 'https://github.com/workspace-list/repository';

type SessionCaller = ReturnType<typeof cliSessionsV2Router.createCaller>;
type SettingsCaller = ReturnType<typeof cloudAgentSettingsRouter.createCaller>;

const createSessionCaller = createCallerFactory(cliSessionsV2Router);
const createSettingsCaller = createCallerFactory(cloudAgentSettingsRouter);

let user: User;
let otherUser: User;

function worktreeId() {
  return `worktree_${crypto.randomUUID()}` as const;
}

function makeSession(
  id: string,
  worktree: string,
  overrides: Partial<NewCliSessionV2> = {}
): NewCliSessionV2 {
  return {
    session_id: id,
    kilo_user_id: USER_ID,
    title: `Chat ${id}`,
    organization_id: null,
    cloud_agent_session_id: `workspace_${crypto.randomUUID()}`,
    cloud_agent_worktree_id: worktree,
    git_url: GIT_URL,
    git_branch: 'feature/one',
    created_on_platform: 'cloud-agent-web',
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    last_activity_at: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

async function insertWorktree(
  worktree: string,
  overrides: Partial<typeof cloud_agent_worktrees.$inferInsert> = {}
) {
  await db.insert(cloud_agent_worktrees).values({
    worktree_id: worktree,
    kilo_user_id: USER_ID,
    ...overrides,
  });
}

async function insertPr(
  worktree: string,
  sessionId: string,
  prState: 'open' | 'draft' | 'merged' = 'open',
  overrides: Partial<NewCliSessionV2> = {}
) {
  const prNumber = overrides.pr_number ?? 42;
  await db.insert(cli_sessions_v2).values(
    makeSession(sessionId, worktree, {
      platform: 'github',
      pr_url: `${GIT_URL}/pull/${prNumber}`,
      pr_number: prNumber,
      pr_head_ref: 'feature/one',
      pr_head_sha: 'head-sha',
      pr_link_verified_at: '2026-08-01T00:00:00.000Z',
      ...overrides,
    })
  );
  await db.insert(github_branch_pull_requests).values({
    git_url: GIT_URL,
    git_branch: 'feature/one',
    owned_by_user_id: USER_ID,
    owned_by_organization_id: null,
    pr_url: `${GIT_URL}/pull/${prNumber}`,
    pr_number: prNumber,
    pr_state: prState,
    pr_title: 'Stacked pull request',
    pr_head_sha: 'head-sha',
    pr_base_ref: 'feature/base',
    stack_number: 2,
    stack_position: 1,
    stack_size: 3,
  });
}

beforeAll(async () => {
  user = await insertTestUser({ id: USER_ID, is_admin: false });
  otherUser = await insertTestUser({ id: OTHER_USER_ID, is_admin: false });
  await db.insert(organizations).values({
    id: ORGANIZATION_ID,
    name: 'Workspace list organization',
    created_by_kilo_user_id: USER_ID,
  });
});

beforeEach(async () => {
  const userIds = [USER_ID, OTHER_USER_ID];
  await db.delete(cli_sessions_v2).where(inArray(cli_sessions_v2.kilo_user_id, userIds));
  await db
    .delete(cloud_agent_worktrees)
    .where(inArray(cloud_agent_worktrees.kilo_user_id, userIds));
  await db
    .delete(cloud_agent_user_settings)
    .where(inArray(cloud_agent_user_settings.kilo_user_id, userIds));
  await db
    .delete(github_branch_pull_requests)
    .where(
      or(
        inArray(github_branch_pull_requests.owned_by_user_id, userIds),
        eq(github_branch_pull_requests.owned_by_organization_id, ORGANIZATION_ID)
      )
    );
  await db
    .delete(organization_memberships)
    .where(inArray(organization_memberships.kilo_user_id, userIds));
  await db.insert(organization_memberships).values({
    kilo_user_id: USER_ID,
    organization_id: ORGANIZATION_ID,
    role: 'member',
  });
});

function sessionCaller(account = user): SessionCaller {
  return createSessionCaller({ user: account });
}

function settingsCaller(account = user): SettingsCaller {
  return createSettingsCaller({ user: account });
}

describe('cliSessionsV2 listWorkspaces', () => {
  it('returns one workspace per worktree with representative sessions, branch, and chat count', async () => {
    const firstWorktree = worktreeId();
    const secondWorktree = worktreeId();
    await insertWorktree(firstWorktree, {
      name: 'First worktree',
      folder_id: null,
      base_branch: 'main',
      base_sha: 'base-sha',
      parent_worktree_id: null,
      sidebar_position: null,
    });
    await db.insert(cli_sessions_v2).values([
      makeSession('ses_000000000000000000000001', firstWorktree, {
        title: 'First chat',
        created_at: '2026-08-01T00:00:00.000Z',
        last_activity_at: '2026-08-03T00:00:00.000Z',
      }),
      makeSession('ses_000000000000000000000002', firstWorktree, {
        title: 'Latest chat',
        created_at: '2026-08-02T00:00:00.000Z',
        last_activity_at: '2026-08-04T00:00:00.000Z',
        status: 'busy',
        status_updated_at: '2026-08-04T00:00:00.000Z',
      }),
      makeSession('ses_000000000000000000000003', secondWorktree, {
        title: 'Second worktree chat',
        created_at: '2026-08-05T00:00:00.000Z',
        last_activity_at: '2026-08-05T00:00:00.000Z',
      }),
    ]);

    const result = await sessionCaller().listWorkspaces({
      organizationId: null,
      sortMode: 'activity',
    });

    expect(result.nextCursor).toBeNull();
    expect(result.truncated).toBe(false);
    expect(result.workspaces).toHaveLength(2);
    expect(result.workspaces[0]).toMatchObject({
      worktreeId: secondWorktree,
      rootSessionId: 'ses_000000000000000000000003',
      latestSessionId: 'ses_000000000000000000000003',
      chatCount: 1,
      gitUrl: GIT_URL,
      branch: 'feature/one',
      lastActivityAt: '2026-08-05T00:00:00.000Z',
    });
    expect(result.workspaces[1]).toMatchObject({
      worktreeId: firstWorktree,
      name: 'First worktree',
      defaultTitle: 'First chat',
      rootSessionId: 'ses_000000000000000000000001',
      latestSessionId: 'ses_000000000000000000000002',
      chatCount: 2,
      baseBranch: 'main',
      status: {
        kind: 'running',
        sessionStatus: 'busy',
      },
    });
  });

  it('includes every no-PR, open, and draft workspace and age-gates merged PRs', async () => {
    const noPr = worktreeId();
    const open = worktreeId();
    const draft = worktreeId();
    const oldMerged = worktreeId();
    const recentMerged = worktreeId();
    await db.insert(cli_sessions_v2).values([
      makeSession('ses_100000000000000000000001', noPr, {
        last_activity_at: '2020-01-01T00:00:00.000Z',
      }),
      makeSession('ses_100000000000000000000002', open, {
        last_activity_at: '2020-01-01T00:00:00.000Z',
      }),
      makeSession('ses_100000000000000000000003', draft, {
        last_activity_at: '2020-01-01T00:00:00.000Z',
      }),
      makeSession('ses_100000000000000000000004', oldMerged, {
        last_activity_at: '2020-01-01T00:00:00.000Z',
      }),
      makeSession('ses_100000000000000000000005', recentMerged, {
        last_activity_at: new Date().toISOString(),
      }),
    ]);
    await insertPr(open, 'ses_200000000000000000000001', 'open');
    await insertPr(draft, 'ses_200000000000000000000002', 'draft', { pr_number: 43 });
    await db.insert(cli_sessions_v2).values([
      makeSession('ses_200000000000000000000003', oldMerged, {
        platform: 'github',
        pr_url: `${GIT_URL}/pull/77`,
        pr_number: 77,
        pr_head_sha: 'head-sha',
        pr_link_verified_at: '2026-08-01T00:00:00.000Z',
        last_activity_at: '2020-01-01T00:00:00.000Z',
      }),
      makeSession('ses_200000000000000000000004', recentMerged, {
        platform: 'github',
        pr_url: `${GIT_URL}/pull/78`,
        pr_number: 78,
        pr_head_sha: 'head-sha',
        pr_link_verified_at: '2026-08-01T00:00:00.000Z',
        last_activity_at: new Date().toISOString(),
      }),
    ]);
    await db.insert(github_branch_pull_requests).values([
      {
        git_url: GIT_URL,
        git_branch: 'feature/one',
        owned_by_user_id: USER_ID,
        pr_url: `${GIT_URL}/pull/77`,
        pr_number: 77,
        pr_state: 'merged',
        pr_title: 'Old merged',
      },
      {
        git_url: GIT_URL,
        git_branch: 'feature/one',
        owned_by_user_id: USER_ID,
        pr_url: `${GIT_URL}/pull/78`,
        pr_number: 78,
        pr_state: 'merged',
        pr_title: 'Recent merged',
      },
    ]);

    const result = await sessionCaller().listWorkspaces({ organizationId: null });
    const ids = result.workspaces.map(workspace => workspace.worktreeId);
    expect(ids).toEqual(expect.arrayContaining([noPr, open, draft, recentMerged]));
    expect(ids).not.toContain(oldMerged);

    const searched = await sessionCaller().listWorkspaces({
      organizationId: null,
      search: 'Old merged',
    });
    expect(searched.workspaces.map(workspace => workspace.worktreeId)).toEqual([oldMerged]);
  });

  it('projects the verified PR stack and base fields', async () => {
    const worktree = worktreeId();
    await insertPr(worktree, 'ses_300000000000000000000001', 'open', { pr_number: 42 });
    const result = await sessionCaller().listWorkspaces({
      organizationId: null,
      search: 'Stacked pull request',
    });
    expect(result.workspaces[0]?.pr).toMatchObject({
      number: 42,
      baseRef: 'feature/base',
      stackNumber: 2,
      stackPosition: 1,
      stackSize: 3,
      state: 'open',
    });
  });

  it('orders null manual positions first by creation and positioned rows bytewise by sidebar position', async () => {
    const unfiledNew = worktreeId();
    const unfiledOld = worktreeId();
    const positionedB = worktreeId();
    const positionedA = worktreeId();
    await insertWorktree(unfiledNew, { created_at: '2026-08-02T00:00:00.000Z' });
    await insertWorktree(unfiledOld, { created_at: '2026-08-01T00:00:00.000Z' });
    await insertWorktree(positionedB, {
      created_at: '2026-08-03T00:00:00.000Z',
      sidebar_position: 'B',
    });
    await insertWorktree(positionedA, {
      created_at: '2026-08-04T00:00:00.000Z',
      sidebar_position: 'a',
    });
    await db
      .insert(cli_sessions_v2)
      .values([
        makeSession('ses_400000000000000000000001', unfiledNew),
        makeSession('ses_400000000000000000000002', unfiledOld),
        makeSession('ses_400000000000000000000003', positionedB),
        makeSession('ses_400000000000000000000004', positionedA),
      ]);

    const result = await sessionCaller().listWorkspaces({
      organizationId: null,
      sortMode: 'manual',
    });
    expect(result.workspaces.map(workspace => workspace.worktreeId)).toEqual([
      unfiledNew,
      unfiledOld,
      positionedB,
      positionedA,
    ]);
  });

  it('sorts created order by worktree creation rather than first chat creation', async () => {
    const olderWorktreeWithNewerChat = worktreeId();
    const newerWorktreeWithOlderChat = worktreeId();
    await insertWorktree(olderWorktreeWithNewerChat, {
      created_at: '2026-08-01T00:00:00.000Z',
    });
    await insertWorktree(newerWorktreeWithOlderChat, {
      created_at: '2026-08-05T00:00:00.000Z',
    });
    await db.insert(cli_sessions_v2).values([
      makeSession('ses_410000000000000000000001', olderWorktreeWithNewerChat, {
        created_at: '2026-08-10T00:00:00.000Z',
      }),
      makeSession('ses_410000000000000000000002', newerWorktreeWithOlderChat, {
        created_at: '2026-08-06T00:00:00.000Z',
      }),
    ]);

    const result = await sessionCaller().listWorkspaces({
      organizationId: null,
      sortMode: 'created',
    });
    expect(result.workspaces.map(workspace => workspace.worktreeId)).toEqual([
      newerWorktreeWithOlderChat,
      olderWorktreeWithNewerChat,
    ]);
  });

  it('surfaces a parent worktree only when its record is in the same scope', async () => {
    const parent = worktreeId();
    const child = worktreeId();
    const foreignParent = worktreeId();
    const foreignChild = worktreeId();
    await insertWorktree(parent);
    await insertWorktree(child, { parent_worktree_id: parent });
    await insertWorktree(foreignParent, { kilo_user_id: OTHER_USER_ID });
    await insertWorktree(foreignChild, { parent_worktree_id: foreignParent });
    await db
      .insert(cli_sessions_v2)
      .values([
        makeSession('ses_420000000000000000000001', child),
        makeSession('ses_420000000000000000000002', foreignChild),
      ]);

    const result = await sessionCaller().listWorkspaces({ organizationId: null });
    const byWorktree = new Map(
      result.workspaces.map(workspace => [workspace.worktreeId, workspace])
    );
    expect(byWorktree.get(child)?.parentWorktreeId).toBe(parent);
    expect(byWorktree.get(foreignChild)?.parentWorktreeId).toBeNull();
  });

  it('uses the stored preference when sortMode is omitted', async () => {
    const older = worktreeId();
    const newer = worktreeId();
    await db.insert(cli_sessions_v2).values([
      makeSession('ses_500000000000000000000001', older, {
        last_activity_at: '2026-08-01T00:00:00.000Z',
        created_at: '2026-08-01T00:00:00.000Z',
      }),
      makeSession('ses_500000000000000000000002', newer, {
        last_activity_at: '2026-08-02T00:00:00.000Z',
        created_at: '2026-08-02T00:00:00.000Z',
      }),
    ]);

    expect(await settingsCaller().getWorkspaceOrder()).toEqual({ workspaceOrder: 'manual' });
    await settingsCaller().setWorkspaceOrder({ workspaceOrder: 'activity' });

    const result = await sessionCaller().listWorkspaces({ organizationId: null });
    expect(result.workspaces.map(workspace => workspace.worktreeId)).toEqual([newer, older]);
  });

  it('pages with a numeric cursor and reports truncation beyond 200 open workspaces', async () => {
    const now = new Date().toISOString();
    const rows = Array.from({ length: 201 }, (_value, index) => {
      const id = worktreeId();
      return {
        worktreeId: id,
        session: makeSession(`ses_${String(index).padStart(26, '0')}`.slice(0, 30), id, {
          last_activity_at: now,
          created_at: now,
        }),
      };
    });
    await db.insert(cli_sessions_v2).values(rows.map(row => row.session));

    const first = await sessionCaller().listWorkspaces({ organizationId: null, limit: 200 });
    expect(first.workspaces).toHaveLength(200);
    expect(first.nextCursor).toBe(200);
    expect(first.truncated).toBe(true);

    const second = await sessionCaller().listWorkspaces({
      organizationId: null,
      limit: 200,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.workspaces).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(second.truncated).toBe(true);

    const searched = await sessionCaller().listWorkspaces({
      organizationId: null,
      limit: 200,
      search: 'worktree_',
    });
    expect(searched.workspaces).toHaveLength(200);
    expect(searched.nextCursor).toBe(200);
    expect(searched.truncated).toBe(false);
  });

  it('keeps personal and organization workspaces in their exact scopes', async () => {
    const personal = worktreeId();
    const organization = worktreeId();
    await insertWorktree(personal);
    await insertWorktree(organization, { organization_id: ORGANIZATION_ID });
    await db.insert(cli_sessions_v2).values([
      makeSession('ses_600000000000000000000001', personal),
      makeSession('ses_600000000000000000000002', organization, {
        organization_id: ORGANIZATION_ID,
      }),
      makeSession('ses_600000000000000000000003', worktreeId(), {
        kilo_user_id: OTHER_USER_ID,
      }),
    ]);

    expect(
      (await sessionCaller().listWorkspaces({ organizationId: null })).workspaces.map(
        workspace => workspace.worktreeId
      )
    ).toEqual([personal]);
    expect(
      (await sessionCaller().listWorkspaces({ organizationId: ORGANIZATION_ID })).workspaces.map(
        workspace => workspace.worktreeId
      )
    ).toEqual([organization]);
  });
});

describe('cliSessionsV2 activity ordering', () => {
  it('orders list and search by coalesced last activity and applies the window to the same key', async () => {
    await db.insert(cli_sessions_v2).values([
      makeSession('ses_700000000000000000000001', worktreeId(), {
        title: 'Stale activity',
        created_at: '2026-08-01T00:00:00.000Z',
        updated_at: '2026-08-20T00:00:00.000Z',
        last_activity_at: '2020-01-01T00:00:00.000Z',
      }),
      makeSession('ses_700000000000000000000002', worktreeId(), {
        title: 'Fresh activity',
        created_at: '2020-01-01T00:00:00.000Z',
        updated_at: '2020-01-01T00:00:00.000Z',
        last_activity_at: '2026-08-21T00:00:00.000Z',
      }),
      makeSession('ses_700000000000000000000003', worktreeId(), {
        title: 'Middle activity',
        created_at: '2026-08-10T00:00:00.000Z',
        last_activity_at: '2026-08-10T00:00:00.000Z',
      }),
    ]);

    const list = await sessionCaller().list({
      orderBy: 'activity',
      updatedSince: '2025-01-01T00:00:00.000Z',
    });
    expect(list.cliSessions.map(session => session.session_id)).toEqual([
      'ses_700000000000000000000002',
      'ses_700000000000000000000003',
    ]);
    expect(new Date(list.cliSessions[0]?.last_activity_at ?? '').toISOString()).toBe(
      '2026-08-21T00:00:00.000Z'
    );

    const search = await sessionCaller().search({
      search_string: 'activity',
      orderBy: 'activity',
    });
    expect(search.results.map(session => session.session_id)).toEqual([
      'ses_700000000000000000000002',
      'ses_700000000000000000000003',
      'ses_700000000000000000000001',
    ]);
  });
});

describe('cloudAgentSettings workspace order', () => {
  it('stores one workspace order per user', async () => {
    expect(await settingsCaller().getWorkspaceOrder()).toEqual({ workspaceOrder: 'manual' });
    await settingsCaller().setWorkspaceOrder({ workspaceOrder: 'created' });
    await settingsCaller().setWorkspaceOrder({ workspaceOrder: 'activity' });

    expect(await settingsCaller().getWorkspaceOrder()).toEqual({ workspaceOrder: 'activity' });
    expect(await settingsCaller(otherUser).getWorkspaceOrder()).toEqual({
      workspaceOrder: 'manual',
    });
  });

  it('keeps built-in agent overrides and the workspace order apart in the shared settings row', async () => {
    const overrides = { explore: { model: 'kilo/anthropic/claude-haiku-4.5' } };
    await setBuiltinAgentSettings(db, USER_ID, overrides);
    await settingsCaller().setWorkspaceOrder({ workspaceOrder: 'created' });
    expect(await getBuiltinAgentSettings(db, USER_ID)).toEqual(overrides);

    await setBuiltinAgentSettings(db, USER_ID, {});
    expect(await settingsCaller().getWorkspaceOrder()).toEqual({ workspaceOrder: 'created' });
  });
});
