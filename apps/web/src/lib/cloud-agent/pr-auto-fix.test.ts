import { eq } from 'drizzle-orm';
import {
  cli_sessions_v2,
  cloud_agent_user_settings,
  cloud_agent_worktrees,
  cloud_agent_pr_watches,
  github_branch_pull_requests,
  kilocode_users,
  platform_integrations,
} from '@kilocode/db/schema';
import {
  pullRequestAutoFixSettingsSchema,
  watchPrMaintenancePolicySchema,
} from '@kilocode/db/cloud-agent-pr-maintenance';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { enableWatchPr, getPrWatchOptions } from './watch-pr';
import { enablePullRequestAutoFix, enablePullRequestAutoFixWorkspaces } from './pr-auto-fix';

jest.mock('./watch-pr', () => ({
  getPrWatchOptions: jest.fn(),
  enableWatchPr: jest.fn(async () => ({ id: 'synthetic-watch' })),
}));

const settings = pullRequestAutoFixSettingsSchema.parse({
  autoEnable: true,
  model: 'test/auto-fix-model',
  variant: 'careful',
  categories: { reviews: true, failedChecks: false, conflicts: true },
  automaticWritesConsent: true,
  historyRewriteConsent: true,
  noHardSpendCapConsent: true,
});
const profileId = '10000000-0000-4000-8000-000000000001';
const environmentId = '10000000-0000-4000-8000-000000000002';
const integrationId = '10000000-0000-4000-8000-000000000003';

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(getPrWatchOptions).mockResolvedValue({
    canEnable: true,
    defaultIntegrationId: integrationId,
    integrationOptions: [{ integrationId }],
    defaults: { profileId, environmentId },
  } as Awaited<ReturnType<typeof getPrWatchOptions>>);
});

const users: string[] = [];
afterEach(async () => {
  for (const id of users.splice(0)) {
    await db.delete(cloud_agent_pr_watches).where(eq(cloud_agent_pr_watches.kilo_user_id, id));
    await db.delete(cli_sessions_v2).where(eq(cli_sessions_v2.kilo_user_id, id));
    await db
      .delete(github_branch_pull_requests)
      .where(eq(github_branch_pull_requests.owned_by_user_id, id));
    await db.delete(cloud_agent_worktrees).where(eq(cloud_agent_worktrees.kilo_user_id, id));
    await db.delete(kilocode_users).where(eq(kilocode_users.id, id));
  }
});

async function fixture() {
  const user = await insertTestUser({
    google_user_email: `auto-fix-${crypto.randomUUID()}@example.com`,
  });
  users.push(user.id);
  const worktreeId = `worktree_${crypto.randomUUID()}`;
  const sessionId = `ses_${crypto.randomUUID()}`;
  const repoUrl = 'https://github.com/example/repository';
  await db
    .insert(cloud_agent_user_settings)
    .values({ kilo_user_id: user.id, pull_request_auto_fix: settings });
  await db.insert(cloud_agent_worktrees).values({
    worktree_id: worktreeId,
    kilo_user_id: user.id,
    git_url: repoUrl,
    git_branch: 'feature/auto-fix',
  });
  await db.insert(cli_sessions_v2).values({
    session_id: sessionId,
    kilo_user_id: user.id,
    cloud_agent_session_id: `workspace_${crypto.randomUUID()}`,
    cloud_agent_worktree_id: worktreeId,
    title: 'Synthetic PR task',
    git_url: repoUrl,
    git_branch: 'feature/auto-fix',
  });
  await db.insert(github_branch_pull_requests).values({
    owned_by_user_id: user.id,
    git_url: repoUrl,
    git_branch: 'feature/auto-fix',
    pr_url: `${repoUrl}/pull/42`,
    pr_number: 42,
    pr_state: 'open',
  });
  return { user, worktreeId, input: { sessionId, expectedRepoUrl: repoUrl, expectedPrNumber: 42 } };
}

it('uses personal defaults and the current workspace environment and profile', async () => {
  const { user, input } = await fixture();
  await enablePullRequestAutoFix({ user }, input);
  expect(enableWatchPr).toHaveBeenCalledWith(
    { user },
    {
      ...input,
      integrationId,
      policy: expect.objectContaining({
        model: settings.model,
        variant: 'careful',
        categories: settings.categories,
        profileId,
        environmentId,
        automaticWritesConsent: true,
      }),
    }
  );
});

it('requires saved consent before manual enablement', async () => {
  const { user, input } = await fixture();
  await db
    .delete(cloud_agent_user_settings)
    .where(eq(cloud_agent_user_settings.kilo_user_id, user.id));
  await expect(enablePullRequestAutoFix({ user }, input)).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
  });
  expect(enableWatchPr).not.toHaveBeenCalled();
});

it('enables an existing PR workspace once even when it has multiple chats', async () => {
  const { user, worktreeId, input } = await fixture();
  await db.insert(cli_sessions_v2).values({
    session_id: `ses_${crypto.randomUUID()}`,
    kilo_user_id: user.id,
    cloud_agent_session_id: `workspace_${crypto.randomUUID()}`,
    cloud_agent_worktree_id: worktreeId,
  });
  expect(await enablePullRequestAutoFixWorkspaces()).toEqual({ enabled: 1, unavailable: 0 });
  expect(enableWatchPr).toHaveBeenCalledTimes(1);
  expect(enableWatchPr).toHaveBeenCalledWith(
    { user },
    expect.objectContaining({ expectedRepoUrl: input.expectedRepoUrl, expectedPrNumber: 42 })
  );
});

it('does not enroll opted-out, closed, deleted, or blocked workspaces', async () => {
  const { user, worktreeId } = await fixture();
  await db
    .update(cloud_agent_user_settings)
    .set({ pull_request_auto_fix: { ...settings, autoEnable: false } })
    .where(eq(cloud_agent_user_settings.kilo_user_id, user.id));
  expect(await enablePullRequestAutoFixWorkspaces()).toEqual({ enabled: 0, unavailable: 0 });
  await db
    .update(cloud_agent_user_settings)
    .set({ pull_request_auto_fix: settings })
    .where(eq(cloud_agent_user_settings.kilo_user_id, user.id));
  await db
    .update(github_branch_pull_requests)
    .set({ pr_state: 'closed' })
    .where(eq(github_branch_pull_requests.owned_by_user_id, user.id));
  expect(await enablePullRequestAutoFixWorkspaces()).toEqual({ enabled: 0, unavailable: 0 });
  await db
    .update(github_branch_pull_requests)
    .set({ pr_state: 'open' })
    .where(eq(github_branch_pull_requests.owned_by_user_id, user.id));
  await db
    .update(kilocode_users)
    .set({ blocked_at: new Date().toISOString() })
    .where(eq(kilocode_users.id, user.id));
  expect(await enablePullRequestAutoFixWorkspaces()).toEqual({ enabled: 0, unavailable: 0 });
  await db.update(kilocode_users).set({ blocked_at: null }).where(eq(kilocode_users.id, user.id));
  await db
    .update(cloud_agent_worktrees)
    .set({ deletion_started_at: new Date().toISOString() })
    .where(eq(cloud_agent_worktrees.worktree_id, worktreeId));
  expect(await enablePullRequestAutoFixWorkspaces()).toEqual({ enabled: 0, unavailable: 0 });
  expect(enableWatchPr).not.toHaveBeenCalled();
});

it('continues after an unavailable workspace without starting a repair', async () => {
  await fixture();
  jest.mocked(getPrWatchOptions).mockResolvedValueOnce({
    canEnable: false,
    unavailableReason: 'No eligible GitHub connection is available',
  } as Awaited<ReturnType<typeof getPrWatchOptions>>);
  expect(await enablePullRequestAutoFixWorkspaces()).toEqual({ enabled: 0, unavailable: 1 });
  expect(enableWatchPr).not.toHaveBeenCalled();
});

it('does not enroll a session PR from a different workspace branch', async () => {
  const { worktreeId, input } = await fixture();
  await db
    .update(cli_sessions_v2)
    .set({
      platform: 'github',
      pr_url: `${input.expectedRepoUrl}/pull/42`,
      pr_number: 42,
      pr_link_verified_at: new Date().toISOString(),
    })
    .where(eq(cli_sessions_v2.session_id, input.sessionId));
  await db
    .update(cloud_agent_worktrees)
    .set({ git_branch: 'feature/another-pr' })
    .where(eq(cloud_agent_worktrees.worktree_id, worktreeId));
  expect(await enablePullRequestAutoFixWorkspaces()).toEqual({ enabled: 0, unavailable: 0 });
  expect(enableWatchPr).not.toHaveBeenCalled();
});

it.each(['watching', 'paused', 'finished'] as const)(
  'preserves an existing %s watch instead of enabling it again',
  async status => {
    const { user, worktreeId, input } = await fixture();
    const [integration] = await db
      .insert(platform_integrations)
      .values({
        owned_by_user_id: user.id,
        platform: 'github',
        integration_type: 'app',
        platform_installation_id: '123',
      })
      .returning();
    if (!integration) throw new Error('Missing synthetic integration');
    await db.insert(cloud_agent_pr_watches).values({
      kilo_user_id: user.id,
      integration_id: integration.id,
      installation_id: '123',
      github_app_type: 'standard',
      repository_id: '123',
      repo_url: input.expectedRepoUrl,
      pr_number: input.expectedPrNumber,
      source_session_id: input.sessionId,
      source_cloud_agent_session_id: 'workspace_synthetic',
      worktree_id: worktreeId,
      head_ref: 'feature/auto-fix',
      base_ref: 'main',
      head_sha: 'a'.repeat(40),
      base_sha: 'b'.repeat(40),
      status,
      policy: watchPrMaintenancePolicySchema.parse({
        version: 2,
        model: settings.model,
        categories: settings.categories,
        automaticWritesConsent: true,
        historyRewriteConsent: true,
        noHardSpendCapConsent: true,
        profileId: null,
        environmentId: null,
      }),
      projection: {},
    });
    expect(await enablePullRequestAutoFixWorkspaces()).toEqual({ enabled: 0, unavailable: 0 });
    expect(enableWatchPr).not.toHaveBeenCalled();
  }
);

it('bounds each enrollment pass to five workspaces', async () => {
  for (let index = 0; index < 7; index += 1) await fixture();
  expect(await enablePullRequestAutoFixWorkspaces()).toEqual({ enabled: 5, unavailable: 0 });
  expect(enableWatchPr).toHaveBeenCalledTimes(5);
});
