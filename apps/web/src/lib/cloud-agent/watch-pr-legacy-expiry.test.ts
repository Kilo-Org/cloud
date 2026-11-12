import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { cloud_agent_pr_watches, platform_integrations } from '@kilocode/db/schema';
import {
  watchPrMaintenancePolicySchema,
  watchPrPolicyV1Schema,
} from '@kilocode/db/cloud-agent-pr-maintenance';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { emptyWatchPrProjection } from './watch-pr-events';
import {
  finishExpiredLegacyWatches,
  isLegacyWatchExpired,
  watchPrConsentExpiry,
} from './watch-pr-legacy-expiry';

const v1 = watchPrPolicyV1Schema.parse({
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
});
const v2 = watchPrMaintenancePolicySchema.parse({
  version: 2,
  model: 'test/model',
  profileId: null,
  environmentId: null,
  categories: { reviews: true, failedChecks: true, conflicts: true },
  automaticWritesConsent: true,
  historyRewriteConsent: true,
  noHardSpendCapConsent: true,
});

it('limits only legacy observation consent to its original deadline', () => {
  expect(isLegacyWatchExpired({ policy: v1, expires_at: '2020-01-01T00:00:00Z' })).toBe(true);
  expect(isLegacyWatchExpired({ policy: v2, expires_at: '2020-01-01T00:00:00Z' })).toBe(false);
  expect(watchPrConsentExpiry(v2)).toBeNull();
  expect(() => watchPrConsentExpiry(v1)).toThrow();
  expect(() => watchPrConsentExpiry(v1, new Date(Date.now() + 86_401_000).toISOString())).toThrow();
});

it('releases an abandoned expired legacy PR across owners without expiring v2', async () => {
  const owner = await insertTestUser();
  const other = await insertTestUser();
  const [integration] = await db
    .insert(platform_integrations)
    .values({
      owned_by_user_id: owner.id,
      platform: 'github',
      integration_type: 'app',
      platform_installation_id: '101',
    })
    .returning();
  if (!integration) throw new Error('Missing integration');
  const repositoryId = randomUUID();
  const common = {
    integration_id: integration.id,
    installation_id: '101',
    github_app_type: 'standard' as const,
    repository_id: repositoryId,
    repo_url: 'https://github.com/example/legacy-expiry',
    pr_number: 1,
    source_session_id: 'ses_source',
    source_cloud_agent_session_id: `workspace_${randomUUID()}`,
    worktree_id: `worktree_${randomUUID()}`,
    head_ref: 'feature',
    base_ref: 'main',
    head_sha: 'a'.repeat(40),
    base_sha: 'b'.repeat(40),
    projection: emptyWatchPrProjection(),
    expires_at: '2020-01-01T00:00:00Z',
  };
  const [legacy] = await db
    .insert(cloud_agent_pr_watches)
    .values({ ...common, kilo_user_id: owner.id, policy: v1 })
    .returning();
  if (!legacy) throw new Error('Missing legacy watch');
  const ids = [legacy.id];
  try {
    await expect(
      db.insert(cloud_agent_pr_watches).values({ ...common, kilo_user_id: other.id, policy: v2 })
    ).rejects.toThrow();
    await finishExpiredLegacyWatches(legacy.id);
    const [replacement] = await db
      .insert(cloud_agent_pr_watches)
      .values({ ...common, kilo_user_id: other.id, policy: v2 })
      .returning();
    if (!replacement) throw new Error('Missing replacement watch');
    ids.push(replacement.id);
    await finishExpiredLegacyWatches(replacement.id);
    expect(
      await db.query.cloud_agent_pr_watches.findFirst({
        where: eq(cloud_agent_pr_watches.id, legacy.id),
      })
    ).toMatchObject({ status: 'finished', lifecycle_reason: 'expired' });
    expect(
      await db.query.cloud_agent_pr_watches.findFirst({
        where: eq(cloud_agent_pr_watches.id, replacement.id),
      })
    ).toMatchObject({ status: 'watching' });
  } finally {
    await db.delete(cloud_agent_pr_watches).where(inArray(cloud_agent_pr_watches.id, ids));
  }
});
