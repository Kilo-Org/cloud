/**
 * `workshop` — operations over the caller's per-rig set of branches.
 *
 *   - `listMyBranches` — enumerate `wl/<rig>/*` branches with parsed
 *     wantedId, latest commit info, and an open-PR flag.
 *   - `discardBranch`  — delete a branch on the fork (idempotent).
 *
 * Mirrors `Client.DiscardBranch` (`wasteland/internal/sdk/branches.go:46`).
 */

import { deleteBranch, listBranches, type Branch } from '../dolthub/branches';
import { getPull, listPulls } from '../dolthub/pulls';
import { parseWlBranch, rigBranchPrefix } from './branch';
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
    const prefix = rigBranchPrefix(opts.rigHandle);
    const mine = branches.filter(b => b.branch_name.startsWith(prefix));

    let openPrs = new Map<string, string>(); // branchName → pullId
    if ((opts.includeOpenPrs ?? true) && mine.length > 0) {
      try {
        const pulls = await listPulls({
          auth: opts.auth,
          owner: opts.upstream.owner,
          db: opts.upstream.db,
          state: 'open',
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
        openPrs = collectOpenPrsByBranch(details, opts.fork.forkOwner);
      } catch {
        // Best-effort — leave openPullId as null on failure.
      }
    }

    const entries = mine.map((b: Branch): MyBranchEntry => {
      const parsed = parseWlBranch(b.branch_name);
      const wantedId = parsed?.kind === 'wanted' ? parsed.wantedId : '';
      return {
        branchName: b.branch_name,
        wantedId,
        latestCommitter: b.latest_committer ?? null,
        latestCommitMessage: b.latest_commit_message ?? null,
        latestCommitDate: b.latest_commit_date ?? null,
        openPullId: openPrs.get(b.branch_name) ?? null,
      };
    });
    return { ok: true, data: entries };
  } catch (err) {
    if (err instanceof WlError) return { ok: false, error: err };
    return { ok: false, error: new WlError('listMyBranches failed', 'upstream', err) };
  }
}

function collectOpenPrsByBranch(
  details: ReadonlyArray<Awaited<ReturnType<typeof getPull>> | null>,
  forkOwner: string
): Map<string, string> {
  const out = new Map<string, string>();
  for (const detail of details) {
    if (!detail) continue;
    if (detail.from_branch_owner_name !== forkOwner) continue;
    if (!detail.from_branch_name) continue;
    out.set(detail.from_branch_name, detail.pull_id);
  }
  return out;
}

export type DiscardBranchOptions = {
  auth: DoltHubAuth;
  fork: { forkOwner: string; forkDb: string };
  branchName: string;
  fetch?: typeof fetch;
  hooks?: DoltFetchHooks;
};

export async function discardBranch(opts: DiscardBranchOptions): Promise<WlResult<void>> {
  try {
    await deleteBranch({
      auth: opts.auth,
      owner: opts.fork.forkOwner,
      db: opts.fork.forkDb,
      branch: opts.branchName,
      fetch: opts.fetch,
      hooks: opts.hooks,
    });
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
