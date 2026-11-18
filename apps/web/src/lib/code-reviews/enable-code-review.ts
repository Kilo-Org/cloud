import {
  createOrEnableAgentConfigForOwner,
  getAgentConfigForOwner,
  setAgentEnabledForOwner,
  type AgentConfigOwner,
} from '@/lib/agent-config/db/agent-configs';
import { createDefaultCodeReviewConfig } from './core/default-config';

/**
 * Enables or disables Code Reviewer for one owner and platform.
 *
 * An owner that has never saved a configuration has no row to update, so the
 * enable must create one with the default configuration. Otherwise the switch
 * reports enabled while nothing is stored, and the next save creates a
 * disabled row.
 *
 * Returns whether the stored enabled state changed, so a caller can skip an
 * audit entry for a repeat toggle.
 */
export async function setCodeReviewEnabled(params: {
  owner: AgentConfigOwner;
  platform: string;
  isEnabled: boolean;
  createdBy: string;
}): Promise<{ changed: boolean }> {
  const existingConfig = await getAgentConfigForOwner(params.owner, 'code_review', params.platform);

  if (existingConfig) {
    await setAgentEnabledForOwner(params.owner, 'code_review', params.platform, params.isEnabled);
    return { changed: existingConfig.is_enabled !== params.isEnabled };
  }

  if (!params.isEnabled) return { changed: false };

  await createOrEnableAgentConfigForOwner({
    owner: params.owner,
    agentType: 'code_review',
    platform: params.platform,
    createdBy: params.createdBy,
    config: createDefaultCodeReviewConfig(),
  });
  return { changed: true };
}
