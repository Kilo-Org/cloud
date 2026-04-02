'use client';

import { formatDistanceToNow } from 'date-fns';
import { motion } from 'motion/react';
import { Bot } from 'lucide-react';
import { Sparkline } from './Sparkline';

type TownCardProps = {
  name: string;
  beadCounts: {
    open: number;
    in_progress: number;
    in_review: number;
    closed: number;
    failed: number;
  };
  lastActivityAt: string | null;
  activitySparkline: number[];
  activeAgents: number;
  index: number;
  onClick: () => void;
};

const pillStyles = {
  open: 'bg-blue-500/15 text-blue-300',
  in_progress: 'bg-amber-500/15 text-amber-300',
  in_review: 'bg-purple-500/15 text-purple-300',
  closed: 'bg-emerald-500/15 text-emerald-300',
} as const;

export function TownCard({
  name,
  beadCounts,
  lastActivityAt,
  activitySparkline,
  activeAgents,
  index,
  onClick,
}: TownCardProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, delay: index * 0.04 }}
      onClick={onClick}
      className="group cursor-pointer rounded-xl border border-white/[0.06] bg-white/[0.03] px-5 py-3.5 transition-[border-color,background-color] hover:border-white/[0.12] hover:bg-white/[0.05]"
    >
      {/* Row 1: name + sparkline */}
      <div className="flex items-center justify-between gap-4">
        <h3 className="min-w-0 truncate text-[15px] font-semibold text-white/90">{name}</h3>
        <div className="flex-shrink-0 opacity-60 transition-opacity group-hover:opacity-100">
          <Sparkline data={activitySparkline} width={100} height={22} />
        </div>
      </div>

      {/* Row 2: last activity + agents (left) / bead pills (right) */}
      <div className="mt-1.5 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 text-xs text-white/40">
          {lastActivityAt ? (
            <span>Active {formatDistanceToNow(new Date(lastActivityAt), { addSuffix: true })}</span>
          ) : (
            <span>No activity</span>
          )}
          {activeAgents > 0 && (
            <span className="inline-flex items-center gap-1 text-white/50">
              <Bot className="size-3.5" />
              {activeAgents}
            </span>
          )}
        </div>

        <div className="flex flex-wrap justify-end gap-1.5">
          {beadCounts.open > 0 && (
            <span className={`rounded-md px-2 py-0.5 text-xs font-medium ${pillStyles.open}`}>
              {beadCounts.open} open
            </span>
          )}
          {beadCounts.in_progress > 0 && (
            <span
              className={`rounded-md px-2 py-0.5 text-xs font-medium ${pillStyles.in_progress}`}
            >
              {beadCounts.in_progress} in progress
            </span>
          )}
          {beadCounts.in_review > 0 && (
            <span className={`rounded-md px-2 py-0.5 text-xs font-medium ${pillStyles.in_review}`}>
              {beadCounts.in_review} review
            </span>
          )}
          {beadCounts.closed > 0 && (
            <span className={`rounded-md px-2 py-0.5 text-xs font-medium ${pillStyles.closed}`}>
              {beadCounts.closed} closed
            </span>
          )}
        </div>
      </div>
    </motion.div>
  );
}
