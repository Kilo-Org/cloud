import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type Href, useFocusEffect, useRouter } from 'expo-router';
import { Check, GitPullRequest, Share as ShareIcon } from '@/components/ui/icons';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, Share, View } from 'react-native';
import { RefreshControl } from '@/components/ui/refresh-control';

import { PrMergePartialSuccessBanner } from '@/components/pr-review/merge/pr-merge-partial-success-banner';
import { OFFLINE_BANNER_HEIGHT } from '@/components/offline-banner';
import { useOfflineBannerState } from '@/lib/hooks/use-offline-banner-state';
import { PrReviewDiscussionTab } from '@/components/pr-review/pr-review-discussion-tab';
import { PrReviewFilesTab } from '@/components/pr-review/pr-review-files-tab';
import { PrReviewOverview } from '@/components/pr-review/pr-review-overview';
import { providerPrSheetHref } from '@/components/pr-review/pr-review-provider-sheet-href';
import {
  type PrReviewTabId,
  PrReviewTabSelector,
} from '@/components/pr-review/pr-review-tab-selector';
import { EmptyState } from '@/components/empty-state';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { consumeMergePartialSuccess } from '@/lib/pr-review/merge/merge-result-banner-store';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useProviderPrQueries } from '@/lib/pr-review/provider-pr-queries';
import { providerPrTriple, providerPrWebUrl } from '@/lib/pr-review/provider-pr-ref';
import { markRecentPrFailed, upsertRecentPr } from '@/lib/pr-review/recent-prs';
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
 * Provider parameterization (s5): the screen reads its identity from the
 * provider scope published by the route (`useProviderPrQueries`), so the same
 * tree renders a GitHub pull request, a GitLab merge request and a Bitbucket
 * pull request. The `owner`/`repo`/`number` props stay the GitHub route's
 * contract and are the fallback scope when no provider route is above.
 *
 * The screen intentionally fetches the PR DTO once and passes the
 * `headSha` and `changedFiles` down to the Files tab so the placeholder
 * can show useful info and S6b can drop in without a new fetch layer.
 * S6b and S7b own the file/diff and discussion bodies respectively;
 * S8 owns the merge section that mounts in the slot inside
 * `PrReviewOverview`.
 */
export function PrReviewScreen({ owner, repo, number }: PrReviewScreenProps) {
  const queries = useProviderPrQueries({ owner, repo, number });
  const queryClient = useQueryClient();
  const router = useRouter();
  const colors = useThemeColors();
  const { t } = useTranslation();
  const [tab, setTab] = useState<PrReviewTabId>('overview');
  const [refreshing, setRefreshing] = useState(false);
  // The app-wide offline banner is an absolute overlay at the safe-area top,
  // so it paints over this screen's header title. Reserve its height above
  // the header while it is visible (uxs2 spot check, e6-offline-hang).
  const isOffline = useOfflineBannerState();
  // 0 while online keeps the header's natural position (no reserved space).
  const headerTopPadding = isOffline ? OFFLINE_BANNER_HEIGHT : 0;

  // P1-F-46b: push the review-submit route with the same params the
  // Files-tab `PrDiffFloatingActions` uses, so a clean PR (no queued
  // comments) can still be approved from the Overview tab. On a provider
  // arm the sheet is a sibling of the ref's own route (s6), so the push
  // carries the provider identity through the provider route.
  const openReviewSubmit = useCallback(() => {
    const href: Href =
      queries.ref.platform === 'github'
        ? { pathname: REVIEW_SUBMIT_PATH, params: { owner, repo, number } }
        : providerPrSheetHref(queries.ref, 'review-submit');
    router.push(href);
  }, [router, owner, repo, number, queries.ref]);

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
  const overviewOptions = queries.overviewOptions();
  const pr = useQuery(overviewOptions);

  // Recents backfill. This is the ONLY writer that creates an entry: a
  // successful load upserts the real title with `lastResult: 'ok'`, which
  // also clears any previous `'failed'` marker. A never-authorized PR
  // (no successful load) never gets an entry.
  //
  // Every provider writes through the same triple — `providerPrTriple` splits
  // the ref's project path at its last separator, and `providerRefFromRecentPr`
  // folds it back — plus the platform and (GitLab) the instance hint, so the
  // collision-free `recentPrKey` keeps one row per provider and per instance,
  // and a row navigates back to the surface it was opened on.
  const recentIdentity = useMemo(() => {
    const triple = providerPrTriple(queries.ref);
    const instanceHint = queries.ref.platform === 'gitlab' ? queries.ref.instanceHint : undefined;
    return {
      owner: triple.owner,
      repo: triple.repo,
      number: triple.number,
      platform: queries.ref.platform,
      ...(instanceHint ? { instanceHint } : {}),
    };
  }, [queries.ref]);
  useEffect(() => {
    const data = pr.data;
    if (!data?.title) {
      return;
    }
    void upsertRecentPr({
      ...recentIdentity,
      title: data.title,
      lastOpenedAt: Date.now(),
      lastResult: 'ok',
    });
  }, [pr.data, recentIdentity]);

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
    void markRecentPrFailed(recentIdentity);
  }, [pr.isError, recentIdentity]);

  // Share the PR's public GitHub URL via the native share sheet. The URL comes
  // from the route params, so this works before the PR query resolves; the title
  // is added once it is known. Fire-and-forget, like the invite-link share in
  // `invited-member-row.tsx` — cancelling resolves with `dismissedAction`, and a
  // sheet the platform refuses to present has no actionable recovery.
  // Null on a GitLab ref reached without an instance hint: there is no host to
  // build a public link from, so the affordance is hidden rather than sharing
  // a link into some other instance's project.
  const webUrl = providerPrWebUrl(queries.ref);
  const sharePullRequest = useCallback(() => {
    if (!webUrl) {
      return;
    }
    const title = pr.data?.title;
    void Share.share({ message: title ? `${title}\n${webUrl}` : webUrl });
  }, [webUrl, pr.data?.title]);

  const handleRefresh = useCallback(() => {
    void (async () => {
      setRefreshing(true);
      try {
        const headSha = pr.data?.headSha;
        // The keys are read off fresh builder calls rather than off the
        // render-scope `overviewOptions`: a builder returns a new options
        // object (and a new key array) every call, so closing over one would
        // make this callback churn on every render for no behaviour change.
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: queries.overviewOptions().queryKey }),
          // Only invalidate checks when we know the head SHA; invalidating with
          // an empty ref would target a key that never matches the live query.
          ...(headSha
            ? [
                queryClient.invalidateQueries({
                  queryKey: queries.checksOptions(headSha).queryKey,
                }),
              ]
            : []),
        ]);
      } finally {
        setRefreshing(false);
      }
    })();
  }, [queryClient, queries, pr.data?.headSha]);

  const isMergeRequest = queries.platform === 'gitlab';
  // A first-load failure of the overview leaves the screen without a PR
  // body: Submit review and share would open sheets or share a link for a
  // merge request that never loaded, so they stay rendered (no header
  // shift) but stop responding. The tabs are disabled for the same reason —
  // their reads cannot succeed while the overview that gates them failed.
  const loadFailed = pr.isError && pr.data === undefined;
  // The review-submit sheet is a route sibling on every provider (s6), so
  // the affordance is offered wherever its scope can actually be queried:
  // a Bitbucket PR without a selected organization waits at the boundary
  // instead of opening a sheet that cannot load.
  const canSubmitReview = queries.isReady;

  let body: ReactNode = null;
  if (!queries.isReady) {
    // Non-retryable: Bitbucket Cloud review is organization-scoped and no
    // organization is selected. Nothing on this screen can fix that, so the
    // state names where the switch lives instead of offering a dead retry.
    body = (
      <EmptyState
        icon={GitPullRequest}
        title={t('organization.boundary.selectOrganization')}
        description={t('organization.boundary.selectDescription')}
      />
    );
  } else if (tab === 'overview') {
    body = (
      <>
        {partialMergeReason ? <PrMergePartialSuccessBanner reason={partialMergeReason} /> : null}
        <PrReviewOverview
          owner={owner}
          repo={repo}
          number={number}
          isActive
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}
        />
      </>
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
      <View className="bg-background" style={{ paddingTop: headerTopPadding }}>
        <ScreenHeader
          title={
            isMergeRequest
              ? t('prReview.terms.mergeRequestNumber', { number })
              : t('prReview.screen.title', { number })
          }
          eyebrow={`${owner}/${repo}`}
          headerRight={
            <View className="flex-row items-center gap-1">
              {webUrl ? (
                <Pressable
                  onPress={sharePullRequest}
                  disabled={loadFailed}
                  accessibilityRole="button"
                  accessibilityLabel={
                    isMergeRequest
                      ? t('prReview.terms.shareMergeRequest')
                      : t('prReview.screen.shareA11y')
                  }
                  accessibilityState={{ disabled: loadFailed }}
                  className="h-10 w-10 items-center justify-center rounded-full active:bg-muted"
                >
                  <ShareIcon size={18} color={colors.foreground} />
                </Pressable>
              ) : null}
              {/* P1-F-46b: the Submit-review affordance is reachable from the
                  Overview tab (header right) and the Files tab (floating
                  action bar). The Discussion tab is intentionally left without
                  a submit affordance — comment threads there are read-only. */}
              {tab === 'overview' && canSubmitReview ? (
                <Button
                  size="sm"
                  onPress={openReviewSubmit}
                  disabled={loadFailed}
                  accessibilityLabel={t('prReview.submit.submitReview')}
                  className={cn('px-3')}
                >
                  <Check size={14} color={colors.primaryForeground} />
                  <Text>{t('prReview.submit.submitReview')}</Text>
                </Button>
              ) : null}
            </View>
          }
        />
      </View>
      {queries.isReady ? (
        <View className="px-4 pb-2 pt-3">
          <PrReviewTabSelector
            activeTab={tab}
            onChange={setTab}
            discussionCount={pr.data?.commentCount}
            disabled={loadFailed}
          />
        </View>
      ) : null}
      {body}
    </View>
  );
}
