'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Hourglass } from 'lucide-react';
import type { DrawerStackHelpers } from '@/components/drawer';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Skeleton } from '@/components/ui/skeleton';
import { useWastelandTRPC } from '@/lib/wasteland/trpc';
import type { WastelandOutputs } from '@/lib/wasteland/trpc';
import type { WantedItem, WantedItemTab, WantedPanelActions, WastelandDrawerRef } from './types';
import { WantedItemUpstreamTab } from './WantedItemUpstreamTab';
import { WantedItemBranchTab } from './WantedItemBranchTab';
import { WantedItemPullTab } from './WantedItemPullTab';

type ForkBranch = WastelandOutputs['wasteland']['listMyForkBranches'][number];
type MyPull = WastelandOutputs['wasteland']['listMyPulls'][number];

/**
 * Three-tabbed wanted-item drawer — mirrors the three-place model.
 *
 * - **Upstream** — what `<owner>/<repo>` on `main` says about this
 *   item. Always present.
 * - **My branch** — visible only when a `wl/<rigHandle>/<wantedId>`
 *   branch exists on the user's fork. Hosts claim/done/publish/discard.
 * - **Pull request** — visible only when a PR exists for that branch
 *   against the upstream. Hosts maintainer actions.
 *
 * The default tab is picked by the caller (`initialTab`) based on the
 * "place" the user opened the drawer from. If the requested tab isn't
 * available for the current item, falls back to `upstream`.
 *
 * Branch/PR detection is best-effort — when the fork-branches or pulls
 * query is still loading we render the skeleton in those tabs without
 * blocking the upstream view.
 */
export function WantedItemPanel({
  wastelandId,
  item,
  actions,
  push,
  initialTab,
}: {
  wastelandId: string;
  item: WantedItem;
  /** `null` means the panel was pushed as a cross-reference — render read-only. */
  actions: WantedPanelActions | null;
  push: DrawerStackHelpers<WastelandDrawerRef>['push'];
  initialTab?: WantedItemTab;
}) {
  const trpc = useWastelandTRPC();

  // The two queries are intentionally polled at 30s — fast enough that
  // an admin merging upstream from another tab (or from DoltHub) flips
  // the drawer's view without a manual refresh, slow enough that
  // leaving the drawer open isn't a fetch storm.
  const branchesQuery = useQuery({
    ...trpc.wasteland.listMyForkBranches.queryOptions({ wastelandId }),
    refetchInterval: 30_000,
    // Cross-reference mode — surface only the read-only view of upstream.
    // Skipping these queries also avoids a credential-required spinner
    // on rig drawers that wouldn't otherwise touch fork data.
    enabled: actions !== null,
  });
  const pullsQuery = useQuery({
    ...trpc.wasteland.listMyPulls.queryOptions({ wastelandId }),
    refetchInterval: 30_000,
    enabled: actions !== null,
  });

  const branch = useMemo<ForkBranch | null>(() => {
    if (!branchesQuery.data) return null;
    return branchesQuery.data.find(b => b.wantedId === item.id) ?? null;
  }, [branchesQuery.data, item.id]);

  const pull = useMemo<MyPull | null>(() => {
    if (!branch || !pullsQuery.data) return null;
    return pullsQuery.data.find(p => p.branchName === branch.branchName) ?? null;
  }, [pullsQuery.data, branch]);

  const branchLoading = actions !== null && branchesQuery.isLoading;
  const pullLoading = actions !== null && (pullsQuery.isLoading || branchesQuery.isLoading);

  const hasBranch = branch !== null;
  const hasPull = pull !== null;

  const resolvedInitial = useMemo<WantedItemTab>(() => {
    const requested: WantedItemTab = initialTab ?? 'upstream';
    if (requested === 'branch' && !hasBranch && !branchLoading) return 'upstream';
    if (requested === 'pull' && !hasPull && !pullLoading) return 'upstream';
    return requested;
  }, [initialTab, hasBranch, hasPull, branchLoading, pullLoading]);

  // Once the user manually switches tabs we stop reacting to changes in
  // `resolvedInitial`. But during the initial load the resolved value
  // may flip (e.g. requested=branch → fallback=upstream → branch
  // appears). Keep `tab` in sync with `resolvedInitial` until the user
  // takes ownership.
  const [tab, setTab] = useState<WantedItemTab>(resolvedInitial);
  const userOverrodeRef = useRef(false);
  useEffect(() => {
    if (!userOverrodeRef.current) setTab(resolvedInitial);
  }, [resolvedInitial]);

  // Belt-and-braces: if the currently-selected tab disappears (e.g. the
  // user clicked My branch while it was loading and the load resolved
  // to "no branch"), fall back to upstream so we don't render an empty
  // Tabs body.
  useEffect(() => {
    if (tab === 'branch' && !hasBranch && !branchLoading) setTab('upstream');
    if (tab === 'pull' && !hasPull && !pullLoading) setTab('upstream');
  }, [tab, hasBranch, branchLoading, hasPull, pullLoading]);

  return (
    <div className="flex h-full flex-col">
      <div className="px-4 pt-4">
        <h4 className="truncate text-sm font-semibold text-white/85" title={item.title}>
          {item.title}
        </h4>
        <p className="mt-0.5 font-mono text-[10px] text-white/30" title={item.id}>
          {item.id}
        </p>
      </div>

      {/* "Pending review" overlay — viewer's open upstream PR for this
          item. Survives reloads (unlike optimistic mutation state) and
          links to DoltHub. Hidden when the drawer was pushed as a
          cross-reference (actions=null). */}
      {actions && (
        <div className="px-4 pt-3">
          <PendingReviewSection wastelandId={wastelandId} itemId={item.id} />
        </div>
      )}

      <Tabs
        value={tab}
        onValueChange={value => {
          userOverrodeRef.current = true;
          setTab(value === 'branch' ? 'branch' : value === 'pull' ? 'pull' : 'upstream');
        }}
        className="mt-3 flex flex-1 flex-col overflow-hidden"
      >
        <div className="border-b border-white/[0.06] px-4">
          <TabsList className="bg-transparent p-0">
            <TabsTrigger value="upstream" className="data-[state=active]:bg-white/[0.06]">
              Upstream
            </TabsTrigger>
            {(hasBranch || branchLoading) && (
              <TabsTrigger value="branch" className="data-[state=active]:bg-white/[0.06]">
                My branch
              </TabsTrigger>
            )}
            {(hasPull || pullLoading) && (
              <TabsTrigger value="pull" className="data-[state=active]:bg-white/[0.06]">
                Pull request
              </TabsTrigger>
            )}
          </TabsList>
        </div>

        <TabsContent value="upstream" className="mt-0 flex-1 overflow-y-auto p-4">
          <WantedItemUpstreamTab wastelandId={wastelandId} item={item} push={push} />
        </TabsContent>

        <TabsContent value="branch" className="mt-0 flex-1 overflow-y-auto p-4">
          {branchLoading ? (
            <TabSkeleton />
          ) : (
            <WantedItemBranchTab
              wastelandId={wastelandId}
              item={item}
              branch={branch}
              actions={actions}
            />
          )}
        </TabsContent>

        <TabsContent value="pull" className="mt-0 flex-1 overflow-y-auto p-4">
          {pullLoading || !pull ? (
            <TabSkeleton />
          ) : (
            <WantedItemPullTab wastelandId={wastelandId} pull={pull} />
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ── Loading skeleton for a tab body ────────────────────────────────────

function TabSkeleton() {
  return (
    <div className="space-y-3">
      <Skeleton className="h-4 w-1/3" />
      <Skeleton className="h-3 w-2/3" />
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-8 w-1/2" />
    </div>
  );
}

// ── Pending review overlay ─────────────────────────────────────────────

/**
 * Banner shown when the viewer has an open upstream PR for this item.
 * Survives across reloads (unlike optimistic mutation state) and links
 * out to DoltHub for admin review. Bridges the gap between
 * "click claim" and "admin merges the PR" — the wanted board itself
 * reads upstream `main`, which doesn't reflect the in-flight change
 * until the merge lands.
 */
function PendingReviewSection({ wastelandId, itemId }: { wastelandId: string; itemId: string }) {
  const trpc = useWastelandTRPC();
  const queryClient = useQueryClient();
  const pendingQuery = useQuery({
    ...trpc.wasteland.listMyPendingClaims.queryOptions({ wastelandId }),
    refetchInterval: 15_000,
  });
  const pending = pendingQuery.data?.items.find(p => p.item_id === itemId);

  // When this item transitions from "has a pending PR" to "doesn't",
  // the upstream merge (or close) just landed. Kick the board and the
  // item-detail queries so they pick up the new `status=claimed` state
  // without waiting for their own poll intervals to elapse.
  const wasPendingRef = useRef(false);
  useEffect(() => {
    const isPending = pending !== undefined;
    if (wasPendingRef.current && !isPending) {
      void queryClient.invalidateQueries({
        queryKey: trpc.wasteland.browseWantedBoard.queryKey({ wastelandId }),
      });
      void queryClient.invalidateQueries({
        queryKey: trpc.wasteland.getWantedItem.queryKey({ wastelandId, itemId }),
      });
    }
    wasPendingRef.current = isPending;
  }, [pending, queryClient, trpc, wastelandId, itemId]);

  if (!pending) return null;
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-amber-500/20 bg-amber-500/[0.04] p-3">
      <div className="flex items-center gap-1.5 text-xs font-medium text-amber-300">
        <Hourglass className="size-3.5" />
        Pending review
      </div>
      <p className="text-[11px] leading-relaxed text-white/55">
        You opened a PR on upstream. An admin needs to merge it before the status updates here.
      </p>
      <a
        href={pending.pr_url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 self-start text-[11px] text-amber-300 underline underline-offset-2 hover:text-amber-200"
      >
        <ExternalLink className="size-3" />
        PR #{pending.pull_id}
      </a>
    </div>
  );
}
