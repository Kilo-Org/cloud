/**
 * `leave` — sever the rig's contributor relationship with a wasteland.
 *
 * The Go reference does not implement a single canonical "leave" —
 * `wasteland/cmd/wl/cmd_leave.go` removes the local clone and config
 * but does not deregister the rig in the commons. Deregistration in
 * the upstream is non-trivial because:
 *
 *   - The `rigs` row carries trust state and stamp authorship; simply
 *     deleting it would invalidate historical stamps.
 *   - Closing the registration PR is purely cosmetic — the user has
 *     already merged it into upstream `rigs` if they were active.
 *   - Removing the fork is destructive and out of scope here.
 *
 * For now, the wl-sdk's `leave` does the simplest reversible thing:
 * delete every `wl/<rigHandle>/*` branch on the fork. The
 * registration branch (`wl/register/<rigHandle>`) and the fork itself
 * remain. Callers that want a deeper teardown can chain explicit
 * follow-ups.
 *
 * **Gaps for follow-up**:
 *   - Mark the rig inactive (e.g. `UPDATE rigs SET trust_level=0`)
 *     via a separate registration commit on `wl/register/<rig>`.
 *   - Optionally delete the fork via DoltHub's database-delete API.
 *   - Close any open upstream PRs the rig has authored.
 */

import { listBranches, deleteBranch } from '../dolthub/branches';
import { rigBranchPrefix } from './branch';
import type { DoltFetchHooks, DoltHubAuth } from '../dolthub/api';
import type { RigHandle, WlResult } from './types';
import { WlError } from './types';

export type LeaveOptions = {
  auth: DoltHubAuth;
  fork: { forkOwner: string; forkDb: string };
  rigHandle: RigHandle;
  fetch?: typeof fetch;
  hooks?: DoltFetchHooks;
};

export type LeaveResult = {
  /** Number of branches deleted. */
  deletedBranches: number;
  /** Branches we attempted to delete but failed on (best-effort). */
  failedBranches: string[];
};

export async function leave(opts: LeaveOptions): Promise<WlResult<LeaveResult>> {
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

    let deleted = 0;
    const failed: string[] = [];

    for (const branch of mine) {
      try {
        await deleteBranch({
          auth: opts.auth,
          owner: opts.fork.forkOwner,
          db: opts.fork.forkDb,
          branch: branch.branch_name,
          fetch: opts.fetch,
          hooks: opts.hooks,
        });
        deleted++;
      } catch {
        failed.push(branch.branch_name);
      }
    }

    return { ok: true, data: { deletedBranches: deleted, failedBranches: failed } };
  } catch (err) {
    if (err instanceof WlError) return { ok: false, error: err };
    return { ok: false, error: new WlError('leave failed', 'upstream', err) };
  }
}
