/**
 * Admin-console timestamps: local time for reading, the exact ISO string in a
 * `title` tooltip for copying, and a coarse relative age for scanning a list
 * ("3 min ago"). Pure so the same formatting serves the runs list and the
 * failed-models table.
 */
export type AdminTime = {
  /** Local date and time, e.g. "Nov 20, 14:32". */
  local: string;
  /** Exactly what the worker sent, for a `title` tooltip. */
  iso: string;
  /** Coarse age in words, or null when the value is not a date. */
  relative: string | null;
};

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

export function formatAdminTime(iso: string, now: number = Date.now()): AdminTime {
  const date = new Date(iso);
  const ms = date.getTime();
  if (Number.isNaN(ms)) return { local: iso, iso, relative: null };
  return {
    local: date.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }),
    iso,
    relative: relativeAge(ms, now),
  };
}

export function relativeAge(timestampMs: number, now: number = Date.now()): string {
  const age = now - timestampMs;
  const ahead = age < 0;
  const magnitude = Math.abs(age);
  const [value, unit] =
    magnitude < MINUTE_MS
      ? [0, 'min']
      : magnitude < HOUR_MS
        ? [Math.floor(magnitude / MINUTE_MS), 'min']
        : magnitude < DAY_MS
          ? [Math.floor(magnitude / HOUR_MS), 'h']
          : magnitude < WEEK_MS
            ? [Math.floor(magnitude / DAY_MS), 'd']
            : [Math.floor(magnitude / WEEK_MS), 'w'];
  if (unit === 'min' && value === 0) return 'just now';
  return ahead ? `in ${value} ${unit}` : `${value} ${unit} ago`;
}

/** "Model vendor/x" for a run that enqueued it — the one-lookup answer to "did it run". */
export function runMentionsModel(run: { models?: string[] }, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return true;
  return (run.models ?? []).some(model => model.toLowerCase().includes(needle));
}

export function entryMentionsModel(entry: { model: string }, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return true;
  return entry.model.toLowerCase().includes(needle);
}
