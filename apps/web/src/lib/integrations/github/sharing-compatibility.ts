import 'server-only';

import { db, type DrizzleTransaction } from '@/lib/drizzle';
import { INTEGRATION_STATUS, PLATFORM } from '@/lib/integrations/core/constants';
import type { Owner } from '@/lib/integrations/core/types';
import { TRPCError } from '@trpc/server';
import { hasPendingProviderOAuthAttempt } from '@/lib/integrations/provider-oauth-attempts';
import {
  agent_configs,
  app_builder_projects,
  bot_requests,
  cloud_agent_code_reviews,
  deployments,
  github_app_installations,
  platform_integrations,
} from '@kilocode/db/schema';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';

export type GitHubSharingCompatibilityResult =
  | { compatible: true }
  | {
      compatible: false;
      reason:
        | 'active_automation'
        | 'active_chat'
        | 'active_provider_attempt'
        | 'active_review'
        | 'active_bot_request'
        | 'deployment'
        | 'app_builder';
    };

export async function evaluateGitHubSharingCompatibility(
  tx: DrizzleTransaction,
  canonicalInstallationId: string,
  destinationOwner: Owner
): Promise<GitHubSharingCompatibilityResult> {
  const associations = await tx
    .select({
      id: platform_integrations.id,
      organizationId: platform_integrations.owned_by_organization_id,
      userId: platform_integrations.owned_by_user_id,
    })
    .from(platform_integrations)
    .where(
      and(
        eq(platform_integrations.platform, PLATFORM.GITHUB),
        eq(platform_integrations.github_installation_id, canonicalInstallationId)
      )
    )
    .for('update');

  if (associations.length === 0) return { compatible: true };

  const ownerLockKeys = new Set([
    `${destinationOwner.type}:${destinationOwner.id}`,
    ...associations.map(association =>
      association.organizationId
        ? `org:${association.organizationId}`
        : `user:${association.userId ?? ''}`
    ),
  ]);
  for (const ownerLockKey of [...ownerLockKeys].sort()) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${ownerLockKey}))`);
  }
  const participatingOwners: Owner[] = [
    destinationOwner,
    ...associations.map(association =>
      association.organizationId
        ? { type: 'org' as const, id: association.organizationId }
        : { type: 'user' as const, id: association.userId ?? '' }
    ),
  ];
  if (await hasPendingProviderOAuthAttempt(tx, participatingOwners)) {
    return { compatible: false, reason: 'active_provider_attempt' };
  }

  const ownerConditions = [
    ...associations.map(association =>
      association.organizationId
        ? eq(agent_configs.owned_by_organization_id, association.organizationId)
        : eq(agent_configs.owned_by_user_id, association.userId ?? '')
    ),
    destinationOwner.type === 'org'
      ? eq(agent_configs.owned_by_organization_id, destinationOwner.id)
      : eq(agent_configs.owned_by_user_id, destinationOwner.id),
  ];
  const [activeAutomation] = await tx
    .select({ id: agent_configs.id })
    .from(agent_configs)
    .where(
      and(
        or(...ownerConditions),
        eq(agent_configs.platform, PLATFORM.GITHUB),
        or(
          eq(agent_configs.is_enabled, true),
          sql`${agent_configs.config}->>'review_memory_enabled' = 'true'`
        )
      )
    )
    .limit(1);
  if (activeAutomation) return { compatible: false, reason: 'active_automation' };

  const slackOwnerConditions = [
    ...associations.map(association =>
      association.organizationId
        ? eq(platform_integrations.owned_by_organization_id, association.organizationId)
        : eq(platform_integrations.owned_by_user_id, association.userId ?? '')
    ),
    destinationOwner.type === 'org'
      ? eq(platform_integrations.owned_by_organization_id, destinationOwner.id)
      : eq(platform_integrations.owned_by_user_id, destinationOwner.id),
  ];
  const [activeChat] = await tx
    .select({ id: platform_integrations.id })
    .from(platform_integrations)
    .where(
      and(
        or(...slackOwnerConditions),
        inArray(platform_integrations.platform, [PLATFORM.DISCORD, PLATFORM.LINEAR]),
        eq(platform_integrations.integration_status, INTEGRATION_STATUS.ACTIVE),
        isNull(platform_integrations.suspended_at),
        isNull(platform_integrations.auth_invalid_at)
      )
    )
    .limit(1);
  if (activeChat) return { compatible: false, reason: 'active_chat' };

  const associationIds = associations.map(association => association.id);
  const [activeReview] = await tx
    .select({ id: cloud_agent_code_reviews.id })
    .from(cloud_agent_code_reviews)
    .where(
      and(
        inArray(cloud_agent_code_reviews.platform_integration_id, associationIds),
        inArray(cloud_agent_code_reviews.status, ['pending', 'queued', 'running'])
      )
    )
    .limit(1);
  if (activeReview) return { compatible: false, reason: 'active_review' };

  const [activeBotRequest] = await tx
    .select({ id: bot_requests.id })
    .from(bot_requests)
    .where(
      and(
        inArray(bot_requests.platform_integration_id, associationIds),
        eq(bot_requests.status, 'pending')
      )
    )
    .limit(1);
  if (activeBotRequest) return { compatible: false, reason: 'active_bot_request' };

  const [deployment] = await tx
    .select({ id: deployments.id })
    .from(deployments)
    .where(inArray(deployments.platform_integration_id, associationIds))
    .limit(1);
  if (deployment) return { compatible: false, reason: 'deployment' };

  const [appBuilderProject] = await tx
    .select({ id: app_builder_projects.id })
    .from(app_builder_projects)
    .where(inArray(app_builder_projects.git_platform_integration_id, associationIds))
    .limit(1);
  if (appBuilderProject) return { compatible: false, reason: 'app_builder' };

  return { compatible: true };
}

export async function assertGitHubAutomationCanBeEnabled(
  owner: Owner,
  executor: typeof db | DrizzleTransaction = db
): Promise<void> {
  await executor.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`${owner.type}:${owner.id}`}))`
  );
  const ownerCondition =
    owner.type === 'org'
      ? eq(platform_integrations.owned_by_organization_id, owner.id)
      : eq(platform_integrations.owned_by_user_id, owner.id);
  const [shared] = await executor
    .select({ id: platform_integrations.id })
    .from(platform_integrations)
    .innerJoin(
      github_app_installations,
      eq(platform_integrations.github_installation_id, github_app_installations.id)
    )
    .where(
      and(
        ownerCondition,
        eq(platform_integrations.platform, PLATFORM.GITHUB),
        eq(github_app_installations.sharing_mode, 'web_cloud_agent')
      )
    )
    .limit(1);
  if (shared) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'This workflow is not available for shared GitHub installations yet',
    });
  }
}
