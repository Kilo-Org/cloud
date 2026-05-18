/**
 * Inner branch-ops functions, decoupled from the worker `Env` and the
 * WastelandDO. Each function takes a pre-resolved
 * {@link BranchOpsInnerContext} and an optional injected `fetch`,
 * then drives {@link WlClient} (and a couple of bare DoltHub calls)
 * to produce the tRPC return shape.
 *
 * This split mirrors `wanted-board-ops-sdk-inner.ts`. It exists so the
 * unit tests in `branch-ops.test.ts` can exercise the SDK→tRPC mapping
 * at the fetch boundary without touching `getWastelandDOStub` (which
 * transitively imports `cloudflare:workers` and breaks the Node-only
 * vitest pool).
 *
 * The wrappers in `branch-ops.ts` add credential resolution,
 * cache refresh, and metering on top of these.
 */

import { z } from 'zod';
import {
  WlClient,
  WlError,
  doltRead,
  getPull,
  type MyBranchEntry,
  type Pull,
  type PullDetail,
} from '@kilocode/wl-sdk';
import { WantedBoardOpError } from '../wanted-board/errors';
import { buildPullWebUrl } from '../util/dolthub-api.util';

// ── Types ────────────────────────────────────────────────────────────────

/** Status of a wanted item, normalized across upstream and branch reads. */
export type BranchWantedStatus = 'open' | 'claimed' | 'in_review' | 'completed' | 'unknown';

/**
 * Whether the branch is in sync with upstream `main` for this item:
 *
 *   - in-sync   : branch and main report the same status
 *   - ahead     : branch has advanced (e.g. main says open, branch says
 *                 claimed) — the normal "work in progress" case
 *   - diverged  : main has caught up past the branch (e.g. branch says
 *                 claimed but main says completed) — the branch is
 *                 stale and probably wants discarding
 */
export type BranchDivergence = 'in-sync' | 'ahead' | 'diverged';

export type ForkBranchEntry = {
  branchName: string;
  wantedId: string;
  /** Item title, sourced from upstream `main` when available. */
  wantedTitle: string | null;
  wantedRowOnBranch: WantedRow | null;
  wantedStatusOnBranch: BranchWantedStatus;
  wantedStatusOnMain: BranchWantedStatus;
  divergence: BranchDivergence;
  hasOpenPR: boolean;
  pullState: 'open' | 'closed' | 'merged' | null;
  prUrl: string | null;
  /** ISO timestamp string of the branch's latest commit, or null. */
  lastCommitAt: string | null;
};

export type MyPullEntry = {
  pullId: string;
  title: string;
  state: 'open' | 'closed' | 'merged';
  branchName: string | null;
  fromBranchOwner: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  mergeable: boolean;
  dolthubUrl: string;
};

/**
 * Auth + coordinates needed to talk to DoltHub on behalf of one
 * specific user-and-wasteland.
 */
export type BranchOpsInnerContext = {
  upstream: string;
  forkOrg: string;
  rigHandle: string;
  token: string;
};

// ── Helpers ──────────────────────────────────────────────────────────────

function makeClient(ctx: BranchOpsInnerContext, fetchImpl?: typeof fetch): WlClient {
  return new WlClient({
    upstream: ctx.upstream,
    forkOrg: ctx.forkOrg,
    rigHandle: ctx.rigHandle,
    token: ctx.token,
    fetch: fetchImpl,
  });
}

function wrapSdkError(err: unknown, label: string): WantedBoardOpError {
  if (err instanceof WantedBoardOpError) return err;
  if (err instanceof WlError) {
    const code =
      err.code === 'auth' || err.code === 'precondition'
        ? 'PRECONDITION_FAILED'
        : err.code === 'not_found'
          ? 'NOT_FOUND'
          : err.code === 'internal'
            ? 'INTERNAL_SERVER_ERROR'
            : 'UPSTREAM_ERROR';
    return new WantedBoardOpError(`${label} failed: ${err.message}`, code);
  }
  return new WantedBoardOpError(
    `${label} failed: ${err instanceof Error ? err.message : String(err)}`,
    'UPSTREAM_ERROR'
  );
}

const STATUS_RANK: Record<BranchWantedStatus, number> = {
  open: 0,
  claimed: 1,
  in_review: 2,
  completed: 3,
  unknown: -1,
};

function normalizeStatus(raw: string | null | undefined): BranchWantedStatus {
  if (!raw) return 'unknown';
  const v = raw.toLowerCase();
  if (v === 'open' || v === 'claimed' || v === 'in_review' || v === 'completed') return v;
  // 'done' is accepted as an alias for 'completed' for compatibility with
  // older rows on upstream that pre-date the canonical status set.
  if (v === 'done') return 'completed';
  return 'unknown';
}

function deriveDivergence(
  branchStatus: BranchWantedStatus,
  mainStatus: BranchWantedStatus
): BranchDivergence {
  if (branchStatus === 'unknown' || mainStatus === 'unknown') return 'in-sync';
  if (branchStatus === mainStatus) return 'in-sync';
  const branchRank = STATUS_RANK[branchStatus];
  const mainRank = STATUS_RANK[mainStatus];
  if (branchRank > mainRank) return 'ahead';
  return 'diverged';
}

const WantedRow = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable().default(null),
  project: z.string().nullable().default(null),
  type: z.string().nullable().default(null),
  priority: z.union([z.string(), z.number()]).nullable().default(null),
  tags: z.string().nullable().default(null),
  posted_by: z.string().nullable().default(null),
  claimed_by: z.string().nullable().default(null),
  status: z.string().nullable().default(null),
  effort_level: z.string().nullable().default(null),
  evidence_url: z.string().nullable().default(null),
  sandbox_required: z.union([z.string(), z.number()]).nullable().default(null),
  sandbox_scope: z.string().nullable().default(null),
  sandbox_min_tier: z.string().nullable().default(null),
  created_at: z.string().nullable().default(null),
  updated_at: z.string().nullable().default(null),
});

type WantedRow = z.infer<typeof WantedRow>;

/**
 * Read the wanted row off a specific branch tip on the fork. Returns
 * null on read failure (most commonly "no such branch" or "no such
 * row" — the caller handles both as "branch was removed underneath us").
 */
async function readWantedFromBranch(
  ctx: BranchOpsInnerContext,
  branchName: string,
  wantedId: string,
  fetchImpl?: typeof fetch
): Promise<{ status: BranchWantedStatus; title: string | null; row: WantedRow } | null> {
  const slash = ctx.upstream.indexOf('/');
  if (slash <= 0) return null;
  const upstreamDb = ctx.upstream.slice(slash + 1);
  const escapedId = wantedId.replace(/'/g, "''").replace(/\\/g, '\\\\');
  const sql = `SELECT id, title, description, project, type, priority, tags, posted_by, claimed_by, status, effort_level, evidence_url, sandbox_required, sandbox_scope, sandbox_min_tier, created_at, updated_at FROM wanted WHERE id = '${escapedId}' LIMIT 1`;
  try {
    const res = await doltRead({
      auth: { token: ctx.token },
      owner: ctx.forkOrg,
      db: upstreamDb,
      ref: branchName,
      query: sql,
      fetch: fetchImpl,
    });
    if (res.rows.length === 0) return null;
    const parsed = WantedRow.safeParse(res.rows[0]);
    if (!parsed.success) return null;
    return {
      status: normalizeStatus(parsed.data.status),
      title: parsed.data.title,
      row: parsed.data,
    };
  } catch {
    return null;
  }
}

// ── Public ops ───────────────────────────────────────────────────────────

/**
 * Enumerate the user's `wl/<any-rig>/<wantedId>` branches on the fork and
 * cross-reference each with upstream `main` and the branch tip.
 *
 * Why two reads per branch (fork tip + upstream main) rather than the
 * SDK's `WlClient.browse()`? `browse` orders by priority and limits to
 * 50, which is fine for the wanted board but loses branches whose
 * wanted item has fallen off the page. The workshop view must show
 * EVERY active branch. So we fetch upstream main once, then read each
 * branch tip individually.
 */
export async function listMyForkBranchesViaSdk(
  ctx: BranchOpsInnerContext,
  fetchImpl?: typeof fetch
): Promise<ForkBranchEntry[]> {
  const wl = makeClient(ctx, fetchImpl);

  let branches: MyBranchEntry[];
  try {
    branches = await wl.listMyBranches({ includeOpenPrs: true });
  } catch (err) {
    throw wrapSdkError(err, 'List fork branches');
  }
  // `wantedId === ''` happens for non-wanted branches (registration
  // etc.). Skip them — the workshop view is wanted-only. The SDK returns
  // all wanted branches on this fork so work created through connected
  // tools under a different rig handle still appears in the workshop.
  const wantedBranches = branches.filter(
    b => b.wantedId.length > 0 && (b.pullState === null || b.pullState === 'open')
  );
  if (wantedBranches.length === 0) return [];

  // Upstream main snapshot — one bulk read keyed by id. We only need
  // status + title, not the full board.
  const mainStatusByItemId = new Map<
    string,
    { status: BranchWantedStatus; title: string | null }
  >();
  try {
    const slash = ctx.upstream.indexOf('/');
    if (slash > 0) {
      const upstreamOwner = ctx.upstream.slice(0, slash);
      const upstreamDb = ctx.upstream.slice(slash + 1);
      const ids = wantedBranches.map(b => b.wantedId.replace(/'/g, "''").replace(/\\/g, '\\\\'));
      const inList = ids.map(id => `'${id}'`).join(',');
      const sql = `SELECT id, title, status FROM wanted WHERE id IN (${inList})`;
      const res = await doltRead({
        auth: { token: ctx.token },
        owner: upstreamOwner,
        db: upstreamDb,
        query: sql,
        fetch: fetchImpl,
      });
      for (const row of res.rows) {
        const parsed = WantedRow.pick({ id: true, title: true, status: true }).safeParse(row);
        if (parsed.success) {
          mainStatusByItemId.set(parsed.data.id, {
            status: normalizeStatus(parsed.data.status),
            title: parsed.data.title,
          });
        }
      }
    }
  } catch {
    // Best-effort: leave main statuses as 'unknown' on failure.
  }

  const entries = await Promise.all(
    wantedBranches.map(async (b): Promise<ForkBranchEntry> => {
      const branchTip = await readWantedFromBranch(ctx, b.branchName, b.wantedId, fetchImpl);
      const mainEntry = mainStatusByItemId.get(b.wantedId);
      const branchStatus = branchTip?.status ?? 'unknown';
      const mainStatus = mainEntry?.status ?? 'unknown';
      const wantedTitle = mainEntry?.title ?? branchTip?.title ?? null;
      return {
        branchName: b.branchName,
        wantedId: b.wantedId,
        wantedTitle,
        wantedRowOnBranch: branchTip?.row ?? null,
        wantedStatusOnBranch: branchStatus,
        wantedStatusOnMain: mainStatus,
        divergence: deriveDivergence(branchStatus, mainStatus),
        hasOpenPR: b.openPullId !== null,
        pullState: b.pullState,
        prUrl: b.openPullId ? buildPullWebUrl(ctx.upstream, b.openPullId) : null,
        lastCommitAt: b.latestCommitDate,
      };
    })
  );

  return entries;
}

/**
 * Open a PR for the user's `wl/<rig>/<wantedId>` branch (or return the
 * existing PR's URL when one is already open). Idempotent.
 */
export async function publishBranchViaSdk(
  ctx: BranchOpsInnerContext,
  wantedId: string,
  fetchImpl?: typeof fetch
): Promise<{ prUrl: string; prId: string }> {
  const wl = makeClient(ctx, fetchImpl);
  try {
    return await wl.publish(wantedId);
  } catch (err) {
    throw wrapSdkError(err, 'Publish');
  }
}

/**
 * Delete the user's `wl/<rig>/<wantedId>` branch. Idempotent — a
 * missing branch resolves successfully.
 */
export async function discardBranchViaSdk(
  ctx: BranchOpsInnerContext,
  wantedId: string,
  fetchImpl?: typeof fetch
): Promise<{ success: true }> {
  const wl = makeClient(ctx, fetchImpl);
  try {
    await wl.discardBranch(wantedId);
  } catch (err) {
    throw wrapSdkError(err, 'Discard branch');
  }
  return { success: true };
}

/**
 * Maximum number of upstream PRs whose detail will be fetched to
 * answer "is this one mine?". `listPulls` returns PR summaries without
 * `from_branch_owner_name`, so the only way to confirm ownership is
 * one detail fetch per candidate. We cap it so a wasteland with a
 * large historical PR queue can't pin a Worker on this query.
 */
export const MY_PULLS_DETAIL_CAP = 100;

/**
 * List the user's PRs against the upstream — the "Mine" tab on the
 * pulls page. Filters all-state pulls down to those whose source
 * branch is owned by the caller's fork.
 *
 * DoltHub's list endpoint omits the `from_branch_owner_name` field
 * (only the detail endpoint exposes it), so confirming ownership
 * requires one detail fetch per candidate. Two layers of pruning bound
 * the fan-out before we hit DoltHub's per-PR endpoint:
 *
 *   1. `creator_name` pre-filter — drops PRs clearly authored by
 *      someone else when DoltHub populates the field on the summary.
 *   2. Hard cap of {@link MY_PULLS_DETAIL_CAP} candidates — `pulls` is
 *      already sorted newest-first by DoltHub; older PRs that fall
 *      past the cap are dropped from the "Mine" tab. Acceptable for
 *      M2.4 (the tab is interactive, not a complete archive).
 */
export async function listMyPullsViaSdk(
  ctx: BranchOpsInnerContext,
  fetchImpl?: typeof fetch
): Promise<MyPullEntry[]> {
  const wl = makeClient(ctx, fetchImpl);

  const slash = ctx.upstream.indexOf('/');
  if (slash <= 0) return [];
  const upstreamOwner = ctx.upstream.slice(0, slash);
  const upstreamDb = ctx.upstream.slice(slash + 1);

  let pulls: Pull[];
  try {
    pulls = await wl.listPulls('all');
  } catch (err) {
    throw wrapSdkError(err, 'List my pulls');
  }

  // Cheap pre-filter: when DoltHub does populate `creator_name`, it's
  // the fork owner. Drop pulls clearly authored by someone else
  // before paying for detail fetches.
  const allCandidates = pulls.filter(p => !p.creator_name || p.creator_name === ctx.forkOrg);
  const candidates = allCandidates.slice(0, MY_PULLS_DETAIL_CAP);

  const details = await Promise.all(
    candidates.map(p =>
      getPull({
        auth: { token: ctx.token },
        owner: upstreamOwner,
        db: upstreamDb,
        pullId: p.pull_id,
        fetch: fetchImpl,
      }).catch((): PullDetail | null => null)
    )
  );

  const entries: MyPullEntry[] = [];
  for (let i = 0; i < details.length; i++) {
    const detail = details[i];
    const summary = candidates[i];
    if (!detail) continue;
    if (detail.from_branch_owner_name !== ctx.forkOrg) continue;
    const stateLower = detail.state.toLowerCase();
    const state: MyPullEntry['state'] =
      stateLower === 'merged' ? 'merged' : stateLower === 'closed' ? 'closed' : 'open';
    entries.push({
      pullId: detail.pull_id,
      title: detail.title || summary.title || `PR #${detail.pull_id}`,
      state,
      branchName: detail.from_branch_name,
      fromBranchOwner: detail.from_branch_owner_name,
      createdAt: detail.created_at,
      updatedAt: detail.updated_at,
      // `mergeable` isn't in the detail payload — DoltHub computes it
      // lazily on the merge call. We surface "open" pulls as
      // mergeable=true and let the actual merge call be the source of
      // truth. Closed/merged pulls report false.
      mergeable: state === 'open',
      dolthubUrl: buildPullWebUrl(ctx.upstream, detail.pull_id),
    });
  }

  // Sort newest first by updated_at, falling back to created_at.
  entries.sort((a, b) => {
    const aTs = Date.parse(a.updatedAt ?? a.createdAt ?? '') || 0;
    const bTs = Date.parse(b.updatedAt ?? b.createdAt ?? '') || 0;
    return bTs - aTs;
  });

  return entries;
}
