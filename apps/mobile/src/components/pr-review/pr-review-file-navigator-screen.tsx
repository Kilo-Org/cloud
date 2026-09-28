import { useQuery } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { ActivityIndicator } from '@/components/ui/activity-indicator';

import { CenteredState } from '@/components/centered-state';

import { PrDiffFileNavigator } from '@/components/pr-review/diff/pr-diff-file-navigator';
import { PrReviewReconnectNotice } from '@/components/pr-review/pr-review-reconnect-notice';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { classifyPrReviewQueryState } from '@/lib/pr-review/classify-pr-review-query-state';
import { useProviderPrQueries } from '@/lib/pr-review/provider-pr-queries';
import { providerPrRefLabel, providerPrTriple } from '@/lib/pr-review/provider-pr-ref';
import { parseParam } from '@/lib/route-params';

type Params = {
  owner: string;
  repo: string;
  number: string;
};

/**
 * File-navigator formSheet route. Fetches the PR overview for the head SHA
 * (the navigator keys viewed state + the diff list on it) and mounts the S6c
 * navigator content. Rendered inside the `[number]` layout's formSheet stack.
 *
 * Provider-agnostic (s5): the same sheet is a sibling of the provider route's
 * stack, where the identity comes from the published scope rather than from
 * `owner`/`repo`/`number` params. The GitHub params below stay the fallback
 * scope, so the GitHub route reaches the exact same query it did before.
 */
export function PrReviewFileNavigatorScreen() {
  const router = useRouter();
  const colors = useThemeColors();
  const { t } = useTranslation();
  const params = useLocalSearchParams<Params>();
  const rawNumber = parseParam(params.number) ?? '';
  const queries = useProviderPrQueries({
    owner: parseParam(params.owner) ?? '',
    repo: parseParam(params.repo) ?? '',
    number: Number.parseInt(rawNumber, 10),
  });
  const { owner, repo, number } = providerPrTriple(queries.ref);

  // The route layout above validates the identity before this sheet can
  // mount; the guard stays as the belt-and-braces it always was, ANDed with
  // the scope readiness a Bitbucket ref carries.
  const hasIdentity = Boolean(owner) && Boolean(repo) && Number.isInteger(number) && number > 0;
  const pr = useQuery({
    ...queries.overviewOptions(),
    enabled: queries.isReady && hasIdentity,
  });

  const header = (
    <ScreenHeader
      title={t('prReview.fileNavigator.title')}
      eyebrow={providerPrRefLabel(queries.ref)}
      modal
      onBack={() => {
        router.back();
      }}
    />
  );

  if (pr.data) {
    return (
      <PrDiffFileNavigator
        owner={owner}
        repo={repo}
        number={number}
        headSha={pr.data.headSha}
        changedFiles={pr.data.counts.changedFiles}
        onDismiss={() => {
          router.back();
        }}
        header={header}
      />
    );
  }

  return (
    <>
      <View collapsable={false}>{header}</View>
      {pr.isLoading ? (
        <CenteredState>
          <ActivityIndicator size="small" color={colors.mutedForeground} />
        </CenteredState>
      ) : (
        <NavigatorError
          error={pr.isError ? pr.error : null}
          onRetry={() => {
            void pr.refetch();
          }}
          isRetrying={pr.isFetching}
        />
      )}
    </>
  );
}

/**
 * The sheet's failure states, split the same way the Overview and Discussion
 * bodies split them: a permission denial, a missing PR/MR and a broken
 * connection are terminal and carry no retry, because retrying the identical
 * request cannot change any of them. Only a transient failure gets the CTA.
 */
function NavigatorError({
  error,
  onRetry,
  isRetrying,
}: Readonly<{ error: unknown; onRetry: () => void; isRetrying: boolean }>) {
  const { t } = useTranslation();
  const state = error === null ? null : classifyPrReviewQueryState(error);
  if (state?.kind === 'permission') {
    return <QueryError variant="permission" />;
  }
  if (state?.kind === 'not-found') {
    return <QueryError variant="not-found" />;
  }
  if (state?.kind === 'reconnect') {
    return (
      <CenteredState className="px-6">
        <PrReviewReconnectNotice />
      </CenteredState>
    );
  }
  return (
    <QueryError
      variant="server"
      title={t('prReview.fileNavigator.couldNotLoadFiles')}
      onRetry={onRetry}
      isRetrying={isRetrying}
    />
  );
}
