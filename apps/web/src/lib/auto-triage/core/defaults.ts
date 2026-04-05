import { PRIMARY_DEFAULT_MODEL } from '@/lib/models';
import { AUTO_TRIAGE_CONSTANTS } from './constants';

export const DEFAULT_AUTO_TRIAGE_CONFIG = {
  isEnabled: false,
  enabled_for_issues: false,
  repository_selection_mode: 'all' as const,
  selected_repository_ids: [] as number[],
  skip_labels: [] as string[],
  required_labels: [] as string[],
  duplicate_threshold: AUTO_TRIAGE_CONSTANTS.DEFAULT_DUPLICATE_THRESHOLD,
  auto_fix_threshold: AUTO_TRIAGE_CONSTANTS.DEFAULT_AUTO_PR_THRESHOLD,
  auto_create_pr_threshold: AUTO_TRIAGE_CONSTANTS.DEFAULT_AUTO_PR_THRESHOLD,
  max_concurrent_per_owner: AUTO_TRIAGE_CONSTANTS.MAX_CONCURRENT_TICKETS_PER_OWNER,
  custom_instructions: null,
  model_slug: PRIMARY_DEFAULT_MODEL,
  max_classification_time_minutes: 5,
  max_pr_creation_time_minutes: 15,
};
