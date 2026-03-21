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
import { extractPrUrl } from '@/components/gastown/ActivityFeed';

type TownEvent = GastownOutputs['gastown']['getTownEvents'][number];

// Refinery-related event types we display in the activity log
const REFINERY_EVENT_TYPES = new Set([
  'review_submitted',
  'review_completed',
  'pr_created',
  'pr_creation_failed',
  'rework_requested',
]);

type ActionType =
  | 'merged'
  | 'failed'
  | 'pr_created'
  | 'pr_creation_failed'
  | 'rework_requested'
  | 'review_submitted';

function resolveActionType(event: TownEvent): ActionType {
  if (event.event_type === 'review_completed') {
    return event.new_value === 'merged' ? 'merged' : 'failed';
  }
  return event.event_type as ActionType;
}

const ACTION_CONFIG: Record<
  ActionType,
  {
    icon: typeof GitMerge;
    dotColor: string;
    lineColor: string;
    label: string;
  }
> = {
  merged: {
    icon: GitMerge,
    dotColor: 'bg-emerald-400',
    lineColor: 'border-emerald-500/30',
    label: 'Merged',
  },
  failed: {
    icon: XCircle,
    dotColor: 'bg-red-400',
    lineColor: 'border-red-500/30',
    label: 'Failed',
  },
  pr_created: {
    icon: GitPullRequest,
    dotColor: 'bg-sky-400',
    lineColor: 'border-sky-500/30',
    label: 'PR Created',
  },
  pr_creation_failed: {
    icon: AlertTriangle,
    dotColor: 'bg-red-400',
    lineColor: 'border-red-500/30',
    label: 'PR Failed',
  },
  rework_requested: {
    icon: RotateCcw,
    dotColor: 'bg-amber-400',
    lineColor: 'border-amber-500/30',
    label: 'Rework',
  },
  review_submitted: {
    icon: Send,
    dotColor: 'bg-indigo-400',
    lineColor: 'border-indigo-500/30',
    label: 'Submitted',
  },
};

function extractAgentName(event: TownEvent): string {
  const meta = event.metadata;
  if (typeof meta.agent_name === 'string') return meta.agent_name;
  if (typeof meta.completedBy === 'string') return meta.completedBy;
  return 'an agent';
}

function extractBeadTitle(event: TownEvent): string {
  const meta = event.metadata;
  if (typeof meta.title === 'string') return meta.title;
  if (typeof meta.bead_title === 'string') return meta.bead_title;
  // Fall back to new_value for review_submitted which stores the branch
  return event.new_value ?? 'untitled bead';
}

function extractBranch(event: TownEvent): string | null {
  const meta = event.metadata;
  if (typeof meta.branch === 'string') return meta.branch;
  if (typeof meta.target_branch === 'string') return meta.target_branch;
  // review_submitted stores branch in new_value
  if (event.event_type === 'review_submitted' && typeof event.new_value === 'string') {
    return event.new_value;
  }
  return null;
}

function extractCommitSha(event: TownEvent): string | null {
  const meta = event.metadata;
  if (typeof meta.commit_sha === 'string') return meta.commit_sha;
  return null;
}

function extractPrNumber(prUrl: string | null): string | null {
  if (!prUrl) return null;
  const match = /\/pull\/(\d+)/.exec(prUrl);
  return match ? match[1] : null;
}

function extractRetryCount(event: TownEvent): number {
  const meta = event.metadata;
  if (typeof meta.retry_count === 'number') return meta.retry_count;
  return 0;
}

function extractConvoyInfo(event: TownEvent): {
  convoyTitle: string;
  convoyId?: string;
  progress?: string;
} | null {
  const meta = event.metadata;
  if (typeof meta.convoy_title === 'string') {
    return {
      convoyTitle: meta.convoy_title,
      convoyId: typeof meta.convoy_id === 'string' ? meta.convoy_id : undefined,
      progress: typeof meta.convoy_progress === 'string' ? meta.convoy_progress : undefined,
    };
  }
  return null;
}

function extractMessage(event: TownEvent): string | null {
  const meta = event.metadata;
  if (typeof meta.message === 'string') return meta.message;
  if (typeof meta.feedback === 'string') return meta.feedback;
  if (typeof meta.reason === 'string') return meta.reason;
  return null;
}

/** Build the main natural-language description line for an event. */
function buildDescription(event: TownEvent): {
  prefix: string;
  beadTitle: string;
  suffix: string;
} {
  const action = resolveActionType(event);
  const agentName = extractAgentName(event);
  const beadTitle = extractBeadTitle(event);
  const branch = extractBranch(event);

  const branchSuffix = branch ? (branch === 'main' ? ' into main' : ` into ${branch}`) : '';

  switch (action) {
    case 'merged':
      return {
        prefix: `Refinery merged ${agentName}\u2019s `,
        beadTitle: `\u201c${beadTitle}\u201d`,
        suffix: branchSuffix,
      };
    case 'failed':
      return {
        prefix: `Refinery review failed for ${agentName}\u2019s `,
        beadTitle: `\u201c${beadTitle}\u201d`,
        suffix: '',
      };
    case 'pr_created': {
      const prUrl = extractPrUrl(event.metadata);
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
  events,
  isLoading,
}: {
  events: TownEvent[] | undefined;
  isLoading: boolean;
}) {
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  const refineryEvents = (events ?? [])
    .filter(e => REFINERY_EVENT_TYPES.has(e.event_type))
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

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

  if (refineryEvents.length === 0) {
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

  const visible = refineryEvents.slice(0, visibleCount);
  const hasMore = visibleCount < refineryEvents.length;

  return (
    <div className="px-6 py-4">
      <AnimatePresence initial={false}>
        {visible.map((event, i) => (
          <ActivityLogEntry
            key={event.bead_event_id}
            event={event}
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
            {refineryEvents.length - visibleCount} remaining
          </span>
        </button>
      )}
    </div>
  );
}

function ActivityLogEntry({
  event,
  isLast,
  delay,
}: {
  event: TownEvent;
  isLast: boolean;
  delay: number;
}) {
  const { open } = useDrawerStack();
  const action = resolveActionType(event);
  const config = ACTION_CONFIG[action];
  const Icon = config.icon;
  const description = buildDescription(event);
  const message = extractMessage(event);
  const commitSha = extractCommitSha(event);
  const prUrl = extractPrUrl(event.metadata);
  const prNumber = extractPrNumber(prUrl);
  const retryCount = extractRetryCount(event);
  const convoyInfo = extractConvoyInfo(event);
  const rigId = event.rig_id;
  const rigName = event.rig_name ?? (rigId ? `Rig ${rigId.slice(0, 6)}` : null);

  function handleBeadClick() {
    if (event.bead_id && rigId) {
      open({ type: 'bead', beadId: event.bead_id, rigId });
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
          <span>{formatDistanceToNow(new Date(event.created_at), { addSuffix: true })}</span>
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
          {retryCount > 0 && (
            <span>
              {retryCount} {retryCount === 1 ? 'retry' : 'retries'}
            </span>
          )}
          {convoyInfo && (
            <span>
              {convoyInfo.progress
                ? `Intermediate merge \u2014 ${convoyInfo.progress}`
                : `convoy: ${convoyInfo.convoyTitle}`}
            </span>
          )}
        </div>
      </div>
    </motion.div>
  );
}
