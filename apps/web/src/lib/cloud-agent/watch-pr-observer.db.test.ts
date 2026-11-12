import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  cloud_agent_pr_watches,
  cloud_agent_pr_watch_activity,
  cloud_agent_worktrees,
  kilocode_users,
  platform_integrations,
} from '@kilocode/db/schema';
import { watchPrMaintenancePolicySchema } from '@kilocode/db/cloud-agent-pr-maintenance';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { emptyWatchPrProjection, watchPrProjectionSchema } from './watch-pr-events';
import { collectWatchPrProblems } from './watch-pr-observation';
import { observeWatchPrWebhook } from './watch-pr-webhook';

jest.mock('@/lib/integrations/github/runtime-authorization', () => ({
  assertGitHubInstallationRuntimeAuthorized: jest.fn(async () => undefined),
  GitHubRuntimeAuthorizationError: class extends Error {},
}));
jest.mock('@kilocode/web-shared/lib/redis', () => ({
  redisClient: { eval: jest.fn(async () => 1), zrange: jest.fn(async () => []) },
}));

const policy = watchPrMaintenancePolicySchema.parse({
  version: 2,
  automaticWritesConsent: true,
  historyRewriteConsent: true,
  noHardSpendCapConsent: true,
  model: 'test/model',
  profileId: null,
  environmentId: null,
  categories: { reviews: true, failedChecks: true, conflicts: true },
});
const head = 'a'.repeat(40),
  base = 'b'.repeat(40),
  old = 'c'.repeat(40);
describe('persisted maintenance webhook observations', () => {
  const users: string[] = [];
  afterEach(async () => {
    for (const userId of users.splice(0)) {
      await db
        .delete(cloud_agent_pr_watches)
        .where(eq(cloud_agent_pr_watches.kilo_user_id, userId));
      await db.delete(cloud_agent_worktrees).where(eq(cloud_agent_worktrees.kilo_user_id, userId));
      await db.delete(kilocode_users).where(eq(kilocode_users.id, userId));
    }
  });
  it.each(['standard', 'lite'] as const)(
    'durably batches trusted %s feedback, duplicates, edits, and thread resolution',
    async appType => {
      const user = await insertTestUser();
      users.push(user.id);
      const worktreeId = `worktree_${randomUUID()}`;
      const [integration] = await db
        .insert(platform_integrations)
        .values({
          owned_by_user_id: user.id,
          platform: 'github',
          integration_type: 'app',
          platform_installation_id: '123',
          github_app_type: appType,
          repository_access: 'all',
          permissions: { contents: 'write' },
        })
        .returning();
      if (!integration) throw new Error('Missing integration fixture');
      await db
        .insert(cloud_agent_worktrees)
        .values({ worktree_id: worktreeId, kilo_user_id: user.id });
      const [watch] = await db
        .insert(cloud_agent_pr_watches)
        .values({
          kilo_user_id: user.id,
          integration_id: integration.id,
          installation_id: '123',
          github_app_type: appType,
          repository_id: '456',
          repo_url: 'https://github.com/test/maintenance',
          pr_number: 7,
          source_session_id: `ses_${randomUUID()}`,
          source_cloud_agent_session_id: `workspace_${randomUUID()}`,
          worktree_id: worktreeId,
          head_ref: 'feature',
          base_ref: 'main',
          head_sha: head,
          base_sha: base,
          policy,
          projection: emptyWatchPrProjection(),
          expires_at: null,
        })
        .returning();
      if (!watch) throw new Error('Missing watch fixture');
      const comment = {
        id: 9,
        body: 'Handle an empty list.',
        user: {
          id: 8,
          login: appType === 'lite' ? 'kiloconnect-lite[bot]' : 'kiloconnect[bot]',
          type: 'Bot',
        },
        author_association: 'NONE',
        updated_at: '2026-11-12T12:00:00Z',
        commit_id: old,
      };
      const delivery = {
        eventType: 'pull_request_review_comment',
        appType,
        deliveryId: 'review-created',
        payload: {
          installation: { id: 123 },
          repository: { id: 456 },
          action: 'created',
          pull_request: { number: 7 },
          comment,
        },
      };
      await Promise.all([observeWatchPrWebhook(delivery), observeWatchPrWebhook(delivery)]);
      let stored = await db.query.cloud_agent_pr_watches.findFirst({
        where: eq(cloud_agent_pr_watches.id, watch.id),
      });
      expect(stored).toMatchObject({
        status: 'watching',
        generation: 1,
        pending_revision: 1,
        expires_at: null,
      });
      expect(stored?.pending_since).not.toBeNull();
      expect(stored?.next_run_at).not.toBeNull();
      if (!stored) throw new Error('Missing persisted watch');
      expect(collectWatchPrProblems(stored)).toMatchObject([
        { kind: 'review', commitSha: old, authorLogin: comment.user.login },
      ]);
      const pendingSince = Date.parse(stored.pending_since ?? '');
      await observeWatchPrWebhook({
        ...delivery,
        deliveryId: 'metadata-edit',
        payload: {
          ...delivery.payload,
          action: 'edited',
          comment: {
            ...comment,
            updated_at: '2026-11-12T12:01:00Z',
            body: 'Handle  an empty list. <!-- updated -->',
          },
        },
      });
      stored = await db.query.cloud_agent_pr_watches.findFirst({
        where: eq(cloud_agent_pr_watches.id, watch.id),
      });
      expect(stored?.pending_revision).toBe(1);
      expect(Date.parse(stored?.pending_since ?? '')).toBe(pendingSince);
      await observeWatchPrWebhook({
        ...delivery,
        deliveryId: 'changed-edit',
        payload: {
          ...delivery.payload,
          action: 'edited',
          comment: {
            ...comment,
            updated_at: '2026-11-12T12:02:00Z',
            body: 'Handle a missing list too.',
          },
        },
      });
      await observeWatchPrWebhook({
        ...delivery,
        deliveryId: 'old-edit',
        payload: {
          ...delivery.payload,
          action: 'edited',
          comment: { ...comment, updated_at: '2026-11-12T12:01:00Z', body: 'Old request.' },
        },
      });
      await observeWatchPrWebhook({
        ...delivery,
        deliveryId: 'own-reply',
        payload: {
          ...delivery.payload,
          comment: { ...comment, id: 10, body: 'Published. <!-- kilo-pr-maintenance -->' },
        },
      });
      stored = await db.query.cloud_agent_pr_watches.findFirst({
        where: eq(cloud_agent_pr_watches.id, watch.id),
      });
      expect(stored?.pending_revision).toBe(2);
      expect(watchPrProjectionSchema.parse(stored?.projection).evidence).toMatchObject([
        { body: 'Handle a missing list too.' },
      ]);
      await observeWatchPrWebhook({
        eventType: 'pull_request_review_thread',
        appType,
        deliveryId: 'resolved',
        payload: {
          installation: { id: 123 },
          repository: { id: 456 },
          action: 'resolved',
          pull_request: { number: 7 },
          thread: {
            node_id: 'thread-test',
            updated_at: '2026-11-12T12:03:00Z',
            comments: [comment],
          },
        },
      });
      stored = await db.query.cloud_agent_pr_watches.findFirst({
        where: eq(cloud_agent_pr_watches.id, watch.id),
      });
      expect(watchPrProjectionSchema.parse(stored?.projection).pending).toEqual([]);
      expect(stored?.next_run_at).toBeNull();
      const receipts = await db
        .select()
        .from(cloud_agent_pr_watch_activity)
        .where(eq(cloud_agent_pr_watch_activity.watch_id, watch.id));
      expect(receipts.filter(receipt => receipt.delivery_id === 'review-created')).toHaveLength(1);
    }
  );
});
