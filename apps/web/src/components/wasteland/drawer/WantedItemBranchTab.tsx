'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';
import {
  ExternalLink,
  Pencil,
  GitBranch,
  Hand,
  Loader2,
  Send,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  UserMinus,
  XCircle,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { InlineDeleteConfirmation } from '@/components/ui/inline-delete-confirmation';
import type { DrawerStackHelpers } from '@/components/drawer';
import { useWastelandTRPC } from '@/lib/wasteland/trpc';
import type { WastelandOutputs } from '@/lib/wasteland/trpc';
import type { WantedItem, WantedPanelActions, WastelandDrawerRef } from './types';

type ForkBranch = WastelandOutputs['wasteland']['listMyForkBranches'][number];
type Status = ForkBranch['wantedStatusOnBranch'];
type Divergence = ForkBranch['divergence'];

const STATUS_TONE: Record<Status, string> = {
  open: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-300',
  claimed: 'border-amber-500/20 bg-amber-500/10 text-amber-300',
  in_review: 'border-violet-500/20 bg-violet-500/10 text-violet-300',
  completed: 'border-sky-500/20 bg-sky-500/10 text-sky-300',
  unknown: 'border-white/10 bg-white/[0.04] text-white/40',
};

const STATUS_LABEL: Record<Status, string> = {
  open: 'Open',
  claimed: 'Claimed',
  in_review: 'In review',
  completed: 'Completed',
  unknown: 'Unknown',
};

const DIVERGENCE_TONE: Record<Divergence, string> = {
  'in-sync': 'border-white/10 bg-white/[0.04] text-white/45',
  ahead: 'border-white/10 bg-white/[0.04] text-white/55',
  diverged: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
};

const DIVERGENCE_LABEL: Record<Divergence, string> = {
  'in-sync': 'In sync',
  ahead: 'Ahead',
  diverged: 'Diverged',
};

const DIVERGENCE_HINT: Record<Divergence, string> = {
  'in-sync': 'Your branch agrees with upstream on this item.',
  ahead: 'Your branch is ahead of upstream — work in flight.',
  diverged: 'Upstream has moved past your branch. The branch may be stale; consider discarding.',
};

/**
 * The "My branch" tab — what the user's `wl/<rigHandle>/<wantedId>`
 * branch says, plus the affordances to advance it (claim → done,
 * publish, update PR, discard).
 *
 * The branch row that backs this is read in the parent panel via
 * `listMyForkBranches`, then passed in. State-changing item actions
 * (claim/done/accept/reject/close/unclaim) are wired through the
 * top-level page's existing dialogs (`actions`) — this tab does not
 * spawn its own confirmation modals because the drawer sits above the
 * Dialog overlay z-index.
 */
export function WantedItemBranchTab({
  wastelandId,
  item,
  branch,
  actions,
  push,
}: {
  wastelandId: string;
  item: WantedItem;
  /**
   * The matching `wl/<rig>/<wantedId>` branch row, or `null` when the
   * user has no branch for this item yet. The empty state asks the
   * user to claim the item (or, in cross-reference / read-only mode,
   * explains nothing's there).
   */
  branch: ForkBranch | null;
  /**
   * Page-level action callbacks. `null` when the drawer was pushed as
   * a cross-reference — render the read-only summary instead.
   */
  actions: WantedPanelActions | null;
  push: DrawerStackHelpers<WastelandDrawerRef>['push'];
}) {
  if (!branch) {
    return <BranchEmptyState wastelandId={wastelandId} item={item} actions={actions} />;
  }

  return (
    <div className="space-y-4">
      <BranchHeader branch={branch} />
      {actions && (
        <BranchActionButtons
          wastelandId={wastelandId}
          item={item}
          branch={branch}
          status={branch.wantedStatusOnBranch}
          actions={actions}
          push={push}
        />
      )}
      {actions && <PublishOrUpdateRow wastelandId={wastelandId} branch={branch} />}
      {actions && <DiscardRow wastelandId={wastelandId} branch={branch} />}
    </div>
  );
}

// ── Header summary ─────────────────────────────────────────────────────

function BranchHeader({ branch }: { branch: ForkBranch }) {
  return (
    <div className="space-y-2">
      <p className="text-[10px] font-semibold tracking-[0.08em] text-white/30 uppercase">
        Your branch
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="outline" className={STATUS_TONE[branch.wantedStatusOnBranch]}>
          {STATUS_LABEL[branch.wantedStatusOnBranch]}
        </Badge>
        <Badge variant="outline" className={DIVERGENCE_TONE[branch.divergence]}>
          {DIVERGENCE_LABEL[branch.divergence]}
        </Badge>
        {branch.hasOpenPR && (
          <Badge
            variant="outline"
            className="border-violet-500/30 bg-violet-500/10 text-violet-200"
          >
            PR open
          </Badge>
        )}
      </div>
      <p className="text-[11px] text-white/45">{DIVERGENCE_HINT[branch.divergence]}</p>
      <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-white/40">
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
  );
}

// ── Item-level actions (claim/done/accept/reject/close/unclaim) ────────

function BranchActionButtons({
  wastelandId,
  item,
  branch,
  status,
  actions,
  push,
}: {
  wastelandId: string;
  item: WantedItem;
  branch: ForkBranch;
  status: Status;
  actions: WantedPanelActions;
  push: DrawerStackHelpers<WastelandDrawerRef>['push'];
}) {
  const { isAdmin, onAccept, onReject, onCloseItem, onUnclaim } = actions;
  const canEditPostedItem =
    status === 'open' && branch.hasOpenPR && branch.wantedRowOnBranch !== null;

  return (
    <div className="flex flex-col gap-2 border-t border-white/[0.06] pt-3">
      <p className="text-[10px] font-semibold tracking-[0.08em] text-white/30 uppercase">
        Stack a change
      </p>
      {canEditPostedItem && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() =>
            push({
              type: 'edit-wanted-item',
              wastelandId,
              item: branch.wantedRowOnBranch ?? item,
            })
          }
          className="h-8 gap-1.5"
        >
          <Pencil className="size-3.5" />
          Edit wanted item
        </Button>
      )}
      {status === 'open' && <ClaimAction wastelandId={wastelandId} item={item} />}
      {status === 'claimed' && <MarkDoneInlineForm wastelandId={wastelandId} item={item} />}
      {isAdmin && status === 'claimed' && (
        <button
          type="button"
          onClick={() => onUnclaim(item)}
          className="inline-flex items-center justify-center gap-1.5 rounded-md border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs font-medium text-amber-400 transition-colors hover:bg-amber-500/20"
        >
          <UserMinus className="size-3.5" />
          Unclaim (admin)
        </button>
      )}
      {isAdmin && status === 'in_review' && (
        <>
          <button
            type="button"
            onClick={() => onAccept(item)}
            className="inline-flex items-center justify-center gap-1.5 rounded-md border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-xs font-medium text-emerald-400 transition-colors hover:bg-emerald-500/20"
          >
            <ThumbsUp className="size-3.5" />
            Accept
          </button>
          <button
            type="button"
            onClick={() => onReject(item)}
            className="inline-flex items-center justify-center gap-1.5 rounded-md border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs font-medium text-red-400 transition-colors hover:bg-red-500/20"
          >
            <ThumbsDown className="size-3.5" />
            Reject
          </button>
        </>
      )}
      {status === 'in_review' && !isAdmin && (
        <p className="rounded-md border border-violet-500/20 bg-violet-500/[0.04] px-3 py-2 text-[11px] text-white/55">
          In review with the maintainers — no action needed from you right now.
        </p>
      )}
      {isAdmin && (status === 'open' || status === 'claimed' || status === 'in_review') && (
        <button
          type="button"
          onClick={() => onCloseItem(item)}
          className="inline-flex items-center justify-center gap-1.5 rounded-md border border-white/[0.1] bg-white/[0.04] px-3 py-2 text-xs font-medium text-white/60 transition-colors hover:bg-white/[0.08]"
        >
          <XCircle className="size-3.5" />
          Close (admin)
        </button>
      )}
    </div>
  );
}

function MarkDoneInlineForm({ wastelandId, item }: { wastelandId: string; item: WantedItem }) {
  const trpc = useWastelandTRPC();
  const queryClient = useQueryClient();
  const [evidence, setEvidence] = useState('');

  const doneMutation = useMutation({
    ...trpc.wasteland.markWantedItemDone.mutationOptions(),
    onSuccess: result => {
      toast.success(
        result.pr_url ? 'Item marked as done — PR opened' : 'Item marked as done',
        result.pr_url
          ? {
              description: result.pr_url,
              action: {
                label: 'Open',
                onClick: () => window.open(result.pr_url ?? '', '_blank', 'noopener,noreferrer'),
              },
            }
          : undefined
      );
      setEvidence('');
      void queryClient.invalidateQueries({
        queryKey: trpc.wasteland.browseWantedBoard.queryKey({ wastelandId }),
      });
      void queryClient.invalidateQueries({
        queryKey: trpc.wasteland.getWantedItem.queryKey({ wastelandId, itemId: item.id }),
      });
      void queryClient.invalidateQueries({
        queryKey: trpc.wasteland.listMyForkBranches.queryKey({ wastelandId }),
      });
      void queryClient.invalidateQueries({
        queryKey: trpc.wasteland.listMyPendingClaims.queryKey({ wastelandId }),
      });
      void queryClient.invalidateQueries({
        queryKey: trpc.wasteland.listMyPulls.queryKey({ wastelandId }),
      });
    },
    onError: err => toast.error(err.message || 'Failed to mark item as done'),
  });

  return (
    <form
      onSubmit={e => {
        e.preventDefault();
        const trimmed = evidence.trim();
        if (!trimmed) return;
        doneMutation.mutate({ wastelandId, itemId: item.id, evidence: trimmed });
      }}
      className="space-y-2 rounded-md border border-sky-500/20 bg-sky-500/[0.04] p-3"
    >
      <div className="space-y-1">
        <label
          htmlFor={`evidence-url-${item.id}`}
          className="block text-[10px] font-semibold tracking-[0.08em] text-sky-200/70 uppercase"
        >
          Submit evidence
        </label>
        <p className="text-[11px] leading-relaxed text-white/50">
          Paste a PR, commit, or artifact URL proving this item is complete.
        </p>
      </div>
      <input
        id={`evidence-url-${item.id}`}
        type="url"
        required
        placeholder="https://github.com/org/repo/pull/123"
        value={evidence}
        onChange={e => setEvidence(e.target.value)}
        className="w-full rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-white/80 placeholder:text-white/25 focus:border-sky-500/40 focus:outline-none"
      />
      <Button
        type="submit"
        size="sm"
        disabled={doneMutation.isPending || !evidence.trim()}
        className="h-8 w-full gap-1.5"
      >
        {doneMutation.isPending ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <Send className="size-3.5" />
        )}
        Submit evidence
      </Button>
    </form>
  );
}

// ── Publish / Update PR ────────────────────────────────────────────────

function PublishOrUpdateRow({ wastelandId, branch }: { wastelandId: string; branch: ForkBranch }) {
  const trpc = useWastelandTRPC();
  const queryClient = useQueryClient();

  const publishMutation = useMutation({
    ...trpc.wasteland.publishBranch.mutationOptions(),
    onSuccess: result => {
      toast.success(branch.hasOpenPR ? 'PR updated' : 'PR published', {
        description: result.prUrl,
        action: {
          label: 'Open',
          onClick: () => window.open(result.prUrl, '_blank', 'noopener,noreferrer'),
        },
      });
      void queryClient.invalidateQueries({
        queryKey: trpc.wasteland.listMyForkBranches.queryKey({ wastelandId }),
      });
      void queryClient.invalidateQueries({
        queryKey: trpc.wasteland.listMyPulls.queryKey({ wastelandId }),
      });
    },
    onError: err => toast.error(err.message || 'Publish failed'),
  });

  const isUpdate = branch.hasOpenPR;
  const Icon = isUpdate ? ExternalLink : Send;
  // Variant choice: a fresh "Publish" is the brand moment for this view —
  // the user is finally pushing their work into the shared world. Use
  // `default` (yellow-green primary) for that. "Update PR" is a quieter
  // re-push and uses a neutral outline.
  const variant: 'default' | 'outline' = isUpdate ? 'outline' : 'default';

  return (
    <div className="flex flex-col gap-1.5 border-t border-white/[0.06] pt-3">
      <p className="text-[10px] font-semibold tracking-[0.08em] text-white/30 uppercase">
        {isUpdate ? 'Pull request' : 'Publish to upstream'}
      </p>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant={variant}
          onClick={() => publishMutation.mutate({ wastelandId, wantedId: branch.wantedId })}
          disabled={publishMutation.isPending}
          className="h-8 gap-1.5"
        >
          {publishMutation.isPending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Icon className="size-3.5" />
          )}
          {isUpdate ? 'Update PR' : 'Publish'}
        </Button>
        {branch.hasOpenPR && branch.prUrl && (
          <a
            href={branch.prUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-[11px] text-violet-200 underline underline-offset-2 hover:text-violet-100"
          >
            <ExternalLink className="size-3" />
            View on DoltHub
          </a>
        )}
      </div>
      <p className="text-[11px] text-white/40">
        {isUpdate
          ? 'Re-pushes your branch to the open PR. Idempotent if there are no new commits.'
          : 'Opens a pull request from your branch against the upstream.'}
      </p>
    </div>
  );
}

// ── Discard ────────────────────────────────────────────────────────────

function DiscardRow({ wastelandId, branch }: { wastelandId: string; branch: ForkBranch }) {
  const trpc = useWastelandTRPC();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);

  const discardMutation = useMutation({
    ...trpc.wasteland.discardBranch.mutationOptions(),
    onSuccess: () => {
      toast.success('Branch discarded', {
        description: 'Any open DoltHub PR for the branch was closed.',
      });
      void queryClient.invalidateQueries({
        queryKey: trpc.wasteland.listMyForkBranches.queryKey({ wastelandId }),
      });
      void queryClient.invalidateQueries({
        queryKey: trpc.wasteland.listMyPulls.queryKey({ wastelandId }),
      });
      void queryClient.invalidateQueries({
        queryKey: trpc.wasteland.listMyPendingClaims.queryKey({ wastelandId }),
      });
      setOpen(false);
    },
    onError: err => toast.error(err.message || 'Discard failed'),
  });

  return (
    <div className="border-t border-white/[0.06] pt-3">
      {open ? (
        <InlineDeleteConfirmation
          onDelete={async () => {
            await discardMutation.mutateAsync({ wastelandId, wantedId: branch.wantedId });
          }}
          isLoading={discardMutation.isPending}
          confirmText="Discard branch"
          cancelText="Cancel"
          warningText="Closes the open PR for this branch, then deletes the branch from your fork. Cannot be undone."
        />
      ) : (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setOpen(true)}
          className="h-8 gap-1.5 text-white/55 hover:bg-red-500/10 hover:text-red-300"
        >
          <Trash2 className="size-3.5" />
          Discard branch
        </Button>
      )}
    </div>
  );
}

// ── Empty state (no branch yet) ───────────────────────────────────────

function BranchEmptyState({
  wastelandId,
  item,
  actions,
}: {
  wastelandId: string;
  item: WantedItem;
  actions: WantedPanelActions | null;
}) {
  // No-actions mode (cross-reference) — keep this read-only.
  if (!actions) {
    return (
      <div className="flex flex-col items-center gap-3 px-4 py-6 text-center">
        <div className="flex size-10 items-center justify-center rounded-lg border border-white/10 bg-white/[0.03]">
          <GitBranch className="size-5 text-white/40" />
        </div>
        <p className="text-sm text-white/70">No branch for this item.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-3 px-4 py-6 text-center">
      <div className="flex size-10 items-center justify-center rounded-lg border border-white/10 bg-white/[0.03]">
        <GitBranch className="size-5 text-white/40" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium text-white/80">No branch yet.</p>
        <p className="max-w-sm text-xs text-white/45">
          Claim this item to start a branch on your fork. Work stays on your fork until you publish
          a PR.
        </p>
      </div>
      {item.status === 'open' && <ClaimAction wastelandId={wastelandId} item={item} />}
      {item.status !== 'open' && (
        <p className="rounded-md border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-[11px] text-white/55">
          No branch exists for you yet. This upstream item is currently {item.status}, so it cannot
          be claimed from this fork.
        </p>
      )}
    </div>
  );
}

// ── Inline claim action ───────────────────────────────────────────────

/**
 * Mirrors the legacy single-pane drawer's claim flow: first click
 * primes a confirm row, second click fires the mutation. Kept inline
 * (rather than as a Dialog) because the drawer stack sits at z-[60]
 * and a Dialog overlay would render behind it.
 */
export function ClaimAction({ wastelandId, item }: { wastelandId: string; item: WantedItem }) {
  const trpc = useWastelandTRPC();
  const queryClient = useQueryClient();
  const [isConfirming, setIsConfirming] = useState(false);

  const claimMutation = useMutation({
    ...trpc.wasteland.claimWantedItem.mutationOptions(),
    onSuccess: data => {
      const prUrl = data.pr_url;
      if (prUrl) {
        toast.success('Claim submitted for review', {
          description: 'An upstream admin will merge the claim PR.',
          action: {
            label: 'View PR',
            onClick: () => window.open(prUrl, '_blank', 'noopener,noreferrer'),
          },
        });
      } else {
        toast.success('Item claimed');
      }
      void queryClient.invalidateQueries({
        queryKey: trpc.wasteland.browseWantedBoard.queryKey({ wastelandId }),
      });
      void queryClient.invalidateQueries({
        queryKey: trpc.wasteland.getWantedItem.queryKey({ wastelandId, itemId: item.id }),
      });
      void queryClient.invalidateQueries({
        queryKey: trpc.wasteland.listMyPendingClaims.queryKey({ wastelandId }),
      });
      void queryClient.invalidateQueries({
        queryKey: trpc.wasteland.listMyForkBranches.queryKey({ wastelandId }),
      });
      setIsConfirming(false);
    },
    onError: err => {
      toast.error(err.message || 'Failed to claim item');
    },
  });

  if (!isConfirming) {
    return (
      <button
        type="button"
        onClick={() => setIsConfirming(true)}
        className="inline-flex items-center justify-center gap-1.5 rounded-md border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-xs font-medium text-emerald-400 transition-colors hover:bg-emerald-500/20"
      >
        <Hand className="size-3.5" />
        Claim this item
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-emerald-500/20 bg-emerald-500/[0.04] p-3">
      <p className="text-xs leading-relaxed text-white/70">
        Claim this item? You&apos;ll be responsible for completing it.
      </p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={claimMutation.isPending}
          onClick={() => claimMutation.mutate({ wastelandId, itemId: item.id })}
          className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-md bg-emerald-500/20 px-3 py-2 text-xs font-medium text-emerald-300 transition-colors hover:bg-emerald-500/30 disabled:opacity-50"
        >
          {claimMutation.isPending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Hand className="size-3.5" />
          )}
          Yes, claim it
        </button>
        <button
          type="button"
          disabled={claimMutation.isPending}
          onClick={() => setIsConfirming(false)}
          className="inline-flex items-center justify-center rounded-md border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-xs text-white/60 transition-colors hover:bg-white/[0.06] disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
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
