/**
 * Collector for headless cloud-agent session diagnostics.
 *
 * The collected diagnostic lines stay within fixed limits: a maximum count,
 * a maximum length per line, and a maximum total length. When a limit is
 * reached the oldest lines are removed first, so the most recent lines are
 * the ones retained.
 */

export const STATUS_LOG_MAX_ENTRIES = 200;
export const STATUS_LOG_MAX_LINE_LENGTH = 300;
export const STATUS_LOG_MAX_TOTAL_LENGTH = 8000;

const TRUNCATION_MARKER = '…';

export type BoundedStatusLog = {
  /** Append one diagnostic line, dropping the oldest kept entries when the budget is exceeded. */
  push(line: string): void;
  /** Kept lines, oldest first. */
  entries(): readonly string[];
  /** Number of lines dropped (never counted as kept). */
  droppedCount(): number;
};

function truncateLine(line: string): string {
  if (line.length <= STATUS_LOG_MAX_LINE_LENGTH) return line;
  return line.slice(0, STATUS_LOG_MAX_LINE_LENGTH - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
}

export function createBoundedStatusLog(): BoundedStatusLog {
  const kept: string[] = [];
  let totalLength = 0;
  let dropped = 0;

  return {
    push(line: string): void {
      const trimmed = line.trim();
      if (trimmed.length === 0) return;

      const stored = truncateLine(trimmed);
      kept.push(stored);
      totalLength += stored.length;

      while (
        kept.length > STATUS_LOG_MAX_ENTRIES ||
        (kept.length > 1 && totalLength > STATUS_LOG_MAX_TOTAL_LENGTH)
      ) {
        const removed = kept.shift();
        if (removed === undefined) break;
        totalLength -= removed.length;
        dropped += 1;
      }
    },
    entries(): readonly string[] {
      return kept;
    },
    droppedCount(): number {
      return dropped;
    },
  };
}
