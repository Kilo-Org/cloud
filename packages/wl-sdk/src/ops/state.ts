/**
 * Internal helpers for reading wanted-row state at a specific ref.
 *
 * Used by every PR-mode mutation op for the idempotency check
 * ("does the branch already represent the target state?") and for
 * auto-cleanup ("does the branch's row match upstream's main row?").
 *
 * Mirrors `QueryItemStatus` and `queryItemBranchState` in
 * `wasteland/internal/commons/queries.go`.
 */

import { z } from 'zod';
import { doltRead } from '../dolthub/read';
import { WantedRowSchema, type WantedRow } from '../commons/schema.generated';
import { escapeSqlString } from '../commons/escape';
import type { DoltHubAuth, DoltFetchHooks } from '../dolthub/api';
import { WlError } from './types';
import { WlDoltHubError } from '../dolthub/api';

const StatusRow = z.object({ status: z.string().nullable() }).passthrough();

/** Read just the `status` field for a wanted row at a ref. */
export async function readWantedStatusAt(opts: {
  auth: DoltHubAuth;
  /** The repo to read from — fork for branch reads, upstream for main. */
  owner: string;
  db: string;
  ref?: string;
  wantedId: string;
  fetch?: typeof fetch;
  hooks?: DoltFetchHooks;
}): Promise<string | null> {
  const sql = `SELECT status FROM wanted WHERE id = '${escapeSqlString(opts.wantedId)}' LIMIT 1`;
  try {
    const res = await doltRead({
      auth: opts.auth,
      owner: opts.owner,
      db: opts.db,
      ref: opts.ref,
      query: sql,
      fetch: opts.fetch,
      hooks: opts.hooks,
    });
    if (res.rows.length === 0) return null;
    const parsed = StatusRow.safeParse(res.rows[0]);
    if (!parsed.success) return null;
    return parsed.data.status ?? null;
  } catch (err) {
    // Treat 404s on a not-yet-created branch as "no row": the branch
    // simply doesn't exist on the fork yet. Other errors propagate.
    if (err instanceof WlDoltHubError && err.status === 404) return null;
    throw new WlError(`Read wanted status at ${opts.ref ?? 'main'} failed`, 'upstream', err);
  }
}

/** Read the full wanted row at a ref. Returns `null` when the row isn't present. */
export async function readWantedRowAt(opts: {
  auth: DoltHubAuth;
  owner: string;
  db: string;
  ref?: string;
  wantedId: string;
  fetch?: typeof fetch;
  hooks?: DoltFetchHooks;
}): Promise<WantedRow | null> {
  const sql = `SELECT * FROM wanted WHERE id = '${escapeSqlString(opts.wantedId)}' LIMIT 1`;
  try {
    const res = await doltRead({
      auth: opts.auth,
      owner: opts.owner,
      db: opts.db,
      ref: opts.ref,
      query: sql,
      fetch: opts.fetch,
      hooks: opts.hooks,
    });
    if (res.rows.length === 0) return null;
    const parsed = WantedRowSchema.safeParse(res.rows[0]);
    if (!parsed.success) return null;
    return parsed.data;
  } catch (err) {
    if (err instanceof WlDoltHubError && err.status === 404) return null;
    throw new WlError(`Read wanted row at ${opts.ref ?? 'main'} failed`, 'upstream', err);
  }
}

/**
 * Compare two wanted rows for "represents the same state on the wanted-board".
 *
 * `updated_at` is excluded because every mutation rewrites it via `NOW()`,
 * so the timestamp will always differ even for an otherwise-identical row.
 *
 * Every other column is compared. The Go reference (`mutate.go:86`) compares
 * just `status` because the supported PR-mode mutations only ever change
 * status; this implementation is stricter — it will fail to auto-cleanup
 * if some future op edits a non-status column and then reverts it without
 * touching `updated_at`. That's a deliberate safety bias: spurious
 * non-cleanup is recoverable (callers can `discardBranch`), but spurious
 * cleanup would silently drop user-visible changes.
 */
export function wantedRowsEquivalent(a: WantedRow | null, b: WantedRow | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.id === b.id &&
    a.title === b.title &&
    a.description === b.description &&
    a.project === b.project &&
    a.type === b.type &&
    a.priority === b.priority &&
    JSON.stringify(a.tags) === JSON.stringify(b.tags) &&
    a.posted_by === b.posted_by &&
    a.claimed_by === b.claimed_by &&
    a.status === b.status &&
    a.effort_level === b.effort_level &&
    a.evidence_url === b.evidence_url &&
    a.sandbox_required === b.sandbox_required &&
    JSON.stringify(a.sandbox_scope) === JSON.stringify(b.sandbox_scope) &&
    a.sandbox_min_tier === b.sandbox_min_tier &&
    a.created_at === b.created_at
  );
}
