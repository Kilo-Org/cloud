/**
 * Auto Fix - Default Configuration
 *
 * Centralized default configuration for auto-fix agent.
 * Used across all routers (personal, organization, and main auto-fix router).
 */

import { CLAUDE_SONNET_CURRENT_MODEL_ID } from '@/lib/model-constants';
import { AUTO_FIX_CONSTANTS, type AutoFixAgentConfig } from './schemas';

/**
 * Default auto-fix configuration
 * Applied when no configuration exists for an owner
 */
export const DEFAULT_AUTO_FIX_CONFIG: AutoFixAgentConfig = {
  enabled_for_issues: false,
  repository_selection_mode: 'all',
  selected_repository_ids: [],
  skip_labels: [],
  required_labels: [],
  model_slug: CLAUDE_SONNET_CURRENT_MODEL_ID,
  custom_instructions: null,
  pr_title_template: 'Fix #{issue_number}: {issue_title}',
  pr_body_template: null,
  pr_base_branch: 'main',
  max_pr_creation_time_minutes: AUTO_FIX_CONSTANTS.DEFAULT_MAX_PR_CREATION_TIME_MINUTES,
  max_concurrent_per_owner: AUTO_FIX_CONSTANTS.MAX_CONCURRENT_FIXES_PER_OWNER,
};
