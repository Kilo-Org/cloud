import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { PERSONAL_SCOPE } from '@/lib/code-reviewer-config';
import { reviewerScopeTitle } from '@/lib/code-reviewer-scope-title';
import { useTRPC } from '@/lib/trpc';

/**
 * `reviewerScopeTitle` for a screen that has no membership list of its own: it
 * reads the shared `organizations.list` entry and fetches it only when the
 * scope is an organization. The personal scope needs no membership row, so it
 * never joins that query's pause/resume path.
 */
export function useReviewerScopeTitle(scope: string): string {
  const { t } = useTranslation();
  const trpc = useTRPC();
  const organizations = useQuery({
    ...trpc.organizations.list.queryOptions(),
    enabled: scope !== PERSONAL_SCOPE,
  });
  return reviewerScopeTitle(scope, organizations.data, {
    personal: t('common.personal'),
    organization: t('common.organization'),
  });
}
