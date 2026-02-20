import { db } from '@/lib/drizzle';
import { agent_configs } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import type { CodeReviewAgentConfig } from '@/lib/agent-config/core/types';
import type { Owner } from '@/lib/code-reviews/core';
import { ensureBotUserForOrg } from '@/lib/bot-users/bot-user-service';
import { logExceptInTest, warnExceptInTest } from '@/lib/utils.server';
import { captureException } from '@sentry/nextjs';

/**
 * Gets agent configuration for an organization
 */
export async function getAgentConfig(organizationId: string, agentType: string, platform: string) {
  const [config] = await db
    .select()
    .from(agent_configs)
    .where(
      and(
        eq(agent_configs.owned_by_organization_id, organizationId),
        eq(agent_configs.agent_type, agentType),
        eq(agent_configs.platform, platform)
      )
    )
    .limit(1);

  return config || null;
}

/**
 * Creates or updates agent configuration
 */
export async function upsertAgentConfig(data: {
  organizationId: string;
  agentType: string;
  platform: string;
  config: CodeReviewAgentConfig | Record<string, unknown>;
  isEnabled?: boolean;
  createdBy: string;
}) {
  await db
    .insert(agent_configs)
    .values({
      owned_by_organization_id: data.organizationId,
      agent_type: data.agentType,
      platform: data.platform,
      config: data.config,
      is_enabled: data.isEnabled ?? true,
      created_by: data.createdBy,
    })
    .onConflictDoUpdate({
      target: [
        agent_configs.owned_by_organization_id,
        agent_configs.agent_type,
        agent_configs.platform,
      ],
      set: {
        config: data.config,
        is_enabled: data.isEnabled ?? true,
        updated_at: new Date().toISOString(),
      },
    });

  // Create bot user for code review agents
  if (data.agentType === 'code_review') {
    try {
      await ensureBotUserForOrg(data.organizationId, 'code-review');
    } catch (error) {
      // Log warning but don't fail the config save
      warnExceptInTest('[upsertAgentConfig] Failed to create bot user:', error);
      captureException(error, {
        tags: { operation: 'upsert-agent-config', step: 'ensure-bot-user' },
        extra: { organizationId: data.organizationId, agentType: data.agentType },
      });
    }
  }
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
  await db
    .update(agent_configs)
    .set({
      is_enabled: isEnabled,
      updated_at: new Date().toISOString(),
    })
    .where(
      and(
        eq(agent_configs.owned_by_organization_id, organizationId),
        eq(agent_configs.agent_type, agentType),
        eq(agent_configs.platform, platform)
      )
    );
}

/**
 * Deletes agent configuration
 */
export async function deleteAgentConfig(
  organizationId: string,
  agentType: string,
  platform: string
) {
  await db
    .delete(agent_configs)
    .where(
      and(
        eq(agent_configs.owned_by_organization_id, organizationId),
        eq(agent_configs.agent_type, agentType),
        eq(agent_configs.platform, platform)
      )
    );
}

/**
 * Gets agent configuration for an owner (organization or personal user)
 * Supports both organization and personal user ownership
 */
export async function getAgentConfigForOwner(owner: Owner, agentType: string, platform: string) {
  const conditions = [
    eq(agent_configs.agent_type, agentType),
    eq(agent_configs.platform, platform),
  ];

  // Add owner-specific condition
  if (owner.type === 'org') {
    conditions.push(eq(agent_configs.owned_by_organization_id, owner.id));
  } else {
    conditions.push(eq(agent_configs.owned_by_user_id, owner.id));
  }

  const [config] = await db
    .select()
    .from(agent_configs)
    .where(and(...conditions))
    .limit(1);

  return config || null;
}

/**
 * Creates or updates agent configuration for an owner (organization or personal user)
 * Supports both organization and personal user ownership
 */
export async function upsertAgentConfigForOwner(data: {
  owner: Owner;
  agentType: string;
  platform: string;
  config: CodeReviewAgentConfig | Record<string, unknown>;
  isEnabled?: boolean;
  createdBy: string;
}) {
  const values =
    data.owner.type === 'org'
      ? {
          owned_by_organization_id: data.owner.id,
          owned_by_user_id: null,
          agent_type: data.agentType,
          platform: data.platform,
          config: data.config,
          is_enabled: data.isEnabled ?? true,
          created_by: data.createdBy,
        }
      : {
          owned_by_organization_id: null,
          owned_by_user_id: data.owner.id,
          agent_type: data.agentType,
          platform: data.platform,
          config: data.config,
          is_enabled: data.isEnabled ?? true,
          created_by: data.createdBy,
        };

  const targetColumns =
    data.owner.type === 'org'
      ? [agent_configs.owned_by_organization_id, agent_configs.agent_type, agent_configs.platform]
      : [agent_configs.owned_by_user_id, agent_configs.agent_type, agent_configs.platform];

  await db
    .insert(agent_configs)
    .values(values)
    .onConflictDoUpdate({
      target: targetColumns,
      set: {
        config: data.config,
        is_enabled: data.isEnabled ?? true,
        updated_at: new Date().toISOString(),
      },
    });

  // Create bot user for code review agents (only for organizations)
  if (data.agentType === 'code_review' && data.owner.type === 'org') {
    try {
      await ensureBotUserForOrg(data.owner.id, 'code-review');
    } catch (error) {
      // Log warning but don't fail the config save
      warnExceptInTest('[upsertAgentConfigForOwner] Failed to create bot user:', error);
      captureException(error, {
        tags: { operation: 'upsert-agent-config-owner', step: 'ensure-bot-user' },
        extra: { ownerId: data.owner.id, agentType: data.agentType },
      });
    }
  }
}

/**
 * Enables or disables an agent for an owner (organization or personal user)
 * Supports both organization and personal user ownership
 */
export async function setAgentEnabledForOwner(
  owner: Owner,
  agentType: string,
  platform: string,
  isEnabled: boolean
) {
  const conditions = [
    eq(agent_configs.agent_type, agentType),
    eq(agent_configs.platform, platform),
  ];

  // Add owner-specific condition
  if (owner.type === 'org') {
    conditions.push(eq(agent_configs.owned_by_organization_id, owner.id));
  } else {
    conditions.push(eq(agent_configs.owned_by_user_id, owner.id));
  }

  await db
    .update(agent_configs)
    .set({
      is_enabled: isEnabled,
      updated_at: new Date().toISOString(),
    })
    .where(and(...conditions));
}

/**
 * Resets code review agent config for an owner.
 * Called when the GitLab instance URL changes on reconnection,
 * to clear stale repository selections from the previous instance.
 */
export async function resetCodeReviewConfigForOwner(
  owner: Pick<Owner, 'type' | 'id'>,
  platform: string
): Promise<boolean> {
  const ownerForQuery = {
    ...owner,
    userId: owner.type === 'user' ? owner.id : 'system',
  };

  const config = await getAgentConfigForOwner(ownerForQuery, 'code_review', platform);
  if (!config) {
    return false;
  }

  const existingConfig = config.config as CodeReviewAgentConfig;

  await upsertAgentConfigForOwner({
    owner: ownerForQuery,
    agentType: 'code_review',
    platform,
    config: {
      ...existingConfig,
      selected_repository_ids: [],
      manually_added_repositories: [],
      repository_selection_mode: 'all',
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
