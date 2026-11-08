import { PLATFORM } from '@/lib/integrations/core/constants';
import type { CodeReviewAgentConfig } from '@/lib/agent-config/core/types';

type StoredConfig = CodeReviewAgentConfig | Record<string, unknown>;

/**
 * The repository selection mode a Code Reviewer config may use for a platform.
 *
 * GitLab supports only `selected`: the merge-request handler applies the
 * selected/manually-added allowlist to every delivery, and the PATCH, the full
 * saves and both reads report the same mode. GitHub supports `all`.
 */
export function repositoryModeForPlatform(
  platform: string,
  requested: 'all' | 'selected' | undefined
): 'all' | 'selected' {
  return platform === PLATFORM.GITLAB ? 'selected' : requested || 'all';
}

/**
 * Applies {@link repositoryModeForPlatform} to a config right before it is
 * stored, so a caller that writes a default config (a first enable, an analytics
 * toggle, a reset) cannot leave a GitLab row in a mode its trigger never honors.
 * The API surfaces still pass the mode explicitly; this is the write backstop.
 */
export function withPlatformRepositoryMode(platform: string, config: StoredConfig): StoredConfig {
  if (platform !== PLATFORM.GITLAB) {
    return config;
  }
  return { ...config, repository_selection_mode: 'selected' };
}
