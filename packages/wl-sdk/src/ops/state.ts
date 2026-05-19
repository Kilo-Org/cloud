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

const HeadRow = z.object({ h: z.string() }).passthrough();

/**
 * Read the HEAD commit hash of a branch on a DoltHub repo.
 *
 * Used by {@link assertForkMainCurrent} to detect stale forks. Returns
 * `null` when the branch doesn't exist (404) or DoltHub returns no rows
 * — callers treat that as "couldn't determine, don't block."
 */
export async function readBranchHead(opts: {
  auth: DoltHubAuth;
  owner: string;
  db: string;
  branch: string;
  fetch?: typeof fetch;
  hooks?: DoltFetchHooks;
}): Promise<string | null> {
  // `HASHOF('<ref>')` is the standard dolt SQL function for the
  // commit-hash of a ref. We pass the branch name as the ref so the
  // result is the HEAD of that branch.
  const sql = `SELECT HASHOF('${escapeSqlString(opts.branch)}') AS h`;
  try {
    const res = await doltRead({
      auth: opts.auth,
      owner: opts.owner,
      db: opts.db,
      // Read from main — the HASHOF function works regardless of the
      // queried branch, and main is guaranteed to exist on every repo.
      ref: 'main',
      query: sql,
      fetch: opts.fetch,
      hooks: opts.hooks,
    });
    if (res.rows.length === 0) return null;
    const parsed = HeadRow.safeParse(res.rows[0]);
    if (!parsed.success) return null;
    return parsed.data.h;
  } catch (err) {
    if (err instanceof WlDoltHubError && err.status === 404) return null;
    return null;
  }
}

/**
 * Refuse the mutation if the caller's fork is behind upstream.
 *
 * **Why this exists:** the DoltHub hosted SQL API does not support
 * `CALL DOLT_FETCH` / `DOLT_PULL` / `DOLT_MERGE('upstream/main')`
 * (verified against jrf0110/wl-commons; all return
 * `Unsupported SQL statement`), and a cross-repo PR from
 * `upstream:main` → `fork:main` requires write permission on the
 * upstream repo (which the fork owner doesn't have).
 *
 * So we cannot programmatically sync a fork from upstream. The only
 * working sync paths are:
 *  - The DoltHub web UI's "Update from upstream" affordance on the
 *    fork's pulls page.
 *  - The local `dolt` CLI: `dolt fetch upstream && dolt merge upstream/main`.
 *
 * When we detect drift, this throws a {@link WlError} with `code:
 * 'precondition'` and a message containing the deep-link URL — the
 * server adapter surfaces it to the UI so the user can sync and
 * retry.
 *
 * The check is best-effort: if either HEAD read fails we let the
 * mutation proceed (better to allow a write that might silently
 * no-op than to block a healthy mutation on a transient read error).
 */
export async function assertForkMainCurrent(opts: {
  auth: DoltHubAuth;
  upstream: { owner: string; db: string };
  fork: { forkOwner: string; forkDb: string };
  fetch?: typeof fetch;
  hooks?: DoltFetchHooks;
}): Promise<void> {
  const [upstreamHead, forkHead] = await Promise.all([
    readBranchHead({
      auth: opts.auth,
      owner: opts.upstream.owner,
      db: opts.upstream.db,
      branch: 'main',
      fetch: opts.fetch,
      hooks: opts.hooks,
    }),
    readBranchHead({
      auth: opts.auth,
      owner: opts.fork.forkOwner,
      db: opts.fork.forkDb,
      branch: 'main',
      fetch: opts.fetch,
      hooks: opts.hooks,
    }),
  ]);

  // If either read returned null, we can't decide. Don't block.
  if (upstreamHead === null || forkHead === null) return;
  if (upstreamHead === forkHead) return;

  // Drift detected. Compose the deep-link to the fork's pulls/new page,
  // which is where DoltHub surfaces the "Sync from upstream" UI.
  const syncUrl = `https://www.dolthub.com/repositories/${encodeURIComponent(opts.fork.forkOwner)}/${encodeURIComponent(opts.fork.forkDb)}/pulls/new`;
  throw new WlError(
    `Your DoltHub fork ${opts.fork.forkOwner}/${opts.fork.forkDb} is behind upstream ${opts.upstream.owner}/${opts.upstream.db}. ` +
      `DoltHub's API doesn't support a programmatic fork-sync, so you'll need to sync manually before this mutation can proceed. ` +
      `Visit ${syncUrl} and open a pull request from ${opts.upstream.owner}/${opts.upstream.db}:main into your fork's main, then merge it. ` +
      `After the sync lands, retry this action.`,
    'precondition'
  );
}
