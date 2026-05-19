'use client';

/**
 * Fork (workshop) view — the user's `wl/<rigHandle>/*` branches on
 * their DoltHub fork. Each card-row represents one in-flight item:
 * shows what the item is, where it sits relative to upstream, whether
 * a PR is open, and the actions available (publish / discard /
 * continue working).
 *
 * Reads:
 *   - wasteland.listMyForkBranches  → branch list
 *   - wasteland.getCredentialStatus → dolthubOrg for the header label
 *
 * Mutations:
 *   - wasteland.publishBranch       → open or update a PR
 *   - wasteland.discardBranch       → delete the branch (idempotent)
 *
 * Drawer hand-off: clicking "Continue" opens the existing wanted-item
 * drawer keyed by `wantedId`. Action wiring is left to the drawer
 * itself (this page intentionally does not duplicate claim/done/etc.
 * mutations — they live behind the drawer for now).
 */

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useWastelandTRPC } from '@/lib/wasteland/trpc';
import type { WastelandOutputs } from '@/lib/wasteland/trpc';
import { useWastelandRepo } from '../_components/WastelandRepoContext';
import { useDrawerStack } from '@/components/wasteland/drawer/WastelandDrawerStack';
import {
  AcceptDialog,
  CloseItemDialog,
  MarkDoneDialog,
  RejectDialog,
  UnclaimDialog,
} from '../../../by-id/[wastelandId]/wanted/WantedBoardClient';
import type { WantedItem } from '@/components/wasteland/drawer/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { InlineDeleteConfirmation } from '@/components/ui/inline-delete-confirmation';
import { toast } from 'sonner';
import { ExternalLink, GitBranch, GitFork, Loader2, RefreshCw, Send } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

type ForkBranch = WastelandOutputs['wasteland']['listMyForkBranches'][number];
type Status = ForkBranch['wantedStatusOnBranch'];
type Divergence = ForkBranch['divergence'];

const STATUS_LABEL: Record<Status, string> = {
  open: 'Open',
  claimed: 'Claimed',
  in_review: 'In review',
  completed: 'Completed',
  unknown: 'Unknown',
};

const STATUS_TONE: Record<Status, string> = {
  open: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-300',
  claimed: 'border-amber-500/20 bg-amber-500/10 text-amber-300',
  in_review: 'border-violet-500/20 bg-violet-500/10 text-violet-300',
  completed: 'border-sky-500/20 bg-sky-500/10 text-sky-300',
  unknown: 'border-white/10 bg-white/[0.04] text-white/40',
};

const DIVERGENCE_LABEL: Record<Divergence, string> = {
  'in-sync': 'In sync',
  ahead: 'Ahead',
  diverged: 'Diverged',
};

const DIVERGENCE_TONE: Record<Divergence, string> = {
  'in-sync': 'border-white/10 bg-white/[0.04] text-white/45',
  ahead: 'border-white/10 bg-white/[0.04] text-white/55',
  diverged: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
};

const DIVERGENCE_HINT: Record<Divergence, string> = {
  'in-sync': 'Branch and upstream agree on this item.',
  ahead: 'Branch is ahead of upstream — your work is in flight.',
  diverged:
    'Upstream has moved past your branch. The branch may be stale; consider discarding or rebasing.',
};

export function ForkClient() {
  const repo = useWastelandRepo();
  const trpc = useWastelandTRPC();
  const queryClient = useQueryClient();
  const { open: openDrawer } = useDrawerStack();
  const searchParams = useSearchParams();

  const branchesQuery = useQuery(
    trpc.wasteland.listMyForkBranches.queryOptions({ wastelandId: repo.wastelandId })
  );
  const credentialQuery = useQuery(
    trpc.wasteland.getCredentialStatus.queryOptions({ wastelandId: repo.wastelandId })
  );

  const branchesQueryKey = trpc.wasteland.listMyForkBranches.queryKey({
    wastelandId: repo.wastelandId,
  });
  const refetch = () => {
    void queryClient.invalidateQueries({ queryKey: branchesQueryKey });
  };

  const publishMutation = useMutation({
    ...trpc.wasteland.publishBranch.mutationOptions(),
    onSuccess: result => {
      toast.success('PR published', {
        description: result.prUrl,
        action: {
          label: 'Open',
          onClick: () => window.open(result.prUrl, '_blank', 'noopener,noreferrer'),
        },
      });
      refetch();
    },
    onError: err => toast.error(`Publish failed: ${err.message}`),
  });

  const discardMutation = useMutation({
    ...trpc.wasteland.discardBranch.mutationOptions(),
    onSuccess: (_result, variables) => {
      toast.success('Branch discarded', {
        description: 'Any open DoltHub PR for the branch was closed.',
      });
      setSuppressedWantedIds(current => new Set(current).add(variables.wantedId));
      queryClient.setQueryData<ForkBranch[]>(
        branchesQueryKey,
        current => current?.filter(branch => branch.wantedId !== variables.wantedId) ?? current
      );
      refetch();
      void queryClient.invalidateQueries({
        queryKey: trpc.wasteland.listMyPulls.queryKey({ wastelandId: repo.wastelandId }),
      });
    },
    onError: err => toast.error(`Discard failed: ${err.message}`),
  });

  const dolthubOrg = credentialQuery.data?.dolthub_org ?? null;
  const isAdmin = credentialQuery.data?.is_upstream_admin ?? false;
  const [suppressedWantedIds, setSuppressedWantedIds] = useState<Set<string>>(() => new Set());
  const branches = useMemo(
    () => (branchesQuery.data ?? []).filter(branch => !suppressedWantedIds.has(branch.wantedId)),
    [branchesQuery.data, suppressedWantedIds]
  );

  useEffect(() => {
    if (!branchesQuery.data || suppressedWantedIds.size === 0) return;
    const returnedWantedIds = new Set(branchesQuery.data.map(branch => branch.wantedId));
    const next = new Set<string>();
    for (const wantedId of suppressedWantedIds) {
      if (returnedWantedIds.has(wantedId)) next.add(wantedId);
    }
    if (next.size !== suppressedWantedIds.size) setSuppressedWantedIds(next);
  }, [branchesQuery.data, suppressedWantedIds]);

  const [doneItem, setDoneItem] = useState<WantedItem | null>(null);
  const [acceptItem, setAcceptItem] = useState<WantedItem | null>(null);
  const [rejectItem, setRejectItem] = useState<WantedItem | null>(null);
  const [closeItem, setCloseItem] = useState<WantedItem | null>(null);
  const [unclaimItem, setUnclaimItem] = useState<WantedItem | null>(null);

  const upstreamPath = `/wasteland/${repo.owner}/${repo.repo}`;

  const autoOpenedWantedIdRef = useRef<string | null>(null);
  const drawerActions = {
    isAdmin,
    onDone: setDoneItem,
    onAccept: setAcceptItem,
    onReject: setRejectItem,
    onCloseItem: setCloseItem,
    onUnclaim: setUnclaimItem,
  };

  const invalidateWorkshop = () => {
    void queryClient.invalidateQueries({ queryKey: branchesQueryKey });
    void queryClient.invalidateQueries({
      queryKey: trpc.wasteland.browseWantedBoard.queryKey({ wastelandId: repo.wastelandId }),
    });
    void queryClient.invalidateQueries({
      queryKey: trpc.wasteland.listMyPendingClaims.queryKey({ wastelandId: repo.wastelandId }),
    });
  };

  useEffect(() => {
    const wantedId = searchParams?.get('wantedId');
    if (!wantedId) return;
    if (autoOpenedWantedIdRef.current === wantedId) return;
    autoOpenedWantedIdRef.current = wantedId;
    openDrawer({
      type: 'wanted-item-by-id',
      wastelandId: repo.wastelandId,
      itemId: wantedId,
      actions: drawerActions,
      initialTab: 'branch',
    });
  }, [searchParams, openDrawer, repo.wastelandId, isAdmin]);

  return (
    <TooltipProvider delayDuration={150}>
      <div className="flex h-full flex-col">
        <ForkHeader dolthubOrg={dolthubOrg} repoName={repo.repo} onRefresh={refetch} />

        <div className="flex-1 overflow-y-auto px-6 py-4">
          {branchesQuery.isLoading && <ForkSkeleton />}

          {branchesQuery.isError && !branchesQuery.isLoading && (
            <div className="rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-3">
              <p className="text-sm text-red-400">Failed to load fork branches</p>
              <p className="mt-1 font-mono text-[11px] text-white/40">
                {branchesQuery.error.message}
              </p>
            </div>
          )}

          {!branchesQuery.isLoading && !branchesQuery.isError && branches.length === 0 && (
            <ForkEmpty upstreamPath={upstreamPath} />
          )}

          {branches.length > 0 && (
            <div className="flex flex-col gap-2">
              {branches.map(branch => (
                <BranchRow
                  key={branch.branchName}
                  branch={branch}
                  onContinue={() =>
                    openDrawer({
                      type: 'wanted-item-by-id',
                      wastelandId: repo.wastelandId,
                      itemId: branch.wantedId,
                      actions: drawerActions,
                      // Fork view → land on the My branch tab, where
                      // the publish/discard affordances live.
                      initialTab: 'branch',
                    })
                  }
                  onPublish={() =>
                    publishMutation.mutate({
                      wastelandId: repo.wastelandId,
                      wantedId: branch.wantedId,
                    })
                  }
                  onDiscard={async () => {
                    await discardMutation.mutateAsync({
                      wastelandId: repo.wastelandId,
                      wantedId: branch.wantedId,
                    });
                  }}
                  publishing={
                    publishMutation.isPending &&
                    publishMutation.variables?.wantedId === branch.wantedId
                  }
                  discarding={
                    discardMutation.isPending &&
                    discardMutation.variables?.wantedId === branch.wantedId
                  }
                />
              ))}
            </div>
          )}
        </div>
        <MarkDoneDialog
          wastelandId={repo.wastelandId}
          item={doneItem}
          onClose={() => setDoneItem(null)}
          onSuccess={invalidateWorkshop}
        />
        <AcceptDialog
          wastelandId={repo.wastelandId}
          item={acceptItem}
          onClose={() => setAcceptItem(null)}
          onSuccess={invalidateWorkshop}
        />
        <RejectDialog
          wastelandId={repo.wastelandId}
          item={rejectItem}
          onClose={() => setRejectItem(null)}
          onSuccess={invalidateWorkshop}
        />
        <CloseItemDialog
          wastelandId={repo.wastelandId}
          item={closeItem}
          onClose={() => setCloseItem(null)}
          onSuccess={invalidateWorkshop}
        />
        <UnclaimDialog
          wastelandId={repo.wastelandId}
          item={unclaimItem}
          onClose={() => setUnclaimItem(null)}
          onSuccess={invalidateWorkshop}
        />
      </div>
    </TooltipProvider>
  );
}

// ── Header ──────────────────────────────────────────────────────────────

function ForkHeader({
  dolthubOrg,
  repoName,
  onRefresh,
}: {
  dolthubOrg: string | null;
  repoName: string;
  onRefresh: () => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-white/[0.06] bg-white/[0.015] px-6 py-3">
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium text-white/85">
          Your fork
          {dolthubOrg && (
            <>
              {' — '}
              <span className="font-mono text-white/65">
                {dolthubOrg}/{repoName}
              </span>
            </>
          )}
        </p>
        <p className="text-xs text-white/45">
          Your private workshop. Work here stays on your fork until you publish a PR.
        </p>
      </div>
      <Button
        variant="ghost"
        size="sm"
        onClick={onRefresh}
        className="h-8 gap-1.5 text-white/55 hover:text-white/80"
      >
        <RefreshCw className="size-3.5" />
        Refresh
      </Button>
    </div>
  );
}

// ── Empty state ─────────────────────────────────────────────────────────

function ForkEmpty({ upstreamPath }: { upstreamPath: string }) {
  return (
    <div className="mx-auto mt-12 flex max-w-md flex-col items-center gap-3 text-center">
      <div className="flex size-10 items-center justify-center rounded-lg border border-white/10 bg-white/[0.03]">
        <GitFork className="size-5 text-white/40" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium text-white/80">No work in flight.</p>
        <p className="max-w-sm text-xs text-white/45">
          Browse the upstream and claim something to start a branch on your fork.
        </p>
      </div>
      <Button asChild size="sm" className="mt-2">
        <Link href={upstreamPath}>Browse upstream</Link>
      </Button>
    </div>
  );
}

// ── Loading skeleton ────────────────────────────────────────────────────

function ForkSkeleton() {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: 3 }).map((_, i) => (
        <div
          key={i}
          className="animate-pulse rounded-xl border border-white/[0.06] bg-white/[0.02] p-4"
        >
          <div className="h-4 w-2/3 rounded bg-white/[0.06]" />
          <div className="mt-2 h-3 w-1/3 rounded bg-white/[0.04]" />
        </div>
      ))}
    </div>
  );
}

// ── Branch card ─────────────────────────────────────────────────────────

function BranchRow({
  branch,
  onContinue,
  onPublish,
  onDiscard,
  publishing,
  discarding,
}: {
  branch: ForkBranch;
  onContinue: () => void;
  onPublish: () => void;
  onDiscard: () => Promise<void>;
  publishing: boolean;
  discarding: boolean;
}) {
  const [discardOpen, setDiscardOpen] = useState(false);

  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4 transition-colors hover:bg-white/[0.03]">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <button
            type="button"
            onClick={onContinue}
            className="text-left text-sm font-medium text-white/85 transition-colors hover:text-primary"
          >
            {branch.wantedTitle ?? (
              <span className="font-mono text-white/55">{branch.wantedId}</span>
            )}
          </button>
          <div className="mt-1 flex flex-wrap items-center gap-2 font-mono text-[11px] text-white/40">
            <GitBranch className="size-3" />
            <span className="truncate">{branch.branchName}</span>
            {branch.lastCommitAt && (
              <>
                <span className="text-white/15">·</span>
                <span>updated {formatRelative(branch.lastCommitAt)}</span>
              </>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <StatusPair branch={branch.wantedStatusOnBranch} main={branch.wantedStatusOnMain} />
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant="outline" className={`gap-1 ${DIVERGENCE_TONE[branch.divergence]}`}>
                {DIVERGENCE_LABEL[branch.divergence]}
              </Badge>
            </TooltipTrigger>
            <TooltipContent side="bottom">{DIVERGENCE_HINT[branch.divergence]}</TooltipContent>
          </Tooltip>
          {branch.hasOpenPR && branch.prUrl && (
            <Tooltip>
              <TooltipTrigger asChild>
                <a
                  href={branch.prUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 rounded-full border border-violet-500/30 bg-violet-500/10 px-2 py-0.5 text-[10px] font-medium text-violet-200 transition-colors hover:bg-violet-500/15"
                >
                  PR open
                  <ExternalLink className="size-3" />
                </a>
              </TooltipTrigger>
              <TooltipContent side="bottom">View on DoltHub</TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={onContinue} className="h-8 gap-1.5">
          Continue
        </Button>
        <Button size="sm" onClick={onPublish} disabled={publishing} className="h-8 gap-1.5">
          {publishing ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Send className="size-3.5" />
          )}
          {branch.hasOpenPR ? 'Update PR' : 'Publish'}
        </Button>
        <div className="ml-auto">
          {discardOpen ? (
            <InlineDeleteConfirmation
              onDelete={async () => {
                await onDiscard();
                setDiscardOpen(false);
              }}
              isLoading={discarding}
              confirmText="Discard"
              cancelText="Cancel"
              warningText="Closes the open PR for this branch, then deletes the branch from your fork. Cannot be undone."
            />
          ) : (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setDiscardOpen(true)}
              className="h-8 text-white/55 hover:bg-red-500/10 hover:text-red-300"
              disabled={discarding}
            >
              Discard
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Status pair (branch / main) ────────────────────────────────────────

function StatusPair({ branch, main }: { branch: Status; main: Status }) {
  return (
    <div className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/[0.02] px-1.5 py-0.5 text-[10px] font-medium">
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={`rounded-sm border px-1.5 py-0.5 ${STATUS_TONE[branch]}`}>
            {STATUS_LABEL[branch]}
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom">Status on your branch</TooltipContent>
      </Tooltip>
      <span className="text-white/25">→</span>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={`rounded-sm border px-1.5 py-0.5 ${STATUS_TONE[main]}`}>
            {STATUS_LABEL[main]}
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom">Status on upstream main</TooltipContent>
      </Tooltip>
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────

function formatRelative(iso: string): string {
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return iso;
  }
}
