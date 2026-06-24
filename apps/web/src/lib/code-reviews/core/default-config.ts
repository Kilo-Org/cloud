import { PRIMARY_DEFAULT_MODEL } from '@/lib/ai-gateway/models';
import type { CodeReviewAgentConfig } from '@/lib/agent-config/core/types';

type DefaultCodeReviewConfigOptions = {
  reviewAnalyticsEnabled?: boolean;
};

export function createDefaultCodeReviewConfig(
  options: DefaultCodeReviewConfigOptions = {}
): CodeReviewAgentConfig {
  return {
    review_style: 'balanced',
    focus_areas: [],
    custom_instructions: null,
    model_slug: PRIMARY_DEFAULT_MODEL,
    thinking_effort: null,
    gate_threshold: 'off',
    repository_selection_mode: 'all',
    selected_repository_ids: [],
    manually_added_repositories: [],
    disable_review_md: true,
    review_memory_enabled: false,
    review_analytics_enabled: options.reviewAnalyticsEnabled ?? false,
  };
}
