import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type Href, useFocusEffect, useRouter } from 'expo-router';
import { Check, Share as ShareIcon } from '@/components/ui/icons';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, Share, View } from 'react-native';

import { PrMergePartialSuccessBanner } from '@/components/pr-review/merge/pr-merge-partial-success-banner';
import { PrReviewDiscussionTab } from '@/components/pr-review/pr-review-discussion-tab';
import { PrReviewFilesTab } from '@/components/pr-review/pr-review-files-tab';
import { PrReviewOverview } from '@/components/pr-review/pr-review-overview';
import {
  type PrReviewTabId,
  PrReviewTabSelector,
} from '@/components/pr-review/pr-review-tab-selector';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { consumeMergePartialSuccess } from '@/lib/pr-review/merge/merge-result-banner-store';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { markRecentPrFailed, upsertRecentPr } from '@/lib/pr-review/recent-prs';
import { useTRPC } from '@/lib/trpc';
import { cn } from '@/lib/utils';

const REVIEW_SUBMIT_PATH = '/(app)/pr-review/[owner]/[repo]/[number]/review-submit' as const;

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
  const router = useRouter();
  const colors = useThemeColors();
  const [tab, setTab] = useState<PrReviewTabId>('overview');
  const [refreshing, setRefreshing] = useState(false);

  // P1-F-46b: push the review-submit route with the same params the
  // Files-tab `PrDiffFloatingActions` uses, so a clean PR (no queued
  // comments) can still be approved from the Overview tab.
  const openReviewSubmit = useCallback(() => {
    const href: Href = {
      pathname: REVIEW_SUBMIT_PATH,
      params: { owner, repo, number },
    };
    router.push(href);
  }, [router, owner, repo, number]);

  // P0-B-08: post-merge "branch delete failed" partial-success banner.
  // The merge sheet writes the reason into the in-memory store right
  // before dismissing; we consume it on every focus so the banner
  // appears once after the user navigates back, then disappears (and
  // does not re-flash on re-focus) thanks to consume-on-read semantics.
  const [partialMergeReason, setPartialMergeReason] = useState<string | null>(null);
  useFocusEffect(
    useCallback(() => {
      const value = consumeMergePartialSuccess({ owner, repo, number });
      if (value) {
        setPartialMergeReason(value.reason);
      }
    }, [owner, repo, number])
  );

  // The screen owns the PR query so it can drive the recents backfill
  // and pass `headSha` / `changedFiles` to the Files tab. The Overview
  // re-uses the same query — tanstack-query dedupes by key, so this is
  // a single network round-trip even though both components subscribe.
  const pr = useQuery(trpc.githubPrReview.getPullRequest.queryOptions({ owner, repo, number }));

  // Recents backfill. This is the ONLY writer that creates an entry: a
  // successful load upserts the real title with `lastResult: 'ok'`, which
  // also clears any previous `'failed'` marker. A never-authorized PR
  // (no successful load) never gets an entry.
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
      lastResult: 'ok',
    });
  }, [pr.data, owner, repo, number]);

  // Mark an existing recents entry as failed exactly once per error. The
  // ref guards against re-writing on re-render; `markRecentPrFailed` is a
  // no-op when no entry exists, so a never-authorized PR stays out of
  // recents. A success (isError false) or a PR identity change resets the
  // guard so a later error marks the entry failed again.
  const markedFailedRef = useRef(false);
  useEffect(() => {
    if (!pr.isError) {
      markedFailedRef.current = false;
      return;
    }
    if (markedFailedRef.current) {
      return;
    }
    markedFailedRef.current = true;
    void markRecentPrFailed({ owner, repo, number });
  }, [pr.isError, owner, repo, number]);

  // Share the PR's public GitHub URL via the native share sheet. The URL comes
  // from the route params, so this works before the PR query resolves; the title
  // is added once it is known. Fire-and-forget, like the invite-link share in
  // `invited-member-row.tsx` — cancelling resolves with `dismissedAction`, and a
  // sheet the platform refuses to present has no actionable recovery.
  const sharePullRequest = useCallback(() => {
    const url = `https://github.com/${owner}/${repo}/pull/${number}`;
    const title = pr.data?.title;
    void Share.share({ message: title ? `${title}\n${url}` : url });
  }, [owner, repo, number, pr.data?.title]);

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
        {partialMergeReason ? <PrMergePartialSuccessBanner reason={partialMergeReason} /> : null}
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
      <ScreenHeader
        title={`#${number}`}
        eyebrow={`${owner}/${repo}`}
        headerRight={
          <View className="flex-row items-center gap-1">
            <Pressable
              onPress={sharePullRequest}
              accessibilityRole="button"
              accessibilityLabel="Share pull request"
              className="h-10 w-10 items-center justify-center rounded-full active:bg-muted"
            >
              <ShareIcon size={18} color={colors.foreground} />
            </Pressable>
            {/* P1-F-46b: the Submit-review affordance is reachable from the
                Overview tab (header right) and the Files tab (floating
                action bar). The Discussion tab is intentionally left without
                a submit affordance — comment threads there are read-only. */}
            {tab === 'overview' ? (
              <Button
                size="sm"
                onPress={openReviewSubmit}
                accessibilityLabel="Submit review"
                className={cn('px-3')}
              >
                <Check size={14} color={colors.primaryForeground} />
                <Text>Submit review</Text>
              </Button>
            ) : null}
          </View>
        }
      />
      <View className="px-4 pb-2 pt-3">
        <PrReviewTabSelector activeTab={tab} onChange={setTab} />
      </View>
      {body}
    </View>
  );
}
