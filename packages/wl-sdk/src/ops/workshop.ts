/**
 * `workshop` — operations over the caller's per-rig set of branches.
 *
 *   - `listMyBranches` — enumerate `wl/<any-rig>/<wantedId>` branches with parsed
 *     wantedId, latest commit info, and an open-PR flag.
 *   - `discardBranch`  — close its open PR, then delete the branch on
 *     the fork (idempotent).
 *
 * Mirrors `Client.DiscardBranch` (`wasteland/internal/sdk/branches.go:46`).
 */

import { branchExists, deleteBranch, listBranches, type Branch } from '../dolthub/branches';
import { closePull, getPull, listPulls } from '../dolthub/pulls';
import { parseWlBranch } from './branch';
import { WlDoltHubError, type DoltFetchHooks, type DoltHubAuth } from '../dolthub/api';
import type { RigHandle, WastelandRef, WlResult } from './types';
import { WlError } from './types';

export type ListMyBranchesOptions = {
  auth: DoltHubAuth;
  upstream: WastelandRef;
  fork: { forkOwner: string; forkDb: string };
  rigHandle: RigHandle;
  /** When false, skip the per-PR open-pulls scan. Defaults to true. */
  includeOpenPrs?: boolean;
  fetch?: typeof fetch;
  hooks?: DoltFetchHooks;
};

export type MyBranchEntry = {
  branchName: string;
  wantedId: string;
  latestCommitter: string | null;
  latestCommitMessage: string | null;
  latestCommitDate: string | null;
  /** Open PR id on upstream for this branch, or null. */
  openPullId: string | null;
  /** Latest known PR state for this branch, or null when no PR exists. */
  pullState: 'open' | 'closed' | 'merged' | null;
};

export async function listMyBranches(
  opts: ListMyBranchesOptions
): Promise<WlResult<MyBranchEntry[]>> {
  try {
    const branches = await listBranches({
      auth: opts.auth,
      owner: opts.fork.forkOwner,
      db: opts.fork.forkDb,
      fetch: opts.fetch,
      hooks: opts.hooks,
    });
    const mine = branches.filter(b => parseWlBranch(b.branch_name)?.kind === 'wanted');

    let prsByBranch = new Map<string, { pullId: string; state: 'open' | 'closed' | 'merged' }>();
    if ((opts.includeOpenPrs ?? true) && mine.length > 0) {
      try {
        const pulls = await listPulls({
          auth: opts.auth,
          owner: opts.upstream.owner,
          db: opts.upstream.db,
          state: 'all',
          fetch: opts.fetch,
          hooks: opts.hooks,
        });
        // Per-PR detail to learn the from-branch.
        const details = await Promise.all(
          pulls.map(p =>
            getPull({
              auth: opts.auth,
              owner: opts.upstream.owner,
              db: opts.upstream.db,
              pullId: p.pull_id,
              fetch: opts.fetch,
              hooks: opts.hooks,
            }).catch(() => null)
          )
        );
        prsByBranch = collectPrsByBranch(details, opts.fork.forkOwner);
      } catch {
        // Best-effort — leave PR metadata as null on failure.
      }
    }

    const entries = mine.map((b: Branch): MyBranchEntry => {
      const parsed = parseWlBranch(b.branch_name);
      const wantedId = parsed?.kind === 'wanted' ? parsed.wantedId : '';
      const pr = prsByBranch.get(b.branch_name) ?? null;
      return {
        branchName: b.branch_name,
        wantedId,
        latestCommitter: b.latest_committer ?? null,
        latestCommitMessage: b.latest_commit_message ?? null,
        latestCommitDate: b.latest_commit_date ?? null,
        openPullId: pr?.state === 'open' ? pr.pullId : null,
        pullState: pr?.state ?? null,
      };
    });
    return { ok: true, data: entries };
  } catch (err) {
    if (err instanceof WlError) return { ok: false, error: err };
    return { ok: false, error: new WlError('listMyBranches failed', 'upstream', err) };
  }
}

function collectPrsByBranch(
  details: ReadonlyArray<Awaited<ReturnType<typeof getPull>> | null>,
  forkOwner: string
): Map<string, { pullId: string; state: 'open' | 'closed' | 'merged' }> {
  const out = new Map<string, { pullId: string; state: 'open' | 'closed' | 'merged' }>();
  for (const detail of details) {
    if (!detail) continue;
    if (detail.from_branch_owner_name !== forkOwner) continue;
    if (!detail.from_branch_name) continue;
    const state = normalizePullState(detail.state);
    if (!state) continue;
    const current = out.get(detail.from_branch_name);
    if (current?.state === 'open') continue;
    out.set(detail.from_branch_name, { pullId: detail.pull_id, state });
  }
  return out;
}

function normalizePullState(state: string): 'open' | 'closed' | 'merged' | null {
  const normalized = state.toLowerCase();
  if (normalized === 'open' || normalized === 'closed' || normalized === 'merged')
    return normalized;
  return null;
}

export type DiscardBranchOptions = {
  auth: DoltHubAuth;
  upstream?: WastelandRef;
  fork: { forkOwner: string; forkDb: string };
  branchName: string;
  fetch?: typeof fetch;
  hooks?: DoltFetchHooks;
};

export async function discardBranch(opts: DiscardBranchOptions): Promise<WlResult<void>> {
  try {
    const upstream = opts.upstream;
    if (upstream) {
      await closeOpenPullForBranch({ ...opts, upstream });
    }
    await deleteBranch({
      auth: opts.auth,
      owner: opts.fork.forkOwner,
      db: opts.fork.forkDb,
      branch: opts.branchName,
      fetch: opts.fetch,
      hooks: opts.hooks,
    });
    await waitForBranchDeletion(opts);
    return { ok: true, data: undefined };
  } catch (err) {
    // Idempotent: a 404 means the branch was already gone.
    if (err instanceof WlDoltHubError && err.status === 404) {
      return { ok: true, data: undefined };
    }
    if (err instanceof WlError) return { ok: false, error: err };
    return { ok: false, error: new WlError('discardBranch failed', 'upstream', err) };
  }
}

async function waitForBranchDeletion(opts: DiscardBranchOptions): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const exists = await branchExists({
      auth: opts.auth,
      owner: opts.fork.forkOwner,
      db: opts.fork.forkDb,
      branch: opts.branchName,
      fetch: opts.fetch,
      hooks: opts.hooks,
    });
    if (!exists) return;
    await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
  }
}

async function closeOpenPullForBranch(opts: DiscardBranchOptions & { upstream: WastelandRef }) {
  const pulls = await listPulls({
    auth: opts.auth,
    owner: opts.upstream.owner,
    db: opts.upstream.db,
    state: 'open',
    fetch: opts.fetch,
    hooks: opts.hooks,
  });

  for (const summary of pulls) {
    const detail = await getPull({
      auth: opts.auth,
      owner: opts.upstream.owner,
      db: opts.upstream.db,
      pullId: summary.pull_id,
      fetch: opts.fetch,
      hooks: opts.hooks,
    }).catch(() => null);
    if (!detail) continue;
    if (
      detail.from_branch_name === opts.branchName &&
      detail.from_branch_owner_name === opts.fork.forkOwner
    ) {
      await closePull({
        auth: opts.auth,
        owner: opts.upstream.owner,
        db: opts.upstream.db,
        pullId: detail.pull_id,
        fetch: opts.fetch,
        hooks: opts.hooks,
      });
      return;
    }
  }
}
