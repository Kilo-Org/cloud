'use client';

import { useState, useEffect } from 'react';
import { formatDistanceToNow } from 'date-fns';

const ONE_MINUTE = 60_000;
const ONE_HOUR = 60 * ONE_MINUTE;
const ONE_DAY = 24 * ONE_HOUR;
const ONE_WEEK = 7 * ONE_DAY;

function formatCompact(ms: number): string {
  const age = Date.now() - ms;
  if (age < ONE_MINUTE) return 'now';
  if (age < ONE_HOUR) return `${Math.floor(age / ONE_MINUTE)}m`;
  if (age < ONE_DAY) return `${Math.floor(age / ONE_HOUR)}h`;
  if (age < ONE_WEEK) return `${Math.floor(age / ONE_DAY)}d`;
  return `${Math.floor(age / ONE_WEEK)}w`;
}

/**
 * Choose a refresh interval based on how old the timestamp is:
 * - < 1 hour:  refresh every 30s  (keeps "X minutes ago" accurate)
 * - 1–24 hours: refresh every 5 min
 * - > 24 hours: refresh every 1 hour
 */
function refreshInterval(timestampMs: number): number {
  const age = Date.now() - timestampMs;
  if (age < ONE_HOUR) return 30_000;
  if (age < ONE_DAY) return 5 * ONE_MINUTE;
  return ONE_HOUR;
}

function useTimeAgo(timestamp: number | string, compact?: boolean): string {
  const ms = typeof timestamp === 'string' ? new Date(timestamp).getTime() : timestamp;

  const format = compact
    ? () => formatCompact(ms)
    : () => formatDistanceToNow(new Date(ms), { addSuffix: true });

  const [text, setText] = useState(format);

  useEffect(() => {
    // Recompute immediately in case the initial render was cached / stale
    setText(format());

    let timer: ReturnType<typeof setTimeout>;

    function tick() {
      setText(format());
      // Schedule next tick with an interval appropriate for the current age
      timer = setTimeout(tick, refreshInterval(ms));
    }

    timer = setTimeout(tick, refreshInterval(ms));
    return () => clearTimeout(timer);
  }, [ms, compact]);

  return text;
}

/**
 * Self-updating relative-time label.
 * Refreshes on an adaptive schedule so even memoised parents stay accurate.
 */
export function TimeAgo({
  timestamp,
  className,
  compact,
}: {
  timestamp: number | string;
  className?: string;
  compact?: boolean;
}) {
  const text = useTimeAgo(timestamp, compact);
  // Server and client compute formatDistanceToNow at different wall-clock
  // times, so a minor mismatch is expected and harmless.
  return (
    <span className={className} suppressHydrationWarning>
      {text}
    </span>
  );
}
