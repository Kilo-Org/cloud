import {
  getAgentConfigForOwner,
  upsertAgentConfigForOwner,
  setAgentEnabledForOwner,
} from '@/lib/agent-config/db/agent-configs';
import type { Owner } from '@/lib/code-reviews/core';
import { db, type DrizzleTransaction } from '@/lib/drizzle';
import { createSecurityAgentCommand, type SecurityAgentCommandOwner } from '@kilocode/db';
import { agent_configs } from '@kilocode/db/schema';
import type { SecurityCommandType } from '@kilocode/app-shared/security-agent';
import { TRPCError } from '@trpc/server';
import { and, eq } from 'drizzle-orm';
import {
  DEFAULT_SECURITY_AGENT_CONFIG,
  mergeSecurityAgentConfigPatch,
  parseSecurityAgentConfig,
} from '../core/constants';
import {
  SecurityAgentConfigSchema,
  type AutoAnalysisMinSeverity,
  type SecurityAgentConfig,
  type SecurityReviewOwner,
} from '../core/types';
import {
  setOwnerAutoAnalysisEnabledAtNow,
  resetOwnerAutoAnalysisEnabledAt,
  enqueueBacklogFindings,
} from './security-analysis';

const AGENT_TYPE = 'security_scan';
const DEFAULT_PLATFORM = 'github';

const SECURITY_CONFIG_CONFLICT_MESSAGE =
  'This configuration changed in another tab. Review the latest settings and save again.';

export async function getSecurityAgentConfig(
  owner: Owner,
  platform: string = DEFAULT_PLATFORM
): Promise<SecurityAgentConfig> {
  const config = await getAgentConfigForOwner(owner, AGENT_TYPE, platform);

  if (!config) {
    return SecurityAgentConfigSchema.parse(DEFAULT_SECURITY_AGENT_CONFIG);
  }

  return parseSecurityAgentConfig(config.config);
}

export async function getSecurityAgentConfigWithStatus(
  owner: Owner,
  platform: string = DEFAULT_PLATFORM
): Promise<{
  config: SecurityAgentConfig;
  storedConfig: Partial<SecurityAgentConfig>;
  isEnabled: boolean;
  configRevision: number;
} | null> {
  const agentConfig = await getAgentConfigForOwner(owner, AGENT_TYPE, platform);

  if (!agentConfig) {
    return null;
  }

  return {
    storedConfig: agentConfig.config as Partial<SecurityAgentConfig>,
    config: parseSecurityAgentConfig(agentConfig.config),
    isEnabled: agentConfig.is_enabled,
    configRevision: agentConfig.config_revision,
  };
}

/**
 * Merge a partial config patch against the stored config, applying the same
 * remediation defaults as the last-write-wins upsert path.
 */
function computeMergedSecurityConfig(
  existingConfig: {
    config: SecurityAgentConfig;
    storedConfig: Partial<SecurityAgentConfig>;
  } | null,
  config: Partial<SecurityAgentConfig>
): SecurityAgentConfig {
  const fullConfig = mergeSecurityAgentConfigPatch(existingConfig?.storedConfig, config);

  const wasAutoRemediationEnabled = existingConfig?.config.auto_remediation_enabled ?? false;
  const isNowAutoRemediationEnabled = fullConfig.auto_remediation_enabled;

  if (
    isNowAutoRemediationEnabled &&
    (!wasAutoRemediationEnabled || !fullConfig.auto_remediation_enabled_at)
  ) {
    fullConfig.auto_remediation_enabled_at = new Date().toISOString();
  }
  if (!fullConfig.remediation_model_slug) {
    fullConfig.remediation_model_slug =
      fullConfig.analysis_model_slug ?? fullConfig.model_slug ?? fullConfig.triage_model_slug;
  }

  return fullConfig;
}

export async function upsertSecurityAgentConfig(
  owner: Owner,
  config: Partial<SecurityAgentConfig>,
  createdBy: string,
  platform: string = DEFAULT_PLATFORM
): Promise<void> {
  const existingConfig = await getSecurityAgentConfigWithStatus(owner, platform);
  const fullConfig = computeMergedSecurityConfig(existingConfig, config);

  const wasAutoAnalysisEnabled = existingConfig?.config.auto_analysis_enabled ?? false;
  const isNowAutoAnalysisEnabled = fullConfig.auto_analysis_enabled;

  await upsertAgentConfigForOwner({
    owner,
    agentType: AGENT_TYPE,
    platform,
    config: fullConfig,
    isEnabled: true,
    createdBy,
  });

  const securityOwner = owner.type === 'org' ? { organizationId: owner.id } : { userId: owner.id };

  if (isNowAutoAnalysisEnabled) {
    if (!wasAutoAnalysisEnabled) {
      // Transitioning OFF → ON: unconditionally reset the timestamp so the
      // time boundary reflects this activation, not a previous one.
      await resetOwnerAutoAnalysisEnabledAt(securityOwner);
    } else {
      // Already enabled: idempotent set (only writes when null) to guard
      // against a prior save where the config committed but timestamp failed.
      await setOwnerAutoAnalysisEnabledAtNow(securityOwner);
    }
  }
}

function toCommandOwner(owner: SecurityReviewOwner): SecurityAgentCommandOwner {
  if ('organizationId' in owner && owner.organizationId) {
    return { type: 'org', id: owner.organizationId };
  }
  if ('userId' in owner && owner.userId) {
    return { type: 'user', id: owner.userId };
  }
  throw new Error('Invalid Security Agent owner');
}

/**
 * Compare-and-set config write inside `tx`.
 *
 * A `null` expectedRevision is a first insert (config_revision = 1); a row
 * already existing means the caller's view was stale, so it conflicts. A
 * non-null expectedRevision updates only when the stored revision still
 * matches; zero affected rows means a concurrent writer won, so it conflicts.
 *
 * Returns the new revision.
 */
async function writeSecurityAgentConfigWithRevision(
  tx: DrizzleTransaction,
  params: {
    owner: Owner;
    fullConfig: SecurityAgentConfig;
    createdBy: string;
    expectedRevision: number | null;
    platform: string;
  }
): Promise<number> {
  const ownerValues =
    params.owner.type === 'org'
      ? { owned_by_organization_id: params.owner.id, owned_by_user_id: null }
      : { owned_by_organization_id: null, owned_by_user_id: params.owner.id };

  if (params.expectedRevision === null) {
    const inserted = await tx
      .insert(agent_configs)
      .values({
        ...ownerValues,
        agent_type: AGENT_TYPE,
        platform: params.platform,
        config: params.fullConfig,
        is_enabled: true,
        created_by: params.createdBy,
        config_revision: 1,
      })
      .onConflictDoNothing()
      .returning({ id: agent_configs.id });

    if (inserted.length === 0) {
      throw new TRPCError({ code: 'CONFLICT', message: SECURITY_CONFIG_CONFLICT_MESSAGE });
    }
    return 1;
  }

  const ownerCondition =
    params.owner.type === 'org'
      ? eq(agent_configs.owned_by_organization_id, params.owner.id)
      : eq(agent_configs.owned_by_user_id, params.owner.id);

  const updated = await tx
    .update(agent_configs)
    .set({
      config: params.fullConfig,
      is_enabled: true,
      updated_at: new Date().toISOString(),
      config_revision: params.expectedRevision + 1,
    })
    .where(
      and(
        ownerCondition,
        eq(agent_configs.agent_type, AGENT_TYPE),
        eq(agent_configs.platform, params.platform),
        eq(agent_configs.config_revision, params.expectedRevision)
      )
    )
    .returning({ id: agent_configs.id });

  if (updated.length === 0) {
    throw new TRPCError({ code: 'CONFLICT', message: SECURITY_CONFIG_CONFLICT_MESSAGE });
  }
  return params.expectedRevision + 1;
}

export type SecurityConfigSaveOutcome = {
  newRevision: number;
  existingFindingsQueuedCount?: number;
  existingRemediationCommandId?: string;
};

/**
 * Compare-and-set security config save. The CAS write, the activation-boundary
 * timestamp, the include-existing analysis enqueue, and the include-existing
 * remediation command creation all share one transaction: if any step throws,
 * the config change rolls back, and no worker can claim a queued backlog row
 * before the boundary it is judged against exists.
 */
export async function saveSecurityAgentConfigWithRevision(params: {
  owner: Owner;
  config: Partial<SecurityAgentConfig>;
  createdBy: string;
  expectedRevision: number | null;
  platform?: string;
  enqueueAnalysis?: { owner: SecurityReviewOwner; minSeverity: AutoAnalysisMinSeverity };
  enqueueRemediation?: { owner: SecurityReviewOwner };
}): Promise<SecurityConfigSaveOutcome> {
  const platform = params.platform ?? DEFAULT_PLATFORM;
  const existingConfig = await getSecurityAgentConfigWithStatus(params.owner, platform);
  const fullConfig = computeMergedSecurityConfig(existingConfig, params.config);

  const wasAutoAnalysisEnabled = existingConfig?.config.auto_analysis_enabled ?? false;
  const isNowAutoAnalysisEnabled = fullConfig.auto_analysis_enabled;

  const securityOwner =
    params.owner.type === 'org' ? { organizationId: params.owner.id } : { userId: params.owner.id };

  const outcome = await db.transaction(async tx => {
    const newRevision = await writeSecurityAgentConfigWithRevision(tx, {
      owner: params.owner,
      fullConfig,
      createdBy: params.createdBy,
      expectedRevision: params.expectedRevision,
      platform,
    });

    // Record the activation boundary in the same transaction as the enqueue
    // below: a worker that claims a queued row must never see a null boundary
    // and skip the finding as ineligible.
    if (isNowAutoAnalysisEnabled) {
      if (!wasAutoAnalysisEnabled) {
        await resetOwnerAutoAnalysisEnabledAt(securityOwner, tx);
      } else {
        await setOwnerAutoAnalysisEnabledAtNow(securityOwner, tx);
      }
    }

    let existingFindingsQueuedCount: number | undefined;
    if (params.enqueueAnalysis) {
      existingFindingsQueuedCount = await enqueueBacklogFindings({
        tx,
        owner: params.enqueueAnalysis.owner,
        autoAnalysisMinSeverity: params.enqueueAnalysis.minSeverity,
        admittedConfigRevision: newRevision,
      });
    }

    let existingRemediationCommandId: string | undefined;
    // Approval-required mode skips the include-existing bulk command: the
    // worker policy would reject every candidate with `approval_required`, and
    // the manual startRemediation path is the approval flow.
    if (params.enqueueRemediation && !fullConfig.auto_remediation_require_approval) {
      const command = await createSecurityAgentCommand(tx, {
        commandType: 'apply_auto_remediation' satisfies SecurityCommandType,
        origin: 'settings_include_existing',
        owner: toCommandOwner(params.enqueueRemediation.owner),
      });
      existingRemediationCommandId = command.id;
    }

    return { newRevision, existingFindingsQueuedCount, existingRemediationCommandId };
  });

  return {
    ...outcome,
  };
}

export async function setSecurityAgentEnabled(
  owner: Owner,
  isEnabled: boolean,
  platform: string = DEFAULT_PLATFORM
): Promise<void> {
  await setAgentEnabledForOwner(owner, AGENT_TYPE, platform, isEnabled);
}

export async function isSecurityAgentEnabled(
  owner: Owner,
  platform: string = DEFAULT_PLATFORM
): Promise<boolean> {
  const config = await getAgentConfigForOwner(owner, AGENT_TYPE, platform);
  return config?.is_enabled ?? false;
}
