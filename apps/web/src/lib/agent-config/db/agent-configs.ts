import { db, type DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';
import { agent_configs } from '@kilocode/db/schema';
import { eq, and, sql } from 'drizzle-orm';
import type { CodeReviewAgentConfig } from '@/lib/agent-config/core/types';
import { ensureBotUserForOrg } from '@/lib/bot-users/bot-user-service';
import { logExceptInTest, warnExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import { captureException } from '@sentry/nextjs';
import { assertGitHubAutomationCanBeEnabled } from '@/lib/integrations/github/sharing-compatibility';
import {
  repositoryModeForPlatform,
  withPlatformRepositoryMode,
} from '@/lib/code-reviews/core/repository-mode';

export type AgentConfigOwner = { type: 'org'; id: string } | { type: 'user'; id: string };

/** One stored agent configuration row, as the reader below returns it. */
export type AgentConfigRow = typeof agent_configs.$inferSelect;

/** Returns the owner column values, where exactly one of the two columns is set. */
export function agentConfigOwnerValues(
  owner: AgentConfigOwner
): Pick<typeof agent_configs.$inferInsert, 'owned_by_organization_id' | 'owned_by_user_id'> {
  return owner.type === 'org'
    ? { owned_by_organization_id: owner.id, owned_by_user_id: null }
    : { owned_by_organization_id: null, owned_by_user_id: owner.id };
}

/**
 * Returns the per-owner unique key: one row per owner, agent type and platform.
 * Every insert that can conflict must use this target.
 */
export function agentConfigConflictTarget(owner: AgentConfigOwner) {
  return owner.type === 'org'
    ? [agent_configs.owned_by_organization_id, agent_configs.agent_type, agent_configs.platform]
    : [agent_configs.owned_by_user_id, agent_configs.agent_type, agent_configs.platform];
}

function agentConfigOwnerConditions(owner: AgentConfigOwner, agentType: string, platform: string) {
  return [
    eq(agent_configs.agent_type, agentType),
    eq(agent_configs.platform, platform),
    owner.type === 'org'
      ? eq(agent_configs.owned_by_organization_id, owner.id)
      : eq(agent_configs.owned_by_user_id, owner.id),
  ];
}

/**
 * Checks the GitHub automation sharing guard. It applies when `is_enabled` is true
 * or when a feature flag turns the Code Reviewer on, because both make it post to
 * repositories.
 */
export async function assertAgentConfigCanBeEnabled(input: {
  owner: AgentConfigOwner;
  platform: string;
  enabled: boolean;
  executor?: typeof db | DrizzleTransaction;
}): Promise<void> {
  if (input.platform === 'github' && input.enabled) {
    await assertGitHubAutomationCanBeEnabled(input.owner, input.executor ?? db);
  }
}

type AgentConfigUpsertOptions = {
  preserveCodeReviewFeatureSettings?: boolean;
};

function configForAtomicUpdate(
  config: CodeReviewAgentConfig | Record<string, unknown>,
  options: AgentConfigUpsertOptions
) {
  if (!options.preserveCodeReviewFeatureSettings) {
    return config;
  }

  const serializedConfig = JSON.stringify(config);
  if (serializedConfig === undefined) {
    throw new Error('Agent config must be JSON serializable');
  }

  return sql<CodeReviewAgentConfig | Record<string, unknown>>`jsonb_set(
    jsonb_set(
      ${serializedConfig}::jsonb,
      '{review_memory_enabled}',
      CASE
        WHEN jsonb_typeof(${agent_configs.config}->'review_memory_enabled') = 'boolean'
          THEN ${agent_configs.config}->'review_memory_enabled'
        ELSE 'false'::jsonb
      END,
      true
    ),
    '{review_analytics_enabled}',
    CASE
      WHEN jsonb_typeof(${agent_configs.config}->'review_analytics_enabled') = 'boolean'
        THEN ${agent_configs.config}->'review_analytics_enabled'
      ELSE 'false'::jsonb
    END,
    true
  )`;
}

/**
 * Gets agent configuration for an organization
 */
export async function getAgentConfig(organizationId: string, agentType: string, platform: string) {
  return getAgentConfigForOwner({ type: 'org', id: organizationId }, agentType, platform);
}

/**
 * Creates or updates agent configuration
 */
export async function upsertAgentConfig(
  data: {
    organizationId: string;
    agentType: string;
    platform: string;
    config: CodeReviewAgentConfig | Record<string, unknown>;
    isEnabled?: boolean;
    createdBy: string;
  } & AgentConfigUpsertOptions
) {
  const { organizationId, ...rest } = data;
  return upsertAgentConfigForOwner({
    owner: { type: 'org', id: organizationId },
    ...rest,
  });
}

/**
 * Enables or disables an agent
 */
export async function setAgentEnabled(
  organizationId: string,
  agentType: string,
  platform: string,
  isEnabled: boolean
) {
  return setAgentEnabledForOwner(
    { type: 'org', id: organizationId },
    agentType,
    platform,
    isEnabled
  );
}

/**
 * Gets agent configuration for an owner (organization or personal user)
 * Supports both organization and personal user ownership
 */
export async function getAgentConfigForOwner(
  owner: AgentConfigOwner,
  agentType: string,
  platform: string
) {
  const [config] = await db
    .select()
    .from(agent_configs)
    .where(and(...agentConfigOwnerConditions(owner, agentType, platform)))
    .limit(1);

  return config || null;
}

/**
 * Creates or updates agent configuration for an owner (organization or personal user)
 * Supports both organization and personal user ownership
 */
export async function upsertAgentConfigForOwner(
  data: {
    owner: AgentConfigOwner;
    agentType: string;
    platform: string;
    config: CodeReviewAgentConfig | Record<string, unknown>;
    isEnabled?: boolean;
    createdBy: string;
  } & AgentConfigUpsertOptions
) {
  const config =
    data.agentType === 'code_review'
      ? withPlatformRepositoryMode(data.platform, data.config)
      : data.config;
  const updateSet = {
    config: configForAtomicUpdate(config, data),
    updated_at: new Date().toISOString(),
    ...(data.isEnabled !== undefined ? { is_enabled: data.isEnabled } : {}),
  };

  const values = {
    ...agentConfigOwnerValues(data.owner),
    agent_type: data.agentType,
    platform: data.platform,
    config,
    is_enabled: data.isEnabled ?? false,
    created_by: data.createdBy,
  };

  await db.transaction(async tx => {
    await assertAgentConfigCanBeEnabled({
      owner: data.owner,
      platform: data.platform,
      enabled: data.isEnabled === true,
      executor: tx,
    });
    await tx
      .insert(agent_configs)
      .values(values)
      .onConflictDoUpdate({
        target: agentConfigConflictTarget(data.owner),
        set: updateSet,
      });
  });

  // Create bot user for code review agents (only for organizations)
  if (data.agentType === 'code_review' && data.owner.type === 'org') {
    try {
      await ensureBotUserForOrg(data.owner.id, 'code-review');
    } catch (error) {
      // Log warning but don't fail the config save
      warnExceptInTest('[upsertAgentConfig] Failed to create bot user:', error);
      captureException(error, {
        tags: { operation: 'upsert-agent-config', step: 'ensure-bot-user' },
        extra: {
          ownerType: data.owner.type,
          ownerId: data.owner.id,
          agentType: data.agentType,
        },
      });
    }
  }
}

/**
 * Enables or disables an agent for an owner (organization or personal user)
 * Supports both organization and personal user ownership
 */
export async function setAgentEnabledForOwner(
  owner: AgentConfigOwner,
  agentType: string,
  platform: string,
  isEnabled: boolean
) {
  await db.transaction(async tx => {
    await assertAgentConfigCanBeEnabled({
      owner,
      platform,
      enabled: isEnabled,
      executor: tx,
    });
    await tx
      .update(agent_configs)
      .set({
        is_enabled: isEnabled,
        updated_at: new Date().toISOString(),
      })
      .where(and(...agentConfigOwnerConditions(owner, agentType, platform)));
  });
}

/**
 * Resets code review agent config for an owner.
 * Called when the GitLab instance URL changes on reconnection,
 * to clear stale repository selections from the previous instance.
 */
export async function resetCodeReviewConfigForOwner(
  owner: AgentConfigOwner,
  platform: string
): Promise<boolean> {
  const config = await getAgentConfigForOwner(owner, 'code_review', platform);
  if (!config) {
    return false;
  }

  const existingConfig = config.config as CodeReviewAgentConfig;

  await upsertAgentConfigForOwner({
    owner,
    agentType: 'code_review',
    platform,
    config: {
      ...existingConfig,
      selected_repository_ids: [],
      manually_added_repositories: [],
      // repositoryModeForPlatform owns the GitLab-only mode rule.
      repository_selection_mode: repositoryModeForPlatform(platform, 'all'),
    },
    isEnabled: false,
    createdBy: 'system',
  });

  logExceptInTest('[resetCodeReviewConfigForOwner] Reset config due to instance URL change', {
    ownerType: owner.type,
    ownerId: owner.id,
    platform,
  });

  return true;
}
