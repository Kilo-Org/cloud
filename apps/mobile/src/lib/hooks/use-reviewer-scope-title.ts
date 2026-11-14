import { useQuery } from '@tanstack/react-query';
import { useEffect, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';

import { PERSONAL_SCOPE } from '@/lib/code-reviewer-config';
import {
  readScopeName,
  rememberScopeName,
  subscribeScopeNames,
} from '@/lib/code-reviewer-scope-name';
import {
  reviewerScopeMembershipName,
  reviewerScopeTitle,
  type ScopeOrganization,
} from '@/lib/code-reviewer-scope-title';
import { useTRPC } from '@/lib/trpc';

/**
 * The remembered name for a scope, plus the effect that records the name the
 * caller's own membership read just delivered. The screens that fetch
 * `organizations.list` themselves — for access classification and Retry — take
 * this instead of the hook below, which owns its own query.
 *
 * Subscribing is also what starts the restart read: the first subscriber
 * re-renders once the restored names land.
 */
export function useReviewerScopeName(
  scope: string,
  organizations: readonly ScopeOrganization[] | undefined
): string | undefined {
  // The remembered name is the snapshot: it changes only when the store does,
  // and the subscription starts the restart read.
  const remembered = useSyncExternalStore(subscribeScopeNames, () => readScopeName(scope));
  const membershipName = reviewerScopeMembershipName(scope, organizations);

  useEffect(() => {
    if (membershipName === undefined) {
      return;
    }
    rememberScopeName(scope, membershipName);
  }, [scope, membershipName]);

  return remembered;
}

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
  const knownName = useReviewerScopeName(scope, organizations.data);
  return reviewerScopeTitle(
    scope,
    organizations.data,
    {
      personal: t('common.personal'),
      organization: t('common.organization'),
    },
    knownName
  );
}
