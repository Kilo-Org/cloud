import { useQuery } from '@tanstack/react-query';
import { type Href, useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { CheckCheck, GitPullRequest } from '@/components/ui/icons';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { type ScrollViewProps, View } from 'react-native';
import { toast } from 'sonner-native';

import { DetailScreenScrollView } from '@/components/detail-screen';
import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { MarkdownText } from '@/components/agents/markdown-text';
import { PrReviewChecksSection } from '@/components/pr-review/pr-review-checks-section';
import { PrMergeSection } from '@/components/pr-review/merge/pr-merge-section';
import {
  describePrState,
  formatPrCounts,
  PrAuthorRow,
  PrCountsLine,
  PrRefsRow,
  PrStateChip,
} from '@/components/pr-review/pr-review-overview-parts';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { getGitHubIntegrationUrl } from '@/lib/agent-github-integration';
import { WEB_BASE_URL } from '@/lib/config';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { classifyPrReviewQueryState } from '@/lib/pr-review/classify-pr-review-query-state';
import { useCheckGitHubConnection } from '@/lib/pr-review/use-check-github-connection';
import { trpcClient, useTRPC } from '@/lib/trpc';

const REVIEW_SUBMIT_PATH = '/(app)/pr-review/[owner]/[repo]/[number]/review-submit' as const;

type PrReviewOverviewProps = {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  /**
   * True when this tab is the live, visible body in the tab container.
   * Reserved for a future focus-driven refetch — the Overview is
   * otherwise a self-contained consumer of `getPullRequest` + the
   * inner `listChecks` consumer in `PrReviewChecksSection`.
   */
  readonly isActive: boolean;
  readonly refreshControl?: ScrollViewProps['refreshControl'];
};

function OverviewSkeleton() {
  return (
    <View className="gap-6">
      <View className="gap-2">
        <View className="h-5 w-20 rounded-full bg-muted" />
        <View className="h-7 w-3/4 rounded bg-muted" />
        <View className="h-5 w-1/2 rounded bg-muted" />
      </View>
      <View className="gap-2">
        <View className="h-3 w-32 rounded bg-muted" />
        <View className="h-3 w-48 rounded bg-muted" />
        <View className="h-3 w-40 rounded bg-muted" />
      </View>
      <View className="gap-2">
        <View className="h-3 w-full rounded bg-muted" />
        <View className="h-3 w-5/6 rounded bg-muted" />
        <View className="h-3 w-2/3 rounded bg-muted" />
      </View>
    </View>
  );
}

export function PrReviewOverview({
  owner,
  repo,
  number,
  isActive: _isActive,
  refreshControl,
}: PrReviewOverviewProps) {
  const trpc = useTRPC();
  const connection = useCheckGitHubConnection();
  const router = useRouter();
  const colors = useThemeColors();
  const { t } = useTranslation();

  const pr = useQuery(trpc.githubPrReview.getPullRequest.queryOptions({ owner, repo, number }));

  const handleOpenReviewSubmit = useCallback(() => {
    const href: Href = {
      pathname: REVIEW_SUBMIT_PATH,
      params: { owner, repo, number },
    };
    router.push(href);
  }, [owner, repo, number, router]);

  const handleInstallApp = useCallback(() => {
    void (async () => {
      try {
        const { token } = await trpcClient.githubApps.mintInstallState.mutate({
          returnTo: '/cloud/sessions',
        });
        await WebBrowser.openBrowserAsync(getGitHubIntegrationUrl(WEB_BASE_URL, undefined, token));
      } catch {
        toast.error(t('prReview.couldNotOpenGitHubAppSettings'));
      }
    })();
  }, [t]);

  const state = pr.isError ? classifyPrReviewQueryState(pr.error) : null;
  if (state && (!pr.data || state.kind !== 'retryable')) {
    if (state.kind === 'not-found') {
      return (
        <EmptyState
          refreshControl={refreshControl}
          icon={GitPullRequest}
          title={t('prReview.pullRequestUnavailable')}
          description={t('prReview.pullRequestUnavailableDescription')}
          action={
            <Button className="mt-3 w-full" onPress={handleInstallApp}>
              <Text>{t('prReview.installKiloGitHubApp')}</Text>
            </Button>
          }
        />
      );
    }
    if (state.kind === 'permission') {
      // Terminal — no CTA. The user has no recourse from this screen.
      return (
        <EmptyState
          refreshControl={refreshControl}
          icon={GitPullRequest}
          title={t('common.accessDenied')}
          description={t('prReview.accessDeniedDescription')}
        />
      );
    }
    if (state.kind === 'reconnect') {
      return (
        <EmptyState
          refreshControl={refreshControl}
          icon={GitPullRequest}
          title={t('prReview.connectionExpiredTitle')}
          description={t('prReview.connectionExpiredDescription')}
          action={
            <Button
              className="mt-3 w-full"
              onPress={() => {
                connection.mutate();
              }}
              loading={connection.isPending}
            >
              <Text>{t('prReview.checkConnection')}</Text>
            </Button>
          }
        />
      );
    }
    // retryable
    return (
      <QueryError
        refreshControl={refreshControl}
        variant="server"
        title={t('prReview.couldNotLoadPullRequest')}
        onRetry={() => {
          void pr.refetch();
        }}
        isRetrying={pr.isFetching}
      />
    );
  }

  const data = pr.data;
  if (!data) {
    return (
      <DetailScreenScrollView
        className="flex-1"
        contentContainerClassName="px-4"
        refreshControl={refreshControl}
      >
        <OverviewSkeleton />
      </DetailScreenScrollView>
    );
  }
  const chip = describePrState({
    state: data.state,
    draft: data.draft,
    reviewDecision: data.reviewDecision,
  });

  return (
    <DetailScreenScrollView
      className="flex-1"
      contentContainerClassName="gap-5 px-4"
      keyboardShouldPersistTaps="handled"
      refreshControl={refreshControl}
    >
      <View className="gap-3">
        <PrStateChip descriptor={chip} />
        <Text className="text-[22px] font-semibold leading-7 text-foreground" numberOfLines={3}>
          {data.title}
        </Text>
        <PrAuthorRow author={data.author} />
        <PrRefsRow
          baseRef={data.baseRef}
          headRef={data.headRef}
          headRepoFullName={data.headRepoFullName}
          isCrossRepo={data.isCrossRepo}
        />
        <PrCountsLine
          commits={data.counts.commits}
          changedFiles={data.counts.changedFiles}
          additions={data.counts.additions}
          deletions={data.counts.deletions}
        />
      </View>

      <View className="gap-2">
        <Text variant="eyebrow" className="uppercase tracking-wide text-muted-foreground">
          {t('prReview.description')}
        </Text>
        {data.bodyMarkdown && data.bodyMarkdown.trim().length > 0 ? (
          <View className="rounded-lg bg-card p-4">
            <MarkdownText value={data.bodyMarkdown} variant="assistant" />
          </View>
        ) : (
          <Text variant="muted" className="text-sm italic">
            {t('prReview.noDescriptionProvided')}
          </Text>
        )}
      </View>

      <PrReviewChecksSection owner={owner} repo={repo} number={number} headSha={data.headSha} />

      <View className="gap-2">
        <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
          {t('prReview.review')}
        </Text>
        <Button
          onPress={handleOpenReviewSubmit}
          accessibilityLabel={t('prReview.reviewPullRequest')}
        >
          <View className="flex-row items-center gap-2">
            <CheckCheck size={14} color={colors.primaryForeground} />
            <Text>{t('prReview.review')}</Text>
          </View>
        </Button>
      </View>

      <PrMergeSection
        owner={owner}
        repo={repo}
        overview={data}
        onRefetch={async () => {
          await pr.refetch();
        }}
        isRefetching={pr.isFetching}
      />

      <Text variant="muted" className="text-xs">
        {t('prReview.headLine', {
          counts: formatPrCounts(data.counts.additions, data.counts.deletions),
          sha: data.headSha.slice(0, 7),
        })}
      </Text>
    </DetailScreenScrollView>
  );
}
