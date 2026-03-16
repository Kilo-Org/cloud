/**
 * Dashboard context store — shared between control-server and plugin
 * via a JSON file on disk.
 *
 * The control-server (Bun process) writes snapshots when the TownDO
 * pushes context. The plugin (kilo serve process) reads the file on
 * each LLM call. Both processes share the container filesystem so
 * this is a cheap local read with no network round-trip.
 *
 * A capped ring buffer of the most recent snapshots prevents unbounded
 * growth.
 */

import { writeFileSync, readFileSync, renameSync } from 'node:fs';
import { z } from 'zod';

const ContextSnapshotSchema = z.object({
  context: z.string(),
  receivedAt: z.number(),
});

type ContextSnapshot = z.infer<typeof ContextSnapshotSchema>;

/** Max snapshots retained. Oldest are evicted when this is exceeded. */
const MAX_SNAPSHOTS = 5;

/** Well-known path both processes agree on. */
const CONTEXT_FILE = '/tmp/gastown-dashboard-context.json';
const CONTEXT_FILE_TMP = '/tmp/gastown-dashboard-context.json.tmp';

// ── Writer (control-server process) ──────────────────────────────────

/** Called by the control-server when the TownDO pushes a new snapshot. */
export function pushContext(context: string): void {
  const existing = readSnapshots();
  existing.push({ context, receivedAt: Date.now() });
  if (existing.length > MAX_SNAPSHOTS) {
    existing.splice(0, existing.length - MAX_SNAPSHOTS);
  }
  try {
    // Write to a temp file then atomically rename to avoid the plugin
    // reading truncated JSON during a concurrent readFileSync.
    writeFileSync(CONTEXT_FILE_TMP, JSON.stringify(existing));
    renameSync(CONTEXT_FILE_TMP, CONTEXT_FILE);
  } catch {
    // Best-effort — don't crash the control-server
  }
}

// ── Reader (plugin process) ──────────────────────────────────────────

/**
 * Build a combined context block from all retained snapshots.
 * Returns null if no context has been pushed.
 */
export function buildContextBlock(): string | null {
  const snapshots = readSnapshots();
  if (snapshots.length === 0) return null;

  const latest = snapshots[snapshots.length - 1];
  if (snapshots.length === 1) return latest.context;

  const breadcrumbs = snapshots
    .slice(0, -1)
    .map(s => {
      const pageMatch = s.context.match(/page="([^"]+)"/);
      const page = pageMatch ? pageMatch[1] : 'unknown';
      const ago = formatAgo(s.receivedAt);
      return `  - ${ago}: was viewing ${page}`;
    })
    .join('\n');

  return [latest.context, '<navigation-history>', breadcrumbs, '</navigation-history>'].join('\n');
}

// ── Shared helpers ───────────────────────────────────────────────────

function readSnapshots(): ContextSnapshot[] {
  try {
    const raw = readFileSync(CONTEXT_FILE, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    return z.array(ContextSnapshotSchema).parse(parsed);
  } catch {
    return [];
  }
}

function formatAgo(epochMs: number): string {
  const diff = Date.now() - epochMs;
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3600_000) return `${Math.round(diff / 60_000)}m ago`;
  return `${Math.round(diff / 3600_000)}h ago`;
}
