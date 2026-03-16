/**
 * In-memory store for dashboard context pushed from the TownDO.
 *
 * The TownDO pushes a context snapshot (XML string describing the user's
 * current page, open drawer, and recent navigation) whenever the
 * dashboard navigates. The plugin reads the latest snapshot on each LLM
 * call to inject it into the system prompt — no network round-trip.
 *
 * A capped ring buffer of the most recent snapshots is kept so the mayor
 * can see a short history of user activity without unbounded growth.
 */

type ContextSnapshot = {
  context: string;
  receivedAt: number;
};

/** Max snapshots retained. Oldest are evicted when this is exceeded. */
const MAX_SNAPSHOTS = 5;

const snapshots: ContextSnapshot[] = [];

/** Called by the control-server when the TownDO pushes a new snapshot. */
export function pushContext(context: string): void {
  snapshots.push({ context, receivedAt: Date.now() });
  if (snapshots.length > MAX_SNAPSHOTS) {
    snapshots.splice(0, snapshots.length - MAX_SNAPSHOTS);
  }
}

/**
 * Return the latest snapshot's context string, or null if nothing has
 * been pushed yet.
 */
export function getLatestContext(): string | null {
  if (snapshots.length === 0) return null;
  return snapshots[snapshots.length - 1].context;
}

/**
 * Build a combined context block from all retained snapshots.
 * The most recent entry is labelled "current"; older entries provide a
 * brief breadcrumb trail of recent user activity.
 *
 * Returns null if no context has been pushed.
 */
export function buildContextBlock(): string | null {
  if (snapshots.length === 0) return null;

  // Only the latest snapshot gets the full XML. Older ones are
  // summarised as one-line breadcrumbs to keep token cost low.
  const latest = snapshots[snapshots.length - 1];
  if (snapshots.length === 1) return latest.context;

  const breadcrumbs = snapshots
    .slice(0, -1)
    .map(s => {
      // Extract just the page attribute from <current-view page="..." />
      const pageMatch = s.context.match(/page="([^"]+)"/);
      const page = pageMatch ? pageMatch[1] : 'unknown';
      const ago = formatAgo(s.receivedAt);
      return `  - ${ago}: was viewing ${page}`;
    })
    .join('\n');

  return [latest.context, '<navigation-history>', breadcrumbs, '</navigation-history>'].join('\n');
}

function formatAgo(epochMs: number): string {
  const diff = Date.now() - epochMs;
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3600_000) return `${Math.round(diff / 60_000)}m ago`;
  return `${Math.round(diff / 3600_000)}h ago`;
}
