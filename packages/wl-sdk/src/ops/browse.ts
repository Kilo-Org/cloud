/**
 * `browse` — branch-aware wanted-board read.
 *
 * Reads upstream `main`, then overlays the caller's `wl/<rig>/*` fork
 * branches. The result identifies, per wanted id, both the upstream
 * row (if any) and the forked branch row (if any), so callers can
 * render "in-flight" state alongside the canonical board.
 *
 * Mirrors `BrowseWantedBranchAware` (`commons/queries.go:598`) and
 * `Client.BrowseContext` (`sdk/reads.go:87`).
 */

import { z } from 'zod';
import { doltRead } from '../dolthub/read';
import { listBranches } from '../dolthub/branches';
import { WlDoltHubError } from '../dolthub/api';
import { escapeSqlString } from '../commons/escape';
import { WantedRowSchema, type WantedRow } from '../commons/schema.generated';
import { parseWlBranch, rigBranchPrefix } from './branch';
import type { DoltHubAuth, DoltFetchHooks } from '../dolthub/api';
import type { RigHandle, WastelandRef, WlResult } from './types';
import { WlError } from './types';

export type BrowseFilter = {
  status?: string;
  project?: string;
  type?: string;
  /** Numeric priority filter (0..3). Omit to disable. */
  priority?: number;
  postedBy?: string;
  claimedBy?: string;
  /** Free-text search across title/description/tags. */
  search?: string;
  /** ISO8601 / SQL timestamp string; rows with `updated_at >= since`. */
  since?: string;
  /** Omit to return every matching row. */
  limit?: number;
};

/**
 * One row in the browse result. `upstream` is the row on upstream
 * `main`; `fork` is the row on the caller's mutation branch. At
 * least one of them is non-null. `source` reflects which one to
 * render as the effective state — "fork" when a branch row exists
 * and differs from upstream.
 */
export type BrowseEntry = {
  wantedId: string;
  upstream: WantedRow | null;
  fork: { row: WantedRow; branchName: string } | null;
  source: 'main' | 'fork';
};

export type BrowseOptions = {
  auth: DoltHubAuth;
  upstream: WastelandRef;
  fork: { forkOwner: string; forkDb: string };
  rigHandle: RigHandle;
  filter?: BrowseFilter;
  fetch?: typeof fetch;
  hooks?: DoltFetchHooks;
};

const RowSchema = WantedRowSchema;
const BoardStatuses = [
  'open',
  'claimed',
  'in_review',
  'completed',
  'validated',
  'withdrawn',
] as const;

/**
 * Returns `true` when the fork-branch row represents work the user is
 * actively doing on top of the upstream main row — i.e. the fork's
 * `updated_at` is strictly later than upstream's. In that case the
 * fork wins as the displayed source.
 *
 * Returns `false` when the fork branch is stale relative to upstream
 * (most often: an admin merged the user's `wl done` upstream, the
 * upstream row advanced to `completed`, but the fork branch still
 * shows the older `in_review` snapshot until the branch is discarded).
 *
 * Comparing `updated_at` strings is safe here because DoltHub returns
 * them in `'YYYY-MM-DD HH:MM:SS'` UTC format, which is lexicographically
 * sortable. When either side lacks a timestamp, we fall back to a
 * conservative "fork wins" rule — the same as the legacy behavior —
 * to avoid hiding genuine fork progress on rows that happen to be
 * missing the field.
 */
function forkRowIsAheadOfUpstream(forkRow: WantedRow, upstreamRow: WantedRow | null): boolean {
  if (upstreamRow === null) return true;
  const forkAt = forkRow.updated_at;
  const upstreamAt = upstreamRow.updated_at;
  if (forkAt === null || upstreamAt === null) return true;
  return forkAt > upstreamAt;
}

function formatBrowseError(err: unknown): string {
  if (err instanceof WlDoltHubError) {
    const body = typeof err.body === 'string' ? err.body : JSON.stringify(err.body);
    return `browse read failed: ${err.message}${body ? `: ${body}` : ''}`;
  }
  if (err instanceof z.ZodError) {
    return `browse row validation failed: ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}

function buildBrowseSql(filter: BrowseFilter | undefined): string {
  const conditions: string[] = [];
  if (filter?.status) conditions.push(`status = '${escapeSqlString(filter.status)}'`);
  if (filter?.project) conditions.push(`project = '${escapeSqlString(filter.project)}'`);
  if (filter?.type) conditions.push(`type = '${escapeSqlString(filter.type)}'`);
  if (filter?.priority !== undefined && filter.priority >= 0) {
    conditions.push(`priority = ${filter.priority}`);
  }
  if (filter?.postedBy) conditions.push(`posted_by = '${escapeSqlString(filter.postedBy)}'`);
  if (filter?.claimedBy) conditions.push(`claimed_by = '${escapeSqlString(filter.claimedBy)}'`);
  if (filter?.since) conditions.push(`updated_at >= '${escapeSqlString(filter.since)}'`);
  if (filter?.search) {
    const s = escapeSqlString(filter.search).replace(/%/g, '\\%').replace(/_/g, '\\_');
    conditions.push(
      `(title LIKE '%${s}%' OR COALESCE(description,'') LIKE '%${s}%' OR COALESCE(tags,'') LIKE '%${s}%')`
    );
  }

  let sql = 'SELECT * FROM wanted';
  if (conditions.length > 0) sql += ` WHERE ${conditions.join(' AND ')}`;
  sql += ' ORDER BY priority ASC, created_at DESC';
  if (filter?.limit && filter.limit > 0) sql += ` LIMIT ${filter.limit}`;
  return sql;
}

function buildStatusBrowseSql(status: string): string {
  return `SELECT * FROM wanted WHERE status = '${escapeSqlString(status)}' ORDER BY priority ASC, created_at DESC`;
}

async function readWantedRows(opts: BrowseOptions): Promise<WantedRow[]> {
  if (opts.filter) {
    const filteredRes = await doltRead({
      auth: opts.auth,
      owner: opts.upstream.owner,
      db: opts.upstream.db,
      // No ref: take advantage of the anonymous-fallback in doltRead so
      // this works even with a user token whose identity differs from the
      // upstream owner.
      query: buildBrowseSql(opts.filter),
      fetch: opts.fetch,
      hooks: opts.hooks,
    });
    return z.array(RowSchema).parse(filteredRes.rows);
  }

  // DoltHub caps large SELECT results with `query_execution_status: RowLimit`.
  // Fetch each status separately so low-volume open/in-review rows are not
  // hidden behind thousands of completed rows in the unfiltered board query.
  const results = await Promise.all(
    BoardStatuses.map(status =>
      doltRead({
        auth: opts.auth,
        owner: opts.upstream.owner,
        db: opts.upstream.db,
        query: buildStatusBrowseSql(status),
        fetch: opts.fetch,
        hooks: opts.hooks,
      })
    )
  );

  return z.array(RowSchema).parse(results.flatMap(result => result.rows));
}

export async function browse(opts: BrowseOptions): Promise<WlResult<BrowseEntry[]>> {
  try {
    // 1. Upstream main rows.
    const mainRows = await readWantedRows(opts);
    const byId = new Map<string, BrowseEntry>();
    for (const row of mainRows) {
      byId.set(row.id, { wantedId: row.id, upstream: row, fork: null, source: 'main' });
    }

    // 2. Caller's fork branches: list, filter to `wl/<rig>/*`, then
    //    read each branch's wanted row.
    const branches = await listBranches({
      auth: opts.auth,
      owner: opts.fork.forkOwner,
      db: opts.fork.forkDb,
      fetch: opts.fetch,
      hooks: opts.hooks,
    }).catch(() => []);

    const prefix = rigBranchPrefix(opts.rigHandle);
    const myBranches = branches.filter(b => b.branch_name.startsWith(prefix));

    await Promise.all(
      myBranches.map(async branch => {
        const parsed = parseWlBranch(branch.branch_name);
        if (parsed === null || parsed.kind !== 'wanted') return;
        const branchSql = `SELECT * FROM wanted WHERE id = '${escapeSqlString(parsed.wantedId)}' LIMIT 1`;
        try {
          const branchRes = await doltRead({
            auth: opts.auth,
            owner: opts.fork.forkOwner,
            db: opts.fork.forkDb,
            ref: branch.branch_name,
            query: branchSql,
            fetch: opts.fetch,
            hooks: opts.hooks,
          });
          if (branchRes.rows.length === 0) return;
          const row = RowSchema.parse(branchRes.rows[0]);
          const existing = byId.get(parsed.wantedId);
          const forkInfo = { row, branchName: branch.branch_name };
          if (existing) {
            // Always attach the fork row — drawer/branch-tab consumers
            // surface it independently. But only flip `source` to
            // `'fork'` when the fork branch is *ahead of* upstream
            // (its `updated_at` is strictly newer). Otherwise the fork
            // is stale — for example the user `wl done`'d locally,
            // an admin merged it upstream, and the original `wl/<rig>/<id>`
            // branch still lives on the fork showing `in_review` even
            // though main now reflects `completed`. In that case
            // upstream wins.
            existing.fork = forkInfo;
            if (forkRowIsAheadOfUpstream(row, existing.upstream)) {
              existing.source = 'fork';
            }
          } else {
            // Branch-only item — appears in result but has no
            // upstream counterpart yet (e.g. a freshly `post`ed
            // wanted that hasn't merged into main).
            byId.set(parsed.wantedId, {
              wantedId: parsed.wantedId,
              upstream: null,
              fork: forkInfo,
              source: 'fork',
            });
          }
        } catch {
          // Branch read failed — skip; the upstream entry (if any)
          // remains visible.
        }
      })
    );

    return { ok: true, data: Array.from(byId.values()) };
  } catch (err) {
    if (err instanceof WlError) return { ok: false, error: err };
    return { ok: false, error: new WlError(formatBrowseError(err), 'upstream', err) };
  }
}
