import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  cli_sessions_v2,
  cloud_agent_pr_watch_activity,
  cloud_agent_pr_watches,
  cloud_agent_worktrees,
  platform_integrations,
} from '@kilocode/db/schema';
import { watchPrPolicySchema } from '@kilocode/db/schema-types';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { emptyWatchPrProjection, watchPrProjectionSchema } from './watch-pr-events';
import { enableWatchPr, recheckWatchPr } from './watch-pr';
import { observeWatchPrWebhook } from './watch-pr-webhook';

const mockPrGet = jest.fn();
const repoUrl = 'https://github.com/kilo/watch-lifecycle';

jest.mock('@octokit/rest', () => ({
  Octokit: jest.fn(() => ({ pulls: { get: mockPrGet } })),
}));
jest.mock('@kilocode/web-shared/lib/posthog-feature-flags', () => ({
  isReleaseToggleEnabled: jest.fn(async () => true),
}));
jest.mock('@/lib/integrations/github/runtime-authorization', () => ({
  assertGitHubInstallationRuntimeAuthorized: jest.fn(async () => undefined),
  GitHubRuntimeAuthorizationError: class extends Error {},
}));
jest.mock('@/lib/integrations/platforms/github/adapter', () => ({
  generateGitHubInstallationToken: jest.fn(async () => ({ token: 'test', expires_at: null })),
}));
jest.mock('@kilocode/web-shared/lib/redis', () => ({
  redisClient: { eval: jest.fn(async () => 1), zrange: jest.fn(async () => []) },
}));

describe('persisted Watch PR check lifecycle', () => {
  afterEach(async () => {
    await db.delete(cloud_agent_pr_watches).where(eq(cloud_agent_pr_watches.repo_url, repoUrl));
  });

  it.each(['queued', 'waiting', 'requested', 'pending'])(
    'admits %s -> in_progress -> completed without poisoning the projection or recheck',
    async initialState => {
      const user = await insertTestUser();
      const ctx = { user } as Parameters<typeof enableWatchPr>[0];
      const worktreeId = `worktree_${randomUUID()}`;
      const sessionId = `ses_${randomUUID()}`;
      const head = 'a'.repeat(40);
      const base = 'b'.repeat(40);
      const updatedAt = '2026-10-14T12:00:00Z';
      const startedAt = '2026-10-14T12:01:00Z';
      const completedAt = '2026-10-14T12:02:00Z';
      const [integration] = await db
        .insert(platform_integrations)
        .values({
          owned_by_user_id: user.id,
          platform: 'github',
          integration_type: 'app',
          platform_installation_id: '123',
          repository_access: 'all',
          permissions: { contents: 'write' },
        })
        .returning();
      if (!integration) throw new Error('Missing integration fixture');
      await db.insert(cloud_agent_worktrees).values({
        worktree_id: worktreeId,
        kilo_user_id: user.id,
      });
      await db.insert(cli_sessions_v2).values({
        session_id: sessionId,
        kilo_user_id: user.id,
        cloud_agent_worktree_id: worktreeId,
        cloud_agent_session_id: `workspace_${randomUUID()}`,
        git_url: repoUrl,
        git_branch: 'feature',
        platform: 'github',
        pr_url: `${repoUrl}/pull/42`,
        pr_number: 42,
        pr_head_ref: 'feature',
        pr_head_sha: head,
        pr_link_verified_at: updatedAt,
      });
      mockPrGet.mockResolvedValue({
        data: {
          number: 42,
          state: 'open',
          merged_at: null,
          updated_at: updatedAt,
          head: { ref: 'feature', sha: head, repo: { id: 456, full_name: 'Kilo/Watch-Lifecycle' } },
          base: { ref: 'main', sha: base, repo: { id: 456, full_name: 'Kilo/Watch-Lifecycle' } },
        },
      });
      const watch = await enableWatchPr(ctx, {
        sessionId,
        expectedRepoUrl: repoUrl,
        expectedPrNumber: 42,
        integrationId: integration.id,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        policy: watchPrPolicySchema.parse({
          version: 1,
          model: 'test/model',
          profileId: null,
          categories: { reviews: true, failedChecks: true, baseUpdates: true },
          branchStrategy: 'merge',
          historyRewriteConsent: false,
          maxAttemptsPerProblem: 2,
          maxTotalAttempts: 10,
          observationOnlyConsent: true,
          futureEventsOnlyConsent: true,
          noHardSpendCapConsent: true,
        }),
      });
      const persisted = [];
      for (const state of [initialState, 'in_progress', 'completed']) {
        await observeWatchPrWebhook({
          eventType: 'check_run',
          deliveryId: `${watch.id}-${state}`,
          appType: 'standard',
          payload: {
            installation: { id: 123 },
            repository: { id: 456 },
            action: state === initialState ? 'created' : state,
            check_run: {
              id: 10,
              head_sha: head,
              name: 'tests',
              app: { id: 7 },
              status: state,
              conclusion: state === 'completed' ? 'success' : null,
              started_at: state === initialState ? null : startedAt,
              completed_at: state === 'completed' ? completedAt : null,
              pull_requests: [],
            },
          },
        });
        const stored = await db.query.cloud_agent_pr_watches.findFirst({
          where: eq(cloud_agent_pr_watches.id, watch.id),
        });
        persisted.push(watchPrProjectionSchema.parse(stored?.projection));
      }
      const rechecked = await recheckWatchPr(ctx, { watchId: watch.id, generation: 1 });
      const stored = await db.query.cloud_agent_pr_watches.findFirst({
        where: eq(cloud_agent_pr_watches.id, watch.id),
      });
      expect(persisted).toMatchObject(
        [initialState, 'in_progress', 'completed'].map(state => ({
          ambiguous: false,
          needsAttention: false,
          pending: [],
          evidence: [{ state, objectId: '10', attempt: 1 }],
        }))
      );
      expect(rechecked.projection).toMatchObject({
        ...emptyWatchPrProjection(updatedAt),
        evidence: [expect.objectContaining({ state: 'completed', conclusion: 'success' })],
      });
      expect(stored?.projection).toEqual(rechecked.projection);
      expect(stored?.generation).toBe(2);
      const activity = await db
        .select()
        .from(cloud_agent_pr_watch_activity)
        .where(eq(cloud_agent_pr_watch_activity.watch_id, watch.id));
      expect(activity.filter(item => item.kind === 'observation')).toHaveLength(3);
      expect(activity.filter(item => item.kind === 'manual_recheck')).toHaveLength(1);
    }
  );
});
