import { beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import {
  cli_sessions_v2,
  cloud_agent_sessions,
  cloud_agent_session_runs,
  cloud_agent_user_settings,
  cloud_agent_workspace_folders,
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
import { cloudAgentWorktreeIdSchema } from '@kilocode/session-ingest-contracts';
import { readWorkspaceStackDirectory } from '@/lib/cloud-agent/workspace-read-model-queries';
import { triggerBatchReviewDecisionFetchIfNeeded } from '@/lib/integrations/platforms/github/batch-review-decisions';

jest.mock('next/server', () => ({ after: (callback: () => void) => callback() }));
jest.mock('@/lib/integrations/platforms/github/batch-review-decisions', () => ({
  triggerBatchReviewDecisionFetchIfNeeded: jest.fn(),
}));

const USER_ID = 'oauth/github|workspace-list-owner';
const OTHER_USER_ID = 'oauth/github|workspace-list-other';
const ORGANIZATION_ID = '7a283301-b75d-4375-a1ba-e319a02e18b7';
const GIT_URL = 'https://github.com/workspace-list/repository';
const OLD = '2020-01-01T00:00:00.000Z';
const RECENT = '2026-08-01T00:00:00.000Z';

const createSessionCaller = createCallerFactory(cliSessionsV2Router);
const createSettingsCaller = createCallerFactory(cloudAgentSettingsRouter);
let user: User;
let otherUser: User;
const controlIds: string[] = [];

function worktreeId() {
  return `worktree_${crypto.randomUUID()}` as const;
}

function makeSession(
  id: string,
  worktree: string | null,
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
    created_at: RECENT,
    updated_at: RECENT,
    last_activity_at: RECENT,
    ...overrides,
  };
}

async function insertWorkspace(
  sessions: NewCliSessionV2[],
  overrides: Partial<typeof cloud_agent_worktrees.$inferInsert> = {}
) {
  const first = sessions[0];
  if (!first?.cloud_agent_worktree_id) throw new Error('Workspace fixture needs a root chat');
  await db.insert(cloud_agent_worktrees).values({
    worktree_id: first.cloud_agent_worktree_id,
    kilo_user_id: first.kilo_user_id,
    organization_id: first.organization_id,
    git_url: first.git_url,
    git_branch: first.git_branch,
    created_at: first.created_at,
    last_activity_at: sessions
      .map(session => session.last_activity_at ?? session.created_at ?? RECENT)
      .sort()
      .at(-1),
    ...overrides,
  });
  await db.insert(cli_sessions_v2).values(sessions);
  return cloudAgentWorktreeIdSchema.parse(first.cloud_agent_worktree_id);
}

async function insertPr(
  worktree: string,
  state: 'open' | 'draft' | 'merged' | 'closed',
  number = 42
) {
  const [workspace] = await db
    .select()
    .from(cloud_agent_worktrees)
    .where(eq(cloud_agent_worktrees.worktree_id, worktree));
  if (!workspace?.git_url || !workspace.git_branch) throw new Error('PR fixture needs a checkout');
  await db.insert(github_branch_pull_requests).values({
    git_url: workspace.git_url,
    git_branch: workspace.git_branch,
    owned_by_user_id: workspace.organization_id ? null : workspace.kilo_user_id,
    owned_by_organization_id: workspace.organization_id,
    pr_url: `${workspace.git_url}/pull/${number}`,
    pr_number: number,
    pr_state: state,
    pr_title: `Workspace pull request ${number}`,
    pr_head_sha: 'head-sha',
  });
}

async function insertRun(
  session: NewCliSessionV2,
  overrides: Partial<typeof cloud_agent_session_runs.$inferInsert> = {}
) {
  const controlId = session.cloud_agent_session_id;
  if (!controlId) throw new Error('Run fixture needs a control session');
  await db
    .insert(cloud_agent_sessions)
    .values({
      cloud_agent_session_id: controlId,
      kilo_session_id: session.session_id,
      initial_message_id: crypto.randomUUID(),
      created_at: RECENT,
    })
    .onConflictDoNothing();
  controlIds.push(controlId);
  await db.insert(cloud_agent_session_runs).values({
    cloud_agent_session_id: controlId,
    message_id: crypto.randomUUID(),
    queued_at: RECENT,
    status: 'failed',
    terminal_at: RECENT,
    ...overrides,
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
  jest.clearAllMocks();
  if (controlIds.length)
    await db
      .delete(cloud_agent_sessions)
      .where(inArray(cloud_agent_sessions.cloud_agent_session_id, controlIds.splice(0)));
  const userIds = [USER_ID, OTHER_USER_ID];
  await db.delete(cli_sessions_v2).where(inArray(cli_sessions_v2.kilo_user_id, userIds));
  await db
    .delete(cloud_agent_worktrees)
    .where(inArray(cloud_agent_worktrees.kilo_user_id, userIds));
  await db
    .delete(cloud_agent_user_settings)
    .where(inArray(cloud_agent_user_settings.kilo_user_id, userIds));
  await db
    .delete(cloud_agent_workspace_folders)
    .where(inArray(cloud_agent_workspace_folders.kilo_user_id, userIds));
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
  await db
    .update(organizations)
    .set({ deleted_at: null })
    .where(eq(organizations.id, ORGANIZATION_ID));
  await db
    .insert(organization_memberships)
    .values({ kilo_user_id: USER_ID, organization_id: ORGANIZATION_ID, role: 'member' });
});

function sessionCaller(account = user) {
  return createSessionCaller({ user: account });
}
function settingsCaller(account = user) {
  return createSettingsCaller({ user: account });
}

describe('cliSessionsV2 workspace read model', () => {
  it.each(['list', 'summary'] as const)(
    'starts pending PR review fetching from the %s read',
    async read => {
      const worktree = await insertWorkspace([makeSession('ses_pending_review', worktreeId())]);
      await insertPr(worktree, 'open');
      await db
        .update(github_branch_pull_requests)
        .set({ review_decision_pending: true })
        .where(eq(github_branch_pull_requests.git_url, GIT_URL));
      const result =
        read === 'list'
          ? await sessionCaller().listWorkspaces({ organizationId: null })
          : await sessionCaller().workspaceSummaries({
              organizationId: null,
              worktreeIds: [worktree],
            });
      expect(result.workspaces[0]?.pr?.reviewDecisionPending).toBe(true);
      expect(triggerBatchReviewDecisionFetchIfNeeded).toHaveBeenCalledWith(true, {
        userId: USER_ID,
        organizationId: null,
      });
    }
  );

  it.each([null, OLD])(
    'uses chat activity when workspace activity is %s without a backfill',
    async lastActivity => {
      const worktree = await insertWorkspace([makeSession('ses_legacy_activity', worktreeId())], {
        last_activity_at: lastActivity,
      });
      const result = await sessionCaller().listWorkspaces({ organizationId: null });
      expect(result.workspaces[0]).toMatchObject({ worktreeId: worktree, lastActivityAt: RECENT });
      const summaries = await sessionCaller().workspaceSummaries({
        organizationId: null,
        worktreeIds: [worktree],
      });
      expect(summaries.workspaces[0]?.lastActivityAt).toBe(RECENT);
    }
  );

  it('returns navigation, activity source, checkout, and durable tab summaries', async () => {
    const worktree = worktreeId();
    const now = new Date().toISOString();
    const first = makeSession('ses_first', worktree, {
      title: 'First chat',
      created_at: OLD,
      last_activity_at: OLD,
    });
    const latest = makeSession('ses_latest', worktree, {
      title: 'Latest chat',
      created_at: RECENT,
      last_activity_at: now,
    });
    const active = makeSession('ses_active', worktree, {
      title: 'Active chat',
      created_at: RECENT,
      last_activity_at: RECENT,
      status: 'busy',
      status_updated_at: now,
      updated_at: now,
    });
    const unordered = makeSession('ses_unordered', worktree, { created_at: RECENT });
    await insertWorkspace([first, latest, active, unordered], {
      name: 'Named workspace',
      base_branch: 'main',
      base_sha: 'base-sha',
      closed_session_ids: ['ses_latest', 'missing', 'ses_first'],
      tab_order: ['ses_active', 'missing'],
    });
    const result = await sessionCaller().listWorkspaces({ organizationId: null });
    expect(result).toMatchObject({
      nextCursor: null,
      workspaceOrder: 'manual',
      destinationTotals: { ungrouped: 1 },
      truncated: false,
    });
    expect(result.workspaces).toHaveLength(1);
    expect(result.workspaces[0]).toMatchObject({
      worktreeId: worktree,
      name: 'Named workspace',
      defaultTitle: 'First chat',
      rootSessionId: first.session_id,
      latestSessionId: latest.session_id,
      latestOpenSessionId: unordered.session_id,
      cloudAgentSessionId: unordered.cloud_agent_session_id,
      chatCount: 4,
      openChatCount: 2,
      closedChatCount: 2,
      baseBranch: 'main',
      baseSha: 'base-sha',
      gitUrl: GIT_URL,
      branch: 'feature/one',
      stackRootId: worktree,
      stackDepth: 0,
      destination: { kind: 'ungrouped' },
      status: { kind: 'running', sessionId: active.session_id, sessionStatus: 'busy' },
      hasOpenRun: false,
    });
    expect(result.workspaces[0]).not.toHaveProperty('openChats');
    expect(result.workspaces[0]).not.toHaveProperty('closedChats');
    const caller = sessionCaller();
    const input = { organizationId: null, worktreeId: worktree };
    const open = await caller.workspaceChats({ ...input, tabState: 'open' });
    const closed = await caller.workspaceChats({ ...input, tabState: 'closed' });
    expect(open.chats.map(chat => chat.sessionId)).toEqual(['ses_active', 'ses_unordered']);
    expect(closed.chats.map(chat => chat.sessionId)).toEqual(['ses_latest', 'ses_first']);
    expect(open.chats[0]).toMatchObject({
      title: 'Active chat',
      cloudAgentSessionId: active.cloud_agent_session_id,
      sessionStatusUpdatedAt: now,
    });
    expect(result.workspaces[0]?.status).not.toHaveProperty('latestRunStatus');
  });

  it('does not age-gate completed workspaces or use a chat-linked PR from another checkout', async () => {
    const worktree = await insertWorkspace([
      makeSession('ses_old_done', worktreeId(), { last_activity_at: OLD }),
    ]);
    await insertPr(worktree, 'merged');
    const result = await sessionCaller().listWorkspaces({ organizationId: null });
    expect(result.workspaces[0]).toMatchObject({ worktreeId: worktree, pr: { state: 'merged' } });
    await db
      .update(cloud_agent_worktrees)
      .set({ git_branch: 'different-checkout' })
      .where(eq(cloud_agent_worktrees.worktree_id, worktree));
    await db
      .update(cli_sessions_v2)
      .set({
        platform: 'github',
        pr_url: `${GIT_URL}/pull/42`,
        pr_number: 42,
        pr_link_verified_at: RECENT,
      })
      .where(eq(cli_sessions_v2.session_id, 'ses_old_done'));
    expect(
      (await sessionCaller().listWorkspaces({ organizationId: null })).workspaces[0]?.pr
    ).toBeNull();
  });

  it('loads all selected buckets, caps each independently, and counts stacks rather than layers', async () => {
    const [manual] = await db
      .insert(cloud_agent_workspace_folders)
      .values({ kilo_user_id: USER_ID, name: 'Manual', position: 0 })
      .returning();
    if (!manual) throw new Error('Missing folder');
    await db.insert(cloud_agent_workspace_folders).values(
      ['needs_you', 'in_review', 'done'].map((preset, position) => ({
        kilo_user_id: USER_ID,
        name: preset,
        position: position + 1,
        kind: 'smart' as const,
        smart_preset: preset as 'needs_you' | 'in_review' | 'done',
      }))
    );
    const rows = [
      ...Array.from({ length: 501 }, (_, index) => ({ bucket: 'manual', index })),
      ...Array.from({ length: 501 }, (_, index) => ({ bucket: 'in_review', index })),
      ...Array.from({ length: 501 }, (_, index) => ({ bucket: 'done', index })),
      ...Array.from({ length: 501 }, (_, index) => ({ bucket: 'needs_you', index })),
      ...Array.from({ length: 51 }, (_, index) => ({ bucket: 'ungrouped', index })),
    ].map((row, index) => ({
      ...row,
      worktreeId: worktreeId(),
      sessionId: `ses_bucket_${index}`,
      branch: `bucket/${index}`,
      activity: new Date(Date.parse(RECENT) + index * 1000).toISOString(),
    }));
    await db.insert(cloud_agent_worktrees).values(
      rows.map(row => ({
        worktree_id: row.worktreeId,
        kilo_user_id: USER_ID,
        git_url: GIT_URL,
        git_branch: row.branch,
        folder_id: row.bucket === 'manual' ? manual.id : null,
        last_activity_at: row.activity,
      }))
    );
    await db.insert(cli_sessions_v2).values(
      rows.map(row =>
        makeSession(row.sessionId, row.worktreeId, {
          git_branch: row.branch,
          last_activity_at: row.activity,
          status: row.bucket === 'needs_you' ? 'question' : null,
        })
      )
    );
    await db.insert(github_branch_pull_requests).values(
      rows
        .filter(row => row.bucket === 'in_review' || row.bucket === 'done')
        .map((row, index) => ({
          git_url: GIT_URL,
          git_branch: row.branch,
          owned_by_user_id: USER_ID,
          pr_url: `${GIT_URL}/pull/${index + 1}`,
          pr_number: index + 1,
          pr_state: row.bucket === 'done' ? 'merged' : 'open',
        }))
    );
    const result = await sessionCaller().listWorkspaces({
      organizationId: null,
      limit: 1,
      cursor: 100,
    });
    expect(result.destinationTotals).toEqual({
      [manual.id]: 501,
      in_review: 501,
      done: 501,
      needs_you: 501,
      ungrouped: 51,
    });
    expect(result.workspaces).toHaveLength(2051);
    expect(result.nextCursor).toBeNull();
    expect(result.truncated).toBe(true);
    const ids = new Set(result.workspaces.map(row => row.worktreeId));
    for (const bucket of ['manual', 'in_review', 'done', 'ungrouped']) {
      const bucketRows = rows.filter(row => row.bucket === bucket);
      expect(ids.has(bucketRows[0]?.worktreeId ?? '')).toBe(false);
      expect(ids.has(bucketRows.at(-1)?.worktreeId ?? '')).toBe(true);
    }
    expect(
      rows.filter(row => row.bucket === 'needs_you').every(row => ids.has(row.worktreeId))
    ).toBe(true);
  }, 30000);

  it('uses the newest layer to select ungrouped stacks and shares the stack destination', async () => {
    const parent = worktreeId();
    const child = worktreeId();
    await insertWorkspace([makeSession('ses_stack_parent', parent, { last_activity_at: OLD })]);
    await insertWorkspace(
      [makeSession('ses_stack_child', child, { last_activity_at: new Date().toISOString() })],
      { parent_worktree_id: parent }
    );
    const others = Array.from({ length: 50 }, (_, index) => ({
      worktree: worktreeId(),
      id: `ses_stack_other_${index}`,
    }));
    await db.insert(cloud_agent_worktrees).values(
      others.map(row => ({
        worktree_id: row.worktree,
        kilo_user_id: USER_ID,
        last_activity_at: RECENT,
      }))
    );
    await db.insert(cli_sessions_v2).values(others.map(row => makeSession(row.id, row.worktree)));
    const result = await sessionCaller().listWorkspaces({ organizationId: null });
    expect(result.destinationTotals).toEqual({ ungrouped: 51 });
    expect(result.workspaces).toHaveLength(51);
    expect(result.workspaces.find(row => row.worktreeId === child)).toMatchObject({
      stackRootId: parent,
      stackDepth: 1,
    });
    expect(result.workspaces.some(row => row.worktreeId === parent)).toBe(true);
  });

  it('pages search across hidden rows with a numeric cursor and literal matching', async () => {
    const rows = Array.from({ length: 52 }, (_, index) => ({
      id: worktreeId(),
      session: `ses_search_${index}`,
    }));
    await db.insert(cloud_agent_worktrees).values(
      rows.map((row, index) => ({
        worktree_id: row.id,
        kilo_user_id: USER_ID,
        name: `literal_%_${index}`,
        created_at: new Date(Date.parse(RECENT) + index * 1000).toISOString(),
        last_activity_at: RECENT,
      }))
    );
    await db.insert(cli_sessions_v2).values(rows.map(row => makeSession(row.session, row.id)));
    const first = await sessionCaller().listWorkspaces({
      organizationId: null,
      search: 'literal_%_',
      limit: 50,
      sortMode: 'created',
    });
    expect(first.workspaces).toHaveLength(50);
    expect(first.nextCursor).toBe(50);
    expect(first.truncated).toBe(false);
    const second = await sessionCaller().listWorkspaces({
      organizationId: null,
      search: 'literal_%_',
      limit: 50,
      cursor: first.nextCursor ?? undefined,
      sortMode: 'created',
    });
    expect(second.workspaces).toHaveLength(2);
    expect(second.nextCursor).toBeNull();
    expect(
      new Set([...first.workspaces, ...second.workspaces].map(row => row.worktreeId)).size
    ).toBe(52);
    expect(
      (await sessionCaller().listWorkspaces({ organizationId: null, search: 'nonmatching%' }))
        .workspaces
    ).toEqual([]);
  });

  it('preserves bytewise manual ordering and stored order preference', async () => {
    const ids = [worktreeId(), worktreeId(), worktreeId(), worktreeId()];
    for (const [index, id] of ids.entries()) {
      await insertWorkspace([makeSession(`ses_order_${index}`, id)], {
        created_at: `2026-08-0${index + 1}T00:00:00.000Z`,
        sidebar_position: [null, null, 'a', 'B'][index],
      });
    }
    const result = await sessionCaller().listWorkspaces({ organizationId: null });
    expect(result.workspaces.map(row => row.worktreeId)).toEqual([ids[1], ids[0], ids[3], ids[2]]);
    await settingsCaller().setWorkspaceOrder({ workspaceOrder: 'created' });
    const created = await sessionCaller().listWorkspaces({ organizationId: null });
    expect(created.workspaceOrder).toBe('created');
    expect(created.workspaces.map(row => row.worktreeId)).toEqual([...ids].reverse());
  });

  it('excludes orphan, child-only, placeholder-only, and deleting workspaces', async () => {
    await db.insert(cli_sessions_v2).values(makeSession('ses_orphan', worktreeId()));
    const parent = makeSession('ses_standalone_parent', null);
    await db.insert(cli_sessions_v2).values(parent);
    await insertWorkspace([
      makeSession('ses_child_only', worktreeId(), { parent_session_id: parent.session_id }),
    ]);
    await insertWorkspace([
      makeSession('ses_placeholder', worktreeId(), {
        title: null,
        status: null,
        created_on_platform: 'unknown',
      }),
    ]);
    await insertWorkspace([makeSession('ses_deleting', worktreeId())], {
      deletion_started_at: RECENT,
    });
    expect((await sessionCaller().listWorkspaces({ organizationId: null })).workspaces).toEqual([]);
  });

  it('preserves normalized repository and root platform filters including other', async () => {
    const github = await insertWorkspace([makeSession('ses_filter_github', worktreeId())]);
    const other = await insertWorkspace([
      makeSession('ses_filter_other', worktreeId(), {
        created_on_platform: 'custom-platform',
        git_url: 'https://gitlab.com/workspace-list/repository',
      }),
    ]);
    const filtered = await sessionCaller().listWorkspaces({
      organizationId: null,
      gitUrl: 'git@github.com:workspace-list/repository.git',
      createdOnPlatform: 'cloud-agent-web',
    });
    expect(filtered.workspaces.map(row => row.worktreeId)).toEqual([github]);
    expect(
      (
        await sessionCaller().listWorkspaces({ organizationId: null, createdOnPlatform: 'other' })
      ).workspaces.map(row => row.worktreeId)
    ).toEqual([other]);
    const refreshed = await sessionCaller().workspaceSummaries({
      organizationId: null,
      worktreeIds: [github, other],
      createdOnPlatform: 'other',
    });
    expect(refreshed.workspaces.map(row => row.worktreeId)).toEqual([other]);
  });

  it('keeps owner and organization scopes exact and rejects revoked access', async () => {
    const personal = await insertWorkspace([makeSession('ses_personal', worktreeId())]);
    const organization = await insertWorkspace([
      makeSession('ses_organization', worktreeId(), { organization_id: ORGANIZATION_ID }),
    ]);
    const foreign = await insertWorkspace([
      makeSession('ses_foreign', worktreeId(), { kilo_user_id: OTHER_USER_ID }),
    ]);
    expect(
      (await sessionCaller().listWorkspaces({ organizationId: null })).workspaces.map(
        row => row.worktreeId
      )
    ).toEqual([personal]);
    expect(
      (
        await sessionCaller().workspaceSummaries({
          organizationId: ORGANIZATION_ID,
          worktreeIds: [personal, organization, foreign],
          includeAncestors: true,
        })
      ).workspaces.map(row => row.worktreeId)
    ).toEqual([organization]);
    expect(
      (await sessionCaller().workspaceChats({ organizationId: null, worktreeId: foreign })).chats
    ).toEqual([]);
    await db
      .delete(organization_memberships)
      .where(eq(organization_memberships.kilo_user_id, USER_ID));
    await expect(
      sessionCaller().workspaceSummaries({
        organizationId: ORGANIZATION_ID,
        worktreeIds: [organization],
      })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('does not expose cross-scope parents or PRs', async () => {
    const parent = await insertWorkspace([
      makeSession('ses_foreign_parent', worktreeId(), { kilo_user_id: OTHER_USER_ID }),
    ]);
    const child = await insertWorkspace([makeSession('ses_owned_child', worktreeId())], {
      parent_worktree_id: parent,
    });
    await insertPr(parent, 'open');
    const result = await sessionCaller().workspaceSummaries({
      organizationId: null,
      worktreeIds: [child],
      includeAncestors: true,
    });
    expect(result.workspaces).toHaveLength(1);
    expect(result.workspaces[0]).toMatchObject({
      parentWorktreeId: null,
      stackRootId: child,
      pr: null,
    });
  });

  it('hydrates requested summaries with ancestors and siblings using the same destination', async () => {
    await db.insert(cloud_agent_workspace_folders).values({
      kilo_user_id: USER_ID,
      name: 'Needs you',
      position: 0,
      kind: 'smart',
      smart_preset: 'needs_you',
    });
    const root = await insertWorkspace([makeSession('ses_family_root', worktreeId())]);
    const child = await insertWorkspace([makeSession('ses_family_child', worktreeId())], {
      parent_worktree_id: root,
    });
    const sibling = await insertWorkspace(
      [makeSession('ses_family_sibling', worktreeId(), { status: 'question' })],
      { parent_worktree_id: root }
    );
    const single = await sessionCaller().workspaceSummaries({
      organizationId: null,
      worktreeIds: [child],
    });
    expect(single.workspaces).toHaveLength(1);
    expect(single.workspaces[0]).toMatchObject({
      stackRootId: root,
      stackDepth: 1,
      destination: { kind: 'smart', preset: 'needs_you' },
    });
    const expanded = await sessionCaller().workspaceSummaries({
      organizationId: null,
      worktreeIds: [child],
      includeAncestors: true,
    });
    expect(expanded.workspaces.map(row => row.worktreeId).sort()).toEqual(
      [root, child, sibling].sort()
    );
    expect(expanded.workspaces).toEqual(
      (await sessionCaller().listWorkspaces({ organizationId: null })).workspaces
    );
  });

  it('uses inferred PR stack edges consistently in list and summary reads', async () => {
    const root = await insertWorkspace([
      makeSession('ses_inferred_root', worktreeId(), { git_branch: 'stack/root' }),
    ]);
    const child = await insertWorkspace([
      makeSession('ses_inferred_child', worktreeId(), { git_branch: 'stack/child' }),
    ]);
    await insertPr(root, 'open', 1);
    await insertPr(child, 'open', 2);
    await db
      .update(github_branch_pull_requests)
      .set({ stack_number: 7, stack_position: 1, stack_size: 2 })
      .where(eq(github_branch_pull_requests.pr_number, 1));
    await db
      .update(github_branch_pull_requests)
      .set({ stack_number: 7, stack_position: 2, stack_size: 2, pr_base_ref: 'stack/root' })
      .where(eq(github_branch_pull_requests.pr_number, 2));
    const summary = await sessionCaller().workspaceSummaries({
      organizationId: null,
      worktreeIds: [child],
      includeAncestors: true,
    });
    expect(summary.workspaces.map(row => row.worktreeId)).toEqual([root, child]);
    expect(summary.workspaces[1]).toMatchObject({ stackRootId: root, stackDepth: 1 });
    expect(summary.workspaces).toEqual(
      (await sessionCaller().listWorkspaces({ organizationId: null })).workspaces
    );
  });

  it.each(['queued', 'accepted'] as const)(
    'reports %s only through hasOpenRun, not activity',
    async status => {
      const session = makeSession(`ses_${status}`, worktreeId());
      await insertWorkspace([session]);
      await insertRun(session, { status, queued_at: new Date().toISOString(), terminal_at: null });
      const result = await sessionCaller().listWorkspaces({ organizationId: null });
      expect(result.workspaces[0]).toMatchObject({ hasOpenRun: true, status: { kind: 'idle' } });
    }
  );

  it('lets fresh running work outrank latest-chat failure and ignores older-chat failure', async () => {
    const worktree = worktreeId();
    const now = new Date().toISOString();
    const running = makeSession('ses_running', worktree, {
      status: 'busy',
      updated_at: now,
      status_updated_at: now,
    });
    const failed = makeSession('ses_failed', worktree, { last_activity_at: now });
    await insertWorkspace([running, failed]);
    await insertRun(failed);
    expect(
      (await sessionCaller().listWorkspaces({ organizationId: null })).workspaces[0]?.status
    ).toMatchObject({ kind: 'running', sessionId: running.session_id });
    await db
      .update(cli_sessions_v2)
      .set({ status: 'idle', last_activity_at: new Date(Date.now() + 1000).toISOString() })
      .where(eq(cli_sessions_v2.session_id, running.session_id));
    expect(
      (await sessionCaller().listWorkspaces({ organizationId: null })).workspaces[0]?.status
    ).toMatchObject({ kind: 'idle', sessionId: running.session_id });
  });

  it('uses the latest run when a previous failure would hide an active status', async () => {
    const now = new Date().toISOString();
    const session = makeSession('ses_newer_run', worktreeId(), {
      status: 'busy',
      status_updated_at: now,
      updated_at: now,
    });
    await insertWorkspace([session]);
    await insertRun(session, { queued_at: OLD, terminal_at: '2026-09-01T00:00:00.000Z' });
    await insertRun(session, { status: 'accepted', queued_at: now, terminal_at: null });
    expect(
      (await sessionCaller().listWorkspaces({ organizationId: null })).workspaces[0]
    ).toMatchObject({ hasOpenRun: true, status: { kind: 'running' } });
  });

  it.each(['queued', 'accepted'] as const)(
    'stops polling an orphan %s run after three hours',
    async status => {
      const session = makeSession(`ses_stale_${status}`, worktreeId());
      await insertWorkspace([session]);
      await insertRun(session, {
        status,
        queued_at: new Date(Date.now() - 3 * 60 * 60_000 - 1000).toISOString(),
        terminal_at: null,
      });
      expect(
        (await sessionCaller().listWorkspaces({ organizationId: null })).workspaces[0]
      ).toMatchObject({ hasOpenRun: false, status: { kind: 'idle' } });
    }
  );

  it('does not report an old queued run after a newer run completes', async () => {
    const session = makeSession('ses_completed_after_queue', worktreeId());
    await insertWorkspace([session]);
    await insertRun(session, {
      status: 'queued',
      queued_at: new Date(Date.now() - 1000).toISOString(),
      terminal_at: null,
    });
    await insertRun(session, { status: 'completed', queued_at: new Date().toISOString() });
    expect(
      (await sessionCaller().listWorkspaces({ organizationId: null })).workspaces[0]?.hasOpenRun
    ).toBe(false);
  });

  it('hides the latest run failure after a newer idle status', async () => {
    const session = makeSession('ses_idle_after_failure', worktreeId(), {
      status: 'idle',
      status_updated_at: new Date().toISOString(),
    });
    await insertWorkspace([session]);
    await insertRun(session);
    expect(
      (await sessionCaller().listWorkspaces({ organizationId: null })).workspaces[0]?.status
    ).toMatchObject({ kind: 'idle', latestRunFailureKind: null });
  });

  it('applies literal search to summary refreshes and removes renamed nonmatches', async () => {
    const worktree = await insertWorkspace([makeSession('ses_refresh_search', worktreeId())], {
      name: 'Literal_%_workspace',
    });
    const input = { organizationId: null, worktreeIds: [worktree], search: ' LITERAL_%_ ' };
    expect((await sessionCaller().workspaceSummaries(input)).workspaces).toHaveLength(1);
    await db
      .update(cloud_agent_worktrees)
      .set({ name: 'Different name' })
      .where(eq(cloud_agent_worktrees.worktree_id, worktree));
    expect((await sessionCaller().workspaceSummaries(input)).workspaces).toEqual([]);
  });

  it('keeps list and summary inferred stacks consistent before checkout metadata arrives', async () => {
    const root = await insertWorkspace(
      [makeSession('ses_missing_checkout_root', worktreeId(), { git_branch: 'stack/base' })],
      { git_url: null, git_branch: null }
    );
    const child = await insertWorkspace([
      makeSession('ses_missing_checkout_child', worktreeId(), { git_branch: 'stack/child' }),
    ]);
    await insertWorkspace(
      [makeSession('ses_missing_checkout_unrelated', worktreeId(), { git_branch: 'unrelated' })],
      { git_url: null, git_branch: null }
    );
    await insertWorkspace(
      [
        makeSession('ses_missing_checkout_other_repo', worktreeId(), {
          git_url: 'https://github.com/workspace-list/other',
          git_branch: 'stack/base',
        }),
      ],
      { git_url: null, git_branch: null }
    );
    const stale = worktreeId();
    await insertWorkspace(
      [
        makeSession('ses_missing_checkout_old', stale, {
          git_branch: 'stack/base',
          last_activity_at: OLD,
        }),
        makeSession('ses_missing_checkout_new', stale, { git_branch: 'unrelated' }),
      ],
      { git_url: null, git_branch: null }
    );
    await insertPr(child, 'open', 7);
    await db
      .update(github_branch_pull_requests)
      .set({ pr_base_ref: 'stack/base' })
      .where(eq(github_branch_pull_requests.pr_number, 7));
    const list = await sessionCaller().listWorkspaces({ organizationId: null, gitUrl: GIT_URL });
    const directory = await readWorkspaceStackDirectory({ userId: USER_ID, organizationId: null }, [
      child,
    ]);
    expect(directory.map(row => row.worktreeId).sort()).toEqual([root, child].sort());
    const summary = await sessionCaller().workspaceSummaries({
      organizationId: null,
      worktreeIds: [child],
      includeAncestors: true,
      gitUrl: GIT_URL,
    });
    expect(summary.workspaces).toEqual(list.workspaces.filter(row => row.stackRootId === root));
    expect(summary.workspaces.map(row => row.worktreeId)).toEqual([root, child]);
  });

  it('bounds metadata-free seeds while retaining inferred and explicit stack edges', async () => {
    const root = await insertWorkspace(
      [makeSession('ses_seed_missing_checkout', worktreeId(), { git_branch: 'stack/base' })],
      { git_url: null, git_branch: null }
    );
    const child = await insertWorkspace([
      makeSession('ses_seed_inferred_child', worktreeId(), { git_branch: 'stack/child' }),
    ]);
    const layer = await insertWorkspace(
      [makeSession('ses_seed_explicit_layer', worktreeId(), { git_branch: 'stack/layer' })],
      { parent_worktree_id: root }
    );
    await insertWorkspace([makeSession('ses_seed_unrelated_branch', worktreeId())]);
    await insertWorkspace([
      makeSession('ses_seed_unrelated_repository', worktreeId(), {
        git_url: 'https://github.com/example/unrelated',
      }),
    ]);
    await insertPr(child, 'open', 7);
    await db
      .update(github_branch_pull_requests)
      .set({ pr_base_ref: 'stack/base' })
      .where(eq(github_branch_pull_requests.pr_number, 7));
    const directory = await readWorkspaceStackDirectory({ userId: USER_ID, organizationId: null }, [
      root,
    ]);
    expect(directory.map(row => row.worktreeId).sort()).toEqual([root, child, layer].sort());
    const summaries = await sessionCaller().workspaceSummaries({
      organizationId: null,
      worktreeIds: [root],
      includeAncestors: true,
    });
    expect(summaries.workspaces.map(row => row.worktreeId).sort()).toEqual(
      [root, child, layer].sort()
    );
  });

  it('keeps shared stack inference authoritative when branches have several candidates', async () => {
    const first = 'worktree_00000000-0000-4000-8000-000000000001';
    const last = 'worktree_00000000-0000-4000-8000-000000000002';
    const child = 'worktree_00000000-0000-4000-8000-000000000003';
    await insertWorkspace([
      makeSession('ses_duplicate_branch_first', first, { git_branch: 'stack/base' }),
    ]);
    await insertWorkspace([
      makeSession('ses_duplicate_branch_last', last, { git_branch: 'stack/base' }),
    ]);
    await insertWorkspace([
      makeSession('ses_duplicate_branch_child', child, { git_branch: 'stack/child' }),
    ]);
    await insertPr(child, 'open', 7);
    await db
      .update(github_branch_pull_requests)
      .set({ pr_base_ref: 'stack/base' })
      .where(eq(github_branch_pull_requests.pr_number, 7));
    const summary = await sessionCaller().workspaceSummaries({
      organizationId: null,
      worktreeIds: [child],
      includeAncestors: true,
    });
    expect(summary.workspaces.map(row => row.worktreeId)).toEqual([last, child]);
    expect(summary.workspaces[1]?.stackRootId).toBe(last);
    const list = await sessionCaller().listWorkspaces({ organizationId: null });
    expect(list.workspaces.filter(row => row.stackRootId === last)).toEqual(summary.workspaces);
    expect(list.workspaces.find(row => row.worktreeId === first)?.stackRootId).toBe(first);
    await db
      .update(cli_sessions_v2)
      .set({ created_on_platform: 'custom-platform' })
      .where(eq(cli_sessions_v2.session_id, 'ses_duplicate_branch_last'));
    const filteredSummary = await sessionCaller().workspaceSummaries({
      organizationId: null,
      worktreeIds: [child],
      includeAncestors: true,
      createdOnPlatform: 'cloud-agent-web',
    });
    const filteredList = await sessionCaller().listWorkspaces({
      organizationId: null,
      createdOnPlatform: 'cloud-agent-web',
    });
    expect(filteredSummary.workspaces.map(row => row.worktreeId)).toEqual([first, child]);
    expect(filteredSummary.workspaces).toEqual(filteredList.workspaces);
  });

  it('limits stack metadata to possible edges while retaining inferred and durable layers', async () => {
    const root = await insertWorkspace([
      makeSession('ses_bounded_stack_root', worktreeId(), { git_branch: 'stack/base' }),
    ]);
    const child = await insertWorkspace([
      makeSession('ses_bounded_stack_child', worktreeId(), { git_branch: 'stack/child' }),
    ]);
    const layer = await insertWorkspace(
      [makeSession('ses_bounded_stack_layer', worktreeId(), { git_branch: 'stack/layer' })],
      { parent_worktree_id: child }
    );
    const unrelated = await insertWorkspace([
      makeSession('ses_unrelated_stack_metadata', worktreeId(), { git_branch: 'unrelated' }),
    ]);
    await insertPr(child, 'open', 7);
    await db
      .update(github_branch_pull_requests)
      .set({ pr_base_ref: 'stack/base' })
      .where(eq(github_branch_pull_requests.pr_number, 7));
    const metadata = await readWorkspaceStackDirectory({ userId: USER_ID, organizationId: null }, [
      root,
    ]);
    expect(metadata.map(row => row.worktreeId).sort()).toEqual([root, child, layer].sort());
    expect(metadata.some(row => row.worktreeId === unrelated)).toBe(false);
    const summary = await sessionCaller().workspaceSummaries({
      organizationId: null,
      worktreeIds: [root],
      includeAncestors: true,
    });
    expect(summary.workspaces.map(row => row.worktreeId)).toEqual([root, child, layer]);
  });

  it('drops busy status at three hours and normalizes PostgreSQL timestamps', async () => {
    const session = makeSession('ses_stale', worktreeId(), {
      status: 'busy',
      updated_at: new Date().toISOString(),
      status_updated_at: '2026-04-29 01:16:12.945+00',
      created_at: '2026-04-29 01:16:12.945+00',
    });
    await insertWorkspace([session]);
    const result = await sessionCaller().listWorkspaces({ organizationId: null });
    expect(result.workspaces[0]?.status.kind).toBe('idle');
    const tabs = await sessionCaller().workspaceChats({
      organizationId: null,
      worktreeId: cloudAgentWorktreeIdSchema.parse(session.cloud_agent_worktree_id),
      tabState: 'open',
    });
    expect(tabs.chats[0]?.createdAt).toBe('2026-04-29T01:16:12.945Z');
    expect(tabs.chats[0]?.sessionStatusUpdatedAt).toBe('2026-04-29T01:16:12.945Z');
  });

  it('pages all open and closed tabs independently without changing persisted tab state', async () => {
    const worktree = worktreeId();
    const openIds = Array.from(
      { length: 53 },
      (_, index) => `ses_open_${String(index).padStart(2, '0')}`
    );
    const closedIds = Array.from(
      { length: 23 },
      (_, index) => `ses_closed_${String(index).padStart(2, '0')}`
    ).reverse();
    const tabOrder = openIds.toReversed().slice(0, 52);
    await insertWorkspace(
      [...openIds, ...closedIds].map(id => makeSession(id, worktree)),
      {
        tab_order: tabOrder,
        closed_session_ids: [closedIds[0], 'ses_missing', ...closedIds.slice(1)],
      }
    );
    const caller = sessionCaller();
    const scope = { organizationId: null, worktreeId: worktree };
    const open = await caller.workspaceChats({ ...scope, tabState: 'open', limit: 50 });
    const more = await caller.workspaceChats({
      ...scope,
      tabState: 'open',
      limit: 50,
      cursor: open.nextCursor ?? undefined,
    });
    expect(open.chats.map(chat => chat.sessionId)).toEqual(tabOrder.slice(0, 50));
    expect(more.chats.map(chat => chat.sessionId)).toEqual([...tabOrder.slice(50), openIds[0]]);
    expect(more.nextCursor).toBeNull();
    const closed = await caller.workspaceChats({ ...scope, tabState: 'closed', limit: 20 });
    const older = await caller.workspaceChats({
      ...scope,
      tabState: 'closed',
      limit: 20,
      cursor: closed.nextCursor ?? undefined,
    });
    expect(closed.chats.map(chat => chat.sessionId)).toEqual(closedIds.slice(0, 20));
    expect(older.chats.map(chat => chat.sessionId)).toEqual(closedIds.slice(20));
    expect(older.nextCursor).toBeNull();
    const active = await caller.workspaceChats({ ...scope, sessionId: openIds[0], limit: 1 });
    expect(active.chats).toMatchObject([{ sessionId: openIds[0], tabClosed: false }]);
    const summary = await caller.workspaceSummaries({
      organizationId: null,
      worktreeIds: [worktree],
    });
    expect(summary.workspaces).toMatchObject([
      { chatCount: 76, openChatCount: 53, closedChatCount: 23 },
    ]);
    expect(summary.workspaces[0]).not.toHaveProperty('openChats');
    expect(summary.workspaces[0]).not.toHaveProperty('closedChats');
  });

  it('pages root chats by creation and ID with no age cutoff and preserves microseconds in cursors', async () => {
    const worktree = worktreeId();
    await insertWorkspace([
      makeSession('ses_chat_a', worktree, { created_at: '2020-01-01 00:00:00.123456+00' }),
      makeSession('ses_chat_b', worktree, { created_at: '2020-01-01 00:00:00.123456+00' }),
      makeSession('ses_chat_c', worktree, { created_at: '2020-01-01 00:00:00.123457+00' }),
    ]);
    await db.insert(cli_sessions_v2).values(
      makeSession('ses_chat_child', worktree, {
        parent_session_id: 'ses_chat_a',
        created_at: OLD,
      })
    );
    const first = await sessionCaller().workspaceChats({
      organizationId: null,
      worktreeId: worktree,
      limit: 1,
    });
    expect(first.chats.map(chat => chat.sessionId)).toEqual(['ses_chat_a']);
    expect(first.nextCursor).toEqual({
      createdAt: '2020-01-01T00:00:00.123456Z',
      sessionId: 'ses_chat_a',
    });
    const second = await sessionCaller().workspaceChats({
      organizationId: null,
      worktreeId: worktree,
      limit: 1,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.chats.map(chat => chat.sessionId)).toEqual(['ses_chat_b']);
    const third = await sessionCaller().workspaceChats({
      organizationId: null,
      worktreeId: worktree,
      limit: 1,
      cursor: second.nextCursor ?? undefined,
    });
    expect(third.chats.map(chat => chat.sessionId)).toEqual(['ses_chat_c']);
    expect(third.nextCursor).toBeNull();
    expect(first.chats[0]).not.toHaveProperty('messages');
  });

  it('makes standalone filtering opt-in without changing the general list default', async () => {
    await insertWorkspace([makeSession('ses_workspace_chat', worktreeId())]);
    await db.insert(cli_sessions_v2).values(makeSession('ses_standalone_chat', null));
    expect((await sessionCaller().list({ organizationId: null })).cliSessions).toHaveLength(2);
    expect(
      (await sessionCaller().list({ organizationId: null, standaloneOnly: true })).cliSessions.map(
        row => row.session_id
      )
    ).toEqual(['ses_standalone_chat']);
  });

  it('bounds batched summaries and chat page inputs', async () => {
    await expect(
      sessionCaller().workspaceSummaries({
        organizationId: null,
        worktreeIds: Array.from({ length: 201 }, worktreeId),
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      sessionCaller().workspaceChats({ organizationId: null, worktreeId: worktreeId(), limit: 201 })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(
      await sessionCaller().workspaceSummaries({ organizationId: null, worktreeIds: [] })
    ).toEqual({ workspaces: [] });
  });
});

describe('cloudAgentSettings workspace order', () => {
  it('stores one workspace order per user', async () => {
    expect(await settingsCaller().getWorkspaceOrder()).toEqual({ workspaceOrder: 'manual' });
    await settingsCaller().setWorkspaceOrder({ workspaceOrder: 'activity' });
    expect(await settingsCaller().getWorkspaceOrder()).toEqual({ workspaceOrder: 'activity' });
    expect(await settingsCaller(otherUser).getWorkspaceOrder()).toEqual({
      workspaceOrder: 'manual',
    });
  });

  it('keeps built-in agent overrides and workspace order apart', async () => {
    const overrides = { explore: { model: 'kilo/anthropic/claude-haiku-4.5' } };
    await setBuiltinAgentSettings(db, USER_ID, overrides);
    await settingsCaller().setWorkspaceOrder({ workspaceOrder: 'created' });
    expect(await getBuiltinAgentSettings(db, USER_ID)).toEqual(overrides);
    await setBuiltinAgentSettings(db, USER_ID, {});
    expect(await settingsCaller().getWorkspaceOrder()).toEqual({ workspaceOrder: 'created' });
  });
});
