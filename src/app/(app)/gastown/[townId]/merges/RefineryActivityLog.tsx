'use client';

import { useState } from 'react';
import { formatDistanceToNow } from 'date-fns';
import {
  GitMerge,
  GitPullRequest,
  AlertTriangle,
  RotateCcw,
  Send,
  XCircle,
  Activity,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { useDrawerStack } from '@/components/gastown/DrawerStack';
import type { GastownOutputs } from '@/lib/gastown/trpc';

type MergeQueueData = GastownOutputs['gastown']['getMergeQueueData'];
type ActivityLogEntry = MergeQueueData['activityLog'][number];

type ActionType =
  | 'merged'
  | 'failed'
  | 'pr_created'
  | 'pr_creation_failed'
  | 'rework_requested'
  | 'review_submitted';

function resolveActionType(entry: ActivityLogEntry): ActionType {
  const eventType = entry.event.event_type;
  if (eventType === 'review_completed') {
    return entry.event.new_value === 'merged' ? 'merged' : 'failed';
  }
  return eventType as ActionType;
}

const ACTION_CONFIG: Record<
  ActionType,
  {
    icon: typeof GitMerge;
    dotColor: string;
    lineColor: string;
  }
> = {
  merged: {
    icon: GitMerge,
    dotColor: 'bg-emerald-400',
    lineColor: 'border-emerald-500/30',
  },
  failed: {
    icon: XCircle,
    dotColor: 'bg-red-400',
    lineColor: 'border-red-500/30',
  },
  pr_created: {
    icon: GitPullRequest,
    dotColor: 'bg-sky-400',
    lineColor: 'border-sky-500/30',
  },
  pr_creation_failed: {
    icon: AlertTriangle,
    dotColor: 'bg-red-400',
    lineColor: 'border-red-500/30',
  },
  rework_requested: {
    icon: RotateCcw,
    dotColor: 'bg-amber-400',
    lineColor: 'border-amber-500/30',
  },
  review_submitted: {
    icon: Send,
    dotColor: 'bg-indigo-400',
    lineColor: 'border-indigo-500/30',
  },
};

function extractPrNumber(prUrl: string | null): string | null {
  if (!prUrl) return null;
  const match = /\/pull\/(\d+)/.exec(prUrl);
  return match ? match[1] : null;
}

function extractMessage(entry: ActivityLogEntry): string | null {
  const meta = entry.event.metadata;
  if (typeof meta.message === 'string') return meta.message;
  if (typeof meta.feedback === 'string') return meta.feedback;
  if (typeof meta.reason === 'string') return meta.reason;
  return null;
}

/** Build the main natural-language description line for an activity log entry. */
function buildDescription(entry: ActivityLogEntry): {
  prefix: string;
  beadTitle: string;
  suffix: string;
} {
  const action = resolveActionType(entry);
  const agentName = entry.agent?.name ?? 'an agent';
  const beadTitle = entry.sourceBead?.title ?? entry.mrBead?.title ?? 'untitled bead';
  const targetBranch = entry.reviewMetadata?.target_branch;

  const branchSuffix = targetBranch
    ? targetBranch === 'main'
      ? ' into main'
      : ` into ${targetBranch}`
    : '';

  // Add convoy context to branch suffix
  const convoySuffix = entry.convoy && branchSuffix ? ` (convoy: ${entry.convoy.title})` : '';

  switch (action) {
    case 'merged':
      return {
        prefix: `Refinery merged ${agentName}\u2019s `,
        beadTitle: `\u201c${beadTitle}\u201d`,
        suffix: `${branchSuffix}${convoySuffix}`,
      };
    case 'failed':
      return {
        prefix: `Refinery review failed for ${agentName}\u2019s `,
        beadTitle: `\u201c${beadTitle}\u201d`,
        suffix: '',
      };
    case 'pr_created': {
      const prUrl = entry.reviewMetadata?.pr_url ?? null;
      const prNum = extractPrNumber(prUrl);
      const prLabel = prNum ? `PR #${prNum}` : 'a PR';
      return {
        prefix: `Refinery created ${prLabel} for ${agentName}\u2019s `,
        beadTitle: `\u201c${beadTitle}\u201d`,
        suffix: '',
      };
    }
    case 'pr_creation_failed':
      return {
        prefix: `Refinery failed to create PR for ${agentName}\u2019s `,
        beadTitle: `\u201c${beadTitle}\u201d`,
        suffix: '',
      };
    case 'rework_requested':
      return {
        prefix: `Refinery requested changes from ${agentName} on `,
        beadTitle: `\u201c${beadTitle}\u201d`,
        suffix: '',
      };
    case 'review_submitted':
      return {
        prefix: `${agentName} submitted `,
        beadTitle: `\u201c${beadTitle}\u201d`,
        suffix: ' for review',
      };
  }
}

const PAGE_SIZE = 20;

export function RefineryActivityLog({
  activityLog,
  isLoading,
}: {
  activityLog: ActivityLogEntry[] | undefined;
  isLoading: boolean;
}) {
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  const entries = activityLog ?? [];

  if (isLoading) {
    return (
      <div className="space-y-4 px-6 py-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <motion.div
            key={i}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: i * 0.06 }}
            className="flex gap-4"
          >
            <div className="flex flex-col items-center">
              <div className="size-2.5 rounded-full bg-white/[0.08]" />
              <div className="mt-1 h-12 w-px bg-white/[0.04]" />
            </div>
            <div className="flex-1 space-y-1.5">
              <div className="h-3 w-32 rounded bg-white/[0.04]" />
              <div className="h-4 w-64 rounded bg-white/[0.06]" />
              <div className="h-3 w-48 rounded bg-white/[0.03]" />
            </div>
          </motion.div>
        ))}
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex flex-col items-center justify-center py-12 text-center"
      >
        <Activity className="mb-3 size-8 text-white/10" />
        <p className="text-sm text-white/30">No refinery activity yet</p>
        <p className="mt-1 text-xs text-white/20">
          Merge reviews, PR creations, and rework requests will appear here.
        </p>
      </motion.div>
    );
  }

  const visible = entries.slice(0, visibleCount);
  const hasMore = visibleCount < entries.length;

  return (
    <div className="px-6 py-4">
      <AnimatePresence initial={false}>
        {visible.map((entry, i) => (
          <TimelineEntry
            key={entry.event.bead_event_id}
            entry={entry}
            isLast={i === visible.length - 1 && !hasMore}
            delay={i * 0.03}
          />
        ))}
      </AnimatePresence>
      {hasMore && (
        <button
          onClick={() => setVisibleCount(c => c + PAGE_SIZE)}
          className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg py-2 text-xs text-white/35 transition-colors hover:bg-white/[0.04] hover:text-white/55"
        >
          Show more
          <span className="font-mono text-[10px] text-white/20">
            {entries.length - visibleCount} remaining
          </span>
        </button>
      )}
    </div>
  );
}

function TimelineEntry({
  entry,
  isLast,
  delay,
}: {
  entry: ActivityLogEntry;
  isLast: boolean;
  delay: number;
}) {
  const { open } = useDrawerStack();
  const action = resolveActionType(entry);
  const config = ACTION_CONFIG[action];
  const Icon = config.icon;
  const description = buildDescription(entry);
  const message = extractMessage(entry);
  const commitSha = entry.reviewMetadata?.merge_commit ?? null;
  const prUrl = entry.reviewMetadata?.pr_url ?? null;
  const prNumber = extractPrNumber(prUrl);
  const rigName = entry.rigName;
  const rigId = entry.mrBead?.rig_id;
  const convoy = entry.convoy;

  function handleBeadClick() {
    // Open the source bead if available, falling back to MR bead
    const beadId = entry.sourceBead?.bead_id ?? entry.mrBead?.bead_id;
    if (beadId && rigId) {
      open({ type: 'bead', beadId, rigId });
    }
  }

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.25, delay, ease: [0.25, 0.1, 0.25, 1] }}
      className="flex gap-4"
    >
      {/* Timeline indicator */}
      <div className="flex flex-col items-center pt-1">
        <div className={`size-2.5 shrink-0 rounded-full ${config.dotColor}`} />
        {!isLast && (
          <div className={`mt-1 min-h-[2rem] w-px flex-1 border-l ${config.lineColor}`} />
        )}
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1 pb-5">
        {/* Rig name + timestamp header */}
        <div className="flex items-center gap-2 text-[11px] text-white/30">
          {rigName && <span>{rigName}</span>}
          {rigName && <span className="text-white/15">&middot;</span>}
          <span>{formatDistanceToNow(new Date(entry.event.created_at), { addSuffix: true })}</span>
          <Icon className="ml-auto size-3 text-white/15" />
        </div>

        {/* Main description */}
        <p className="mt-1 text-sm leading-relaxed text-white/75">
          {description.prefix}
          <button
            onClick={handleBeadClick}
            className="text-white/90 underline decoration-white/20 underline-offset-2 transition-colors hover:text-white hover:decoration-white/40"
          >
            {description.beadTitle}
          </button>
          {description.suffix}
        </p>

        {/* Reason/message line */}
        {message && (
          <p className="mt-1 text-xs leading-relaxed text-white/40">
            {action === 'rework_requested' ? 'Reason: ' : ''}
            {message}
          </p>
        )}

        {/* Metadata line */}
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-white/25">
          {commitSha && <span className="font-mono">Commit {commitSha.slice(0, 7)}</span>}
          {prUrl && prNumber && (
            <a
              href={prUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sky-400/60 transition-colors hover:text-sky-400/90"
            >
              PR #{prNumber}
            </a>
          )}
          {prUrl && !prNumber && (
            <a
              href={prUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sky-400/60 transition-colors hover:text-sky-400/90"
            >
              View PR
            </a>
          )}
          {convoy && (
            <span>
              {convoy.closed_beads > 0 && convoy.closed_beads < convoy.total_beads
                ? `Intermediate merge \u2014 ${convoy.closed_beads}/${convoy.total_beads} convoy beads reviewed`
                : `convoy: ${convoy.title}`}
            </span>
          )}
        </div>
      </div>
    </motion.div>
  );
}
