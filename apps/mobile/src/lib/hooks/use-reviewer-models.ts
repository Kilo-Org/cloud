import { PERSONAL_SCOPE } from '@/lib/code-reviewer-config';
import { useAvailableModels } from '@/lib/hooks/use-available-models';

/**
 * Models for a Code Reviewer picker. An organization's reviews run as its
 * service bot, so the organization list marks a model BYOK-available only for a
 * key that bot can use.
 */
export function useReviewerModels(scope: string) {
  return useAvailableModels(scope === PERSONAL_SCOPE ? undefined : scope, 'shared_services');
}
