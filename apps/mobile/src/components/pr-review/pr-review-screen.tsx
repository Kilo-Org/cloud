import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';

import { PrReviewDiscussionTab } from '@/components/pr-review/pr-review-discussion-tab';
import { PrReviewFilesTab } from '@/components/pr-review/pr-review-files-tab';
import { PrReviewOverview } from '@/components/pr-review/pr-review-overview';
import {
  type PrReviewTabId,
  PrReviewTabSelector,
} from '@/components/pr-review/pr-review-tab-selector';
import { ScreenHeader } from '@/components/screen-header';
import { upsertRecentPr } from '@/lib/pr-review/recent-prs';
import { useTRPC } from '@/lib/trpc';

type PrReviewScreenProps = {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
};

/**
 * Tab shell for the PR review surface. S5 owns:
 *  - the tab container API (PrReviewTabSelector + per-tab body slots)
 *  - the local tab state
 *  - pull-to-refresh across the Overview + Checks queries
 *  - the recents title backfill (upsertRecentPr with the real title
 *    on the first successful `getPullRequest`).
 *
 * The screen intentionally fetches the PR DTO once and passes the
 * `headSha` and `changedFiles` down to the Files tab so the placeholder
 * can show useful info and S6b can drop in without a new fetch layer.
 * S6b and S7b own the file/diff and discussion bodies respectively;
 * S8 owns the merge section that mounts in the slot inside
 * `PrReviewOverview`.
 */
export function PrReviewScreen({ owner, repo, number }: PrReviewScreenProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<PrReviewTabId>('overview');
  const [refreshing, setRefreshing] = useState(false);

  // The screen owns the PR query so it can drive the recents backfill
  // and pass `headSha` / `changedFiles` to the Files tab. The Overview
  // re-uses the same query — tanstack-query dedupes by key, so this is
  // a single network round-trip even though both components subscribe.
  const pr = useQuery(trpc.githubPrReview.getPullRequest.queryOptions({ owner, repo, number }));

  // Recents title backfill. S4b left the title empty so the recents row
  // can be written before the PR loads. Once we have the real title,
  // upsert it so the recents list shows it next time.
  useEffect(() => {
    const data = pr.data;
    if (!data?.title) {
      return;
    }
    void upsertRecentPr({
      owner,
      repo,
      number,
      title: data.title,
      lastOpenedAt: Date.now(),
    });
  }, [pr.data, owner, repo, number]);

  const handleRefresh = useCallback(() => {
    void (async () => {
      setRefreshing(true);
      try {
        const headSha = pr.data?.headSha;
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: trpc.githubPrReview.getPullRequest.queryKey({
              owner,
              repo,
              number,
            }),
          }),
          // Only invalidate checks when we know the head SHA; invalidating with
          // an empty ref would target a key that never matches the live query.
          ...(headSha
            ? [
                queryClient.invalidateQueries({
                  queryKey: trpc.githubPrReview.listChecks.queryKey({ owner, repo, ref: headSha }),
                }),
              ]
            : []),
        ]);
      } finally {
        setRefreshing(false);
      }
    })();
  }, [queryClient, trpc, owner, repo, number, pr.data?.headSha]);

  // Each tab owns its own scroll: Overview is a ScrollView with
  // pull-to-refresh; the Files tab hosts a virtualized FlashList and must
  // NOT be nested inside a ScrollView.
  let body: ReactNode = null;
  if (tab === 'overview') {
    body = (
      <ScrollView
        className="flex-1"
        contentContainerClassName="gap-5 px-4 pb-12"
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}
      >
        <PrReviewOverview owner={owner} repo={repo} number={number} isActive />
      </ScrollView>
    );
  } else if (tab === 'files') {
    body = (
      <PrReviewFilesTab
        owner={owner}
        repo={repo}
        number={number}
        headSha={pr.data?.headSha ?? ''}
        changedFiles={pr.data?.counts.changedFiles ?? 0}
        onRequestOverview={() => {
          setTab('overview');
        }}
      />
    );
  } else {
    body = (
      <PrReviewDiscussionTab
        owner={owner}
        repo={repo}
        number={number}
        onRequestFiles={() => {
          setTab('files');
        }}
      />
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={`#${number}`} eyebrow={`${owner}/${repo}`} />
      <View className="px-4 pb-2 pt-3">
        <PrReviewTabSelector activeTab={tab} onChange={setTab} />
      </View>
      {body}
    </View>
  );
}
