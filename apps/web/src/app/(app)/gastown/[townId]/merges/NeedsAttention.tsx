'use client';

import { useState, useMemo, Fragment } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { useGastownTRPC } from '@/lib/gastown/trpc';
import type { GastownOutputs } from '@/lib/gastown/trpc';
import { useDrawerStack } from '@/components/gastown/DrawerStack';
import { formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';
import { motion, AnimatePresence } from 'motion/react';
import {
  AlertTriangle,
  ExternalLink,
  Eye,
  GitBranch,
  GitMerge,
  RefreshCw,
  XCircle,
  CheckCircle2,
  Clock,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

// ── Types ────────────────────────────────────────────────────────────

type MergeQueueData = GastownOutputs['gastown']['getMergeQueueData'];
type MergeQueueItem = MergeQueueData['needsAttention']['openPRs'][number];

type ConvoyGroup = {
  convoy: NonNullable<MergeQueueItem['convoy']>;
  items: MergeQueueItem[];
};

type ConfirmAction = {
  beadId: string;
  title: string;
  action: 'fail' | 'retry';
};

// ── Status badges ────────────────────────────────────────────────────

const CATEGORY_STYLES = {
  openPR: {
    border: 'border-violet-500/30',
    bg: 'bg-violet-500/10',
    text: 'text-violet-300',
    label: 'PR Open',
  },
  failed: {
    border: 'border-red-500/30',
    bg: 'bg-red-500/10',
    text: 'text-red-300',
    label: 'Failed',
  },
  stale: {
    border: 'border-amber-500/30',
    bg: 'bg-amber-500/10',
    text: 'text-amber-300',
    label: 'Stale',
  },
} as const;

type Category = keyof typeof CATEGORY_STYLES;

// ── Convoy grouping ──────────────────────────────────────────────────

function groupByConvoy(items: MergeQueueItem[]): {
  convoyGroups: ConvoyGroup[];
  standalone: MergeQueueItem[];
} {
  const convoyMap = new Map<string, ConvoyGroup>();
  const standalone: MergeQueueItem[] = [];

  for (const item of items) {
    if (item.convoy) {
      const existing = convoyMap.get(item.convoy.convoy_id);
      if (existing) {
        existing.items.push(item);
      } else {
        convoyMap.set(item.convoy.convoy_id, {
          convoy: item.convoy,
          items: [item],
        });
      }
    } else {
      standalone.push(item);
    }
  }

  return {
    convoyGroups: [...convoyMap.values()],
    standalone,
  };
}

// ── Main component ───────────────────────────────────────────────────

export function NeedsAttention({
  data,
  townId,
}: {
  data: MergeQueueData['needsAttention'];
  townId: string;
}) {
  const session = useSession();
  const isAdmin = session?.data?.isAdmin ?? false;
  const totalCount = data.openPRs.length + data.failedReviews.length + data.stalePRs.length;

  // Tag each item with its category for rendering
  const allItems = useMemo(() => {
    const tagged: Array<{ item: MergeQueueItem; category: Category }> = [];
    for (const item of data.openPRs) tagged.push({ item, category: 'openPR' });
    for (const item of data.failedReviews) tagged.push({ item, category: 'failed' });
    for (const item of data.stalePRs) tagged.push({ item, category: 'stale' });
    return tagged;
  }, [data]);

  // Group by convoy
  const { convoyGroups, standalone } = useMemo(() => {
    const allItemsFlat = allItems.map(t => t.item);
    return groupByConvoy(allItemsFlat);
  }, [allItems]);

  // Category lookup for rendering
  const categoryByBeadId = useMemo(() => {
    const map = new Map<string, Category>();
    for (const { item, category } of allItems) {
      map.set(item.mrBead.bead_id, category);
    }
    return map;
  }, [allItems]);

  if (totalCount === 0) {
    return (
      <div className="rounded-xl border border-dashed border-white/10 p-6 text-center">
        <CheckCircle2 className="mx-auto mb-2 size-6 text-emerald-500/40" />
        <p className="text-sm text-white/40">All clear — nothing needs your attention</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Convoy groups */}
      <AnimatePresence initial={false}>
        {convoyGroups.map(group => (
          <motion.div
            key={group.convoy.convoy_id}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.25 }}
          >
            <ConvoyGroupCard
              group={group}
              categoryByBeadId={categoryByBeadId}
              townId={townId}
              isAdmin={isAdmin}
            />
          </motion.div>
        ))}
      </AnimatePresence>

      {/* Standalone items (no convoy) */}
      <AnimatePresence initial={false}>
        {standalone.map((item, i) => (
          <motion.div
            key={item.mrBead.bead_id}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ delay: i * 0.04, duration: 0.25 }}
          >
            <AttentionItemCard
              item={item}
              category={categoryByBeadId.get(item.mrBead.bead_id) ?? 'openPR'}
              townId={townId}
              isAdmin={isAdmin}
            />
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

// ── Convoy group card ────────────────────────────────────────────────

function ConvoyGroupCard({
  group,
  categoryByBeadId,
  townId,
  isAdmin,
}: {
  group: ConvoyGroup;
  categoryByBeadId: Map<string, Category>;
  townId: string;
  isAdmin: boolean;
}) {
  const { open: openDrawer } = useDrawerStack();
  const { convoy, items } = group;
  const progress =
    convoy.total_beads > 0 ? `${convoy.closed_beads}/${convoy.total_beads} beads reviewed` : '';

  return (
    <div className="rounded-lg border border-white/[0.06] bg-white/[0.02]">
      {/* Convoy header */}
      <button
        onClick={() => openDrawer({ type: 'convoy', convoyId: convoy.convoy_id, townId })}
        className="flex w-full items-center justify-between px-4 py-3 text-left transition-colors hover:bg-white/[0.03]"
      >
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 rounded px-1.5 py-0.5 text-[9px] font-medium bg-violet-500/15 text-violet-400">
            CONVOY
          </span>
          <span className="min-w-0 truncate text-xs font-medium text-white/70">{convoy.title}</span>
          {convoy.feature_branch && (
            <span className="flex min-w-0 shrink items-center gap-1 text-[9px] text-white/25">
              <GitBranch className="size-2.5 shrink-0" />
              <span className="min-w-0 truncate font-mono">{convoy.feature_branch}</span>
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {convoy.merge_mode && (
            <span className="rounded border border-sky-500/20 bg-sky-500/10 px-1.5 py-0.5 text-[9px] font-medium text-sky-400">
              {convoy.merge_mode}
            </span>
          )}
          <span className="font-mono text-[10px] text-white/30">{progress}</span>
        </div>
      </button>

      {/* Progress bar */}
      {convoy.total_beads > 0 && (
        <div className="mx-4 mb-2 h-1 overflow-hidden rounded-full bg-white/[0.06]">
          <motion.div
            className="h-full rounded-full bg-emerald-500/60"
            initial={{ width: 0 }}
            animate={{
              width: `${(convoy.closed_beads / convoy.total_beads) * 100}%`,
            }}
            transition={{ duration: 0.5, ease: 'easeOut' }}
          />
        </div>
      )}

      {/* Items within convoy */}
      <div className="border-t border-white/[0.04]">
        {items.map((item, i) => (
          <Fragment key={item.mrBead.bead_id}>
            {i > 0 && <div className="mx-4 border-t border-white/[0.04]" />}
            <AttentionItemRow
              item={item}
              category={categoryByBeadId.get(item.mrBead.bead_id) ?? 'openPR'}
              townId={townId}
              isAdmin={isAdmin}
            />
          </Fragment>
        ))}
      </div>
    </div>
  );
}

// ── Standalone attention item card ───────────────────────────────────

function AttentionItemCard({
  item,
  category,
  townId,
  isAdmin,
}: {
  item: MergeQueueItem;
  category: Category;
  townId: string;
  isAdmin: boolean;
}) {
  return (
    <div className="rounded-lg border border-white/[0.06] bg-white/[0.02]">
      <AttentionItemRow item={item} category={category} townId={townId} isAdmin={isAdmin} />
    </div>
  );
}

// ── Shared row component (used inside convoy group and standalone) ───

function AttentionItemRow({
  item,
  category,
  townId,
  isAdmin,
}: {
  item: MergeQueueItem;
  category: Category;
  townId: string;
  isAdmin: boolean;
}) {
  const { open: openDrawer } = useDrawerStack();
  const trpc = useGastownTRPC();
  const queryClient = useQueryClient();
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);

  const style = CATEGORY_STYLES[category];
  const sourceBeadTitle = item.sourceBead?.title ?? item.mrBead.title.replace(/^Review: /, '');
  const rigId = item.mrBead.rig_id ?? '';

  const invalidateMergeQueue = () => {
    void queryClient.invalidateQueries({
      queryKey: trpc.gastown.getMergeQueueData.queryKey({ townId }),
    });
  };

  // Retry review: reset the MR bead status back to 'open' so the refinery re-queues it.
  // updateBead requires a rigId — use the MR bead's rig_id.
  const retryMutation = useMutation(
    trpc.gastown.updateBead.mutationOptions({
      onSuccess: () => {
        setConfirmAction(null);
        invalidateMergeQueue();
        toast.success('Review retry requested');
      },
      onError: (err: { message: string }) => {
        toast.error(`Failed to retry: ${err.message}`);
      },
    })
  );

  // Fail bead mutation: use adminForceFailBead
  const failMutation = useMutation(
    trpc.gastown.adminForceFailBead.mutationOptions({
      onSuccess: () => {
        setConfirmAction(null);
        invalidateMergeQueue();
        toast.success('Bead marked as failed');
      },
      onError: (err: { message: string }) => {
        toast.error(`Failed to update bead: ${err.message}`);
      },
    })
  );

  const isPending = retryMutation.isPending || failMutation.isPending;

  const handleConfirm = () => {
    if (!confirmAction) return;
    if (confirmAction.action === 'retry') {
      retryMutation.mutate({
        rigId,
        beadId: confirmAction.beadId,
        status: 'open',
      });
    } else {
      failMutation.mutate({
        townId,
        beadId: confirmAction.beadId,
      });
    }
  };

  return (
    <>
      <div className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-white/[0.02]">
        {/* Category indicator */}
        <div className="mt-1 shrink-0">
          {category === 'openPR' && <GitMerge className="size-3.5 text-violet-400/60" />}
          {category === 'failed' && <XCircle className="size-3.5 text-red-400/60" />}
          {category === 'stale' && <Clock className="size-3.5 text-amber-400/60" />}
        </div>

        {/* Content */}
        <div className="min-w-0 flex-1">
          {/* Title row */}
          <div className="flex items-center gap-2">
            <span
              className={`inline-flex shrink-0 items-center rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${style.border} ${style.bg} ${style.text}`}
            >
              {style.label}
            </span>
            <button
              onClick={() => {
                if (item.sourceBead) {
                  openDrawer({
                    type: 'bead',
                    beadId: item.sourceBead.bead_id,
                    rigId,
                  });
                }
              }}
              className="min-w-0 truncate text-sm text-white/75 transition-colors hover:text-white/90"
              title={sourceBeadTitle}
            >
              {sourceBeadTitle}
            </button>
          </div>

          {/* Metadata row */}
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-white/30">
            {item.rigName && <span>{item.rigName}</span>}
            {item.agent && <span>{item.agent.name}</span>}
            <span>
              {formatDistanceToNow(new Date(item.mrBead.created_at), {
                addSuffix: true,
              })}
            </span>
            {item.reviewMetadata.retry_count > 0 && (
              <span className="text-amber-400/60">
                {item.reviewMetadata.retry_count}{' '}
                {item.reviewMetadata.retry_count === 1 ? 'retry' : 'retries'}
              </span>
            )}
            {category === 'stale' && item.staleSince && (
              <span className="text-amber-400/60">
                stale since{' '}
                {formatDistanceToNow(new Date(item.staleSince), {
                  addSuffix: true,
                })}
              </span>
            )}
            {category === 'failed' && item.failureReason && (
              <span className="max-w-xs truncate text-red-400/60">{item.failureReason}</span>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="flex shrink-0 items-center gap-1">
          {item.reviewMetadata.pr_url && (
            <a
              href={item.reviewMetadata.pr_url}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-md p-1.5 text-white/30 transition-colors hover:bg-white/[0.06] hover:text-white/60"
              title="Open PR"
            >
              <ExternalLink className="size-3.5" />
            </a>
          )}
          {category === 'failed' && (
            <button
              onClick={() =>
                setConfirmAction({
                  beadId: item.mrBead.bead_id,
                  title: sourceBeadTitle,
                  action: 'retry',
                })
              }
              className="rounded-md p-1.5 text-white/30 transition-colors hover:bg-white/[0.06] hover:text-white/60"
              title="Retry Review"
            >
              <RefreshCw className="size-3.5" />
            </button>
          )}
          <button
            onClick={() => {
              if (item.sourceBead) {
                openDrawer({
                  type: 'bead',
                  beadId: item.sourceBead.bead_id,
                  rigId,
                });
              }
            }}
            className="rounded-md p-1.5 text-white/30 transition-colors hover:bg-white/[0.06] hover:text-white/60"
            title="View Bead"
          >
            <Eye className="size-3.5" />
          </button>
          {isAdmin && (
            <button
              onClick={() =>
                setConfirmAction({
                  beadId: item.mrBead.bead_id,
                  title: sourceBeadTitle,
                  action: 'fail',
                })
              }
              className="rounded-md p-1.5 text-white/30 transition-colors hover:bg-red-500/10 hover:text-red-400"
              title="Fail Bead"
            >
              <AlertTriangle className="size-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Confirmation dialog for retry or fail */}
      <Dialog open={!!confirmAction} onOpenChange={() => setConfirmAction(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirmAction?.action === 'retry' ? 'Retry Review' : 'Fail Bead'}
            </DialogTitle>
            <DialogDescription>
              {confirmAction?.action === 'retry' ? (
                <>
                  Re-queue <span className="font-semibold">{confirmAction.title}</span> for review?
                  This resets the MR bead so the refinery picks it up again.
                </>
              ) : (
                <>
                  Mark <span className="font-semibold">{confirmAction?.title}</span> as failed? This
                  stops the review process for this bead.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmAction(null)} disabled={isPending}>
              Cancel
            </Button>
            <Button
              variant={confirmAction?.action === 'fail' ? 'destructive' : 'default'}
              onClick={handleConfirm}
              disabled={isPending}
            >
              {isPending
                ? confirmAction?.action === 'retry'
                  ? 'Retrying…'
                  : 'Failing…'
                : confirmAction?.action === 'retry'
                  ? 'Retry Review'
                  : 'Fail Bead'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
