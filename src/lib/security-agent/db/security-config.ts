import {
  getAgentConfigForOwner,
  upsertAgentConfigForOwner,
  setAgentEnabledForOwner,
} from '@/lib/agent-config/db/agent-configs';
import type { Owner } from '@/lib/code-reviews/core';
import { DEFAULT_SECURITY_AGENT_CONFIG, parseSecurityAgentConfig } from '../core/constants';
import { SecurityAgentConfigSchema, type SecurityAgentConfig } from '../core/types';
import {
  setOwnerAutoAnalysisEnabledAtNow,
  resetOwnerAutoAnalysisEnabledAt,
} from './security-analysis';

const AGENT_TYPE = 'security_scan';
const DEFAULT_PLATFORM = 'github';

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
} | null> {
  const agentConfig = await getAgentConfigForOwner(owner, AGENT_TYPE, platform);

  if (!agentConfig) {
    return null;
  }

  return {
    storedConfig: agentConfig.config as Partial<SecurityAgentConfig>,
    config: parseSecurityAgentConfig(agentConfig.config),
    isEnabled: agentConfig.is_enabled,
  };
}

export async function upsertSecurityAgentConfig(
  owner: Owner,
  config: Partial<SecurityAgentConfig>,
  createdBy: string,
  platform: string = DEFAULT_PLATFORM
): Promise<void> {
  const existingConfig = await getSecurityAgentConfigWithStatus(owner, platform);
  const fullConfig = parseSecurityAgentConfig({ ...existingConfig?.storedConfig, ...config });

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
