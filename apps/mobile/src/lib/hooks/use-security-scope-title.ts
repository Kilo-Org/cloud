import { isPersonalSecurityScope } from '@kilocode/app-shared/security-agent';
import { useTranslation } from 'react-i18next';

import { useOrganizationsList } from '@/lib/hooks/use-organizations-list';

/**
 * The scope a Security Agent screen acts on, as the reader's header subtitle:
 * the organization's name for an organization scope, `Personal` for the personal
 * one. A reader who belongs to several organizations can then tell whose agent
 * (and whose GitHub app) the screen acts on, the way the Code Reviewer's scope
 * screens already name it.
 *
 * The name reads the app-wide `organizations.list` entry and never fetches it:
 * the scope's own capability read, or the app-wide prefetch, already owns that
 * request. A second fetcher here would join the query's pause/resume path, and
 * an offline retry of the scope's reads would then wait on a title's fetch
 * instead of the reads it was retrying.
 *
 * The read goes through `useOrganizationsList`, so this observer keeps the
 * entry's own options. An observer that registered defaulted options would
 * overwrite the entry's settle-while-offline settings for every other consumer.
 *
 * Until the list is read the subtitle keeps a placeholder instead of
 * disappearing, so the header never grows a line when the name arrives.
 */
export function useSecurityScopeTitle(scope: string): string {
  const { t } = useTranslation();
  const isPersonal = isPersonalSecurityScope(scope);
  const organizations = useOrganizationsList({ enabled: false });
  if (isPersonal) {
    return t('common.personal');
  }
  return (
    organizations.data?.find(org => org.organizationId === scope)?.organizationName ??
    t('common.organization')
  );
}
