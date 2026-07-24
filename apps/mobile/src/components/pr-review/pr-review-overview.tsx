import { useQuery, useQueryClient } from '@tanstack/react-query';
import { GitPullRequest } from 'lucide-react-native';
import { useCallback } from 'react';
import { View } from 'react-native';
import * as WebBrowser from 'expo-web-browser';

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
import { classifyPrReviewQueryState } from '@/lib/pr-review/classify-pr-review-query-state';
import { WEB_BASE_URL } from '@/lib/config';
import { useTRPC } from '@/lib/trpc';

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
}: PrReviewOverviewProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const pr = useQuery(trpc.githubPrReview.getPullRequest.queryOptions({ owner, repo, number }));

  const handleReconnect = useCallback(() => {
    // A PRECONDITION_FAILED here means the gate's authorization is no
    // longer valid even though the gate already passed. Forcing a
    // refetch of the gate's query will either (a) flip it to
    // disconnected/revoked, in which case the gate renders its own
    // empty state with the Connect CTA, or (b) return connected, in
    // which case the user can tap Retry to reload the PR.
    void queryClient.invalidateQueries({
      queryKey: trpc.githubApps.getUserAuthorization.queryKey(),
    });
  }, [queryClient, trpc.githubApps.getUserAuthorization]);

  const handleInstallApp = useCallback(() => {
    void WebBrowser.openBrowserAsync(getGitHubIntegrationUrl(WEB_BASE_URL));
  }, []);

  if (pr.isLoading) {
    return <OverviewSkeleton />;
  }

  if (pr.isError) {
    const state = classifyPrReviewQueryState(pr.error);

    if (state.kind === 'not-found') {
      return (
        <EmptyState
          placement="top"
          icon={GitPullRequest}
          title="Pull request unavailable"
          description="This PR can't be opened. It may have been deleted, the repository is private, or the Kilo GitHub App isn't installed on it."
          action={
            <Button className="mt-3 w-full" onPress={handleInstallApp}>
              <Text>Install the Kilo GitHub App</Text>
            </Button>
          }
        />
      );
    }
    if (state.kind === 'permission') {
      // Terminal — no CTA. The user has no recourse from this screen.
      return (
        <EmptyState
          placement="top"
          icon={GitPullRequest}
          title="Access denied"
          description="You don't have permission to view this pull request."
        />
      );
    }
    if (state.kind === 'reconnect') {
      return (
        <EmptyState
          placement="top"
          icon={GitPullRequest}
          title="GitHub connection expired"
          description="Your GitHub connection is no longer valid. Re-check your connection — you'll be prompted to reconnect if needed."
          action={
            <Button className="mt-3 w-full" onPress={handleReconnect}>
              <Text>Check connection</Text>
            </Button>
          }
        />
      );
    }
    // retryable
    return (
      <QueryError
        placement="top"
        variant="server"
        title="Could not load pull request"
        onRetry={() => {
          void pr.refetch();
        }}
        isRetrying={pr.isFetching}
      />
    );
  }

  const data = pr.data;
  if (!data) {
    // Belt-and-suspenders guard for TS — the isLoading + isError branches
    // above already cover the runtime cases. If we got here, tanstack is
    // reporting neither loading nor error but also has no data (e.g.
    // enabled=false with no cached value). Render the skeleton rather
    // than dereferencing an undefined DTO.
    return <OverviewSkeleton />;
  }
  const chip = describePrState({
    state: data.state,
    draft: data.draft,
    reviewDecision: data.reviewDecision,
  });

  return (
    <View className="gap-5">
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
          Description
        </Text>
        {data.bodyMarkdown && data.bodyMarkdown.trim().length > 0 ? (
          <View className="rounded-lg bg-card p-4">
            <MarkdownText value={data.bodyMarkdown} variant="assistant" />
          </View>
        ) : (
          <Text variant="muted" className="text-sm italic">
            No description provided.
          </Text>
        )}
      </View>

      <PrReviewChecksSection owner={owner} repo={repo} number={number} headSha={data.headSha} />

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
        {formatPrCounts(data.counts.additions, data.counts.deletions)} · head{' '}
        {data.headSha.slice(0, 7)}
      </Text>
    </View>
  );
}
