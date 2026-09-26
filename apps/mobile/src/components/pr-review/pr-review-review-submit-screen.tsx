import { useQuery } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { type ReactNode, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator } from '@/components/ui/activity-indicator';

import { CenteredState } from '@/components/centered-state';

import { PrFormSheetHeader } from '@/components/pr-review/pr-form-sheet-chrome';
import { PrReviewSubmit } from '@/components/pr-review/pr-review-submit';
import { QueryError } from '@/components/query-error';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { parseParam } from '@/lib/route-params';
import {
  buildPrOverviewQueryOptions,
  providerCapabilitiesIdentity,
  selectProviderCapabilitiesData,
} from '@/lib/pr-review/provider-pr-queries';
import {
  isProviderScopeReady,
  parseProviderPrRoute,
  providerPrRefLabel,
  providerPrTriple,
  useProviderPrScope,
} from '@/lib/pr-review/provider-pr-ref';
import { useTRPC } from '@/lib/trpc';

type Params = {
  owner: string;
  repo: string;
  number: string;
  // Provider route shape (`[platform]/[...identity]/review-submit`).
  platform?: string;
  identity?: string[] | string;
  instance?: string;
};

/**
 * Review-submit formSheet, mounted by BOTH routes: the GitHub
 * `[owner]/[repo]/[number]/review-submit` route and the provider
 * `[platform]/[...identity]/review-submit` route (s6). The review events the
 * sheet offers come from the server capability list on provider arms, so a
 * GitLab MR never offers `request changes` (the provider has no such event).
 */
export function PrReviewReviewSubmitScreen() {
  const router = useRouter();
  const colors = useThemeColors();
  const { t } = useTranslation();
  const params = useLocalSearchParams<Params>();

  // The provider route carries the identity segments; the GitHub route the
  // plain triple. Exactly one parses — the provider layout redirects a
  // hand-built `/pr-review/github/...` link to the GitHub route.
  const providerRef = useMemo(
    () =>
      parseProviderPrRoute({
        platform: params.platform,
        identity: params.identity,
        instance: params.instance,
      }),
    [params.platform, params.identity, params.instance]
  );
  const providerTriple = providerRef ? providerPrTriple(providerRef) : null;
  const owner = providerTriple ? providerTriple.owner : (parseParam(params.owner) ?? '');
  const repo = providerTriple ? providerTriple.repo : (parseParam(params.repo) ?? '');
  const rawNumber = providerTriple
    ? String(providerTriple.number)
    : (parseParam(params.number) ?? '');
  const number = Number.parseInt(rawNumber, 10);

  const title = t('prReview.submit.submitReview');
  const eyebrow = providerRef ? providerPrRefLabel(providerRef) : `${owner}/${repo}#${rawNumber}`;
  const dismiss = () => {
    router.back();
  };

  // The scope the overview runs under: the layout publishes the provider
  // scope in context; the GitHub route falls back to the parsed triple, so
  // the GitHub query key is byte-identical to the pre-s6 one.
  const scope = useProviderPrScope(
    owner && repo && Number.isInteger(number) && number > 0
      ? { owner, repo, number }
      : { owner: '', repo: '', number: 0 }
  );

  const trpc = useTRPC();
  const overviewOptions = useMemo(() => buildPrOverviewQueryOptions(trpc, scope), [trpc, scope]);
  const paramsValid = Boolean(owner) && Boolean(repo) && Number.isInteger(number) && number > 0;
  const pr = useQuery({
    ...overviewOptions,
    enabled: paramsValid && isProviderScopeReady(scope),
  });

  // The server capability list, provider arms only. The github arm never
  // touches the `providerReview` namespace (the GitHub path is unchanged):
  // its query registers disabled and never fetches; the query also waits for
  // a ready scope, so a Bitbucket PR without its organization waits instead
  // of querying.
  const isProviderArm = scope.ref.platform !== 'github';
  // The options call sits directly in the body and the result is bound
  // before `useQuery`: wrapped in a helper/useMemo closure the linter's
  // inference loses the option type, and passed inline the type-checker's
  // inference collapses every `.data` read. The data itself is read back
  // through the seam's typed selector.
  const capabilitiesOptions = trpc.providerReview.getCapabilities.queryOptions(
    providerCapabilitiesIdentity(scope),
    { enabled: isProviderArm && isProviderScopeReady(scope) }
  );
  const capabilities = useQuery(capabilitiesOptions);
  const capabilitiesData = selectProviderCapabilitiesData(capabilities.data);

  const capabilitiesReady = !isProviderArm || capabilitiesData !== undefined;
  const capabilitiesFailed = isProviderArm && capabilities.isError;

  if (pr.data && capabilitiesReady) {
    return (
      <PrReviewSubmit
        owner={owner}
        repo={repo}
        number={number}
        headSha={pr.data.headSha}
        title={title}
        eyebrow={eyebrow}
        prRef={providerRef && providerRef.platform !== 'github' ? providerRef : undefined}
        reviewEvents={
          providerRef && providerRef.platform !== 'github' && capabilitiesData
            ? capabilitiesData.reviewEvents
            : undefined
        }
        onDismiss={dismiss}
      />
    );
  }

  const body: ReactNode =
    pr.isLoading || (isProviderArm && capabilities.isLoading) ? (
      <CenteredState>
        <ActivityIndicator size="small" color={colors.mutedForeground} />
      </CenteredState>
    ) : (
      <QueryError
        variant="server"
        title={t('prReview.submit.loadFailedTitle')}
        onRetry={() => {
          if (capabilitiesFailed) {
            void capabilities.refetch();
          }
          void pr.refetch();
        }}
        isRetrying={pr.isFetching || (isProviderArm && capabilities.isFetching)}
      />
    );

  return (
    <>
      <PrFormSheetHeader title={title} eyebrow={eyebrow} onBack={dismiss} />
      {body}
    </>
  );
}
