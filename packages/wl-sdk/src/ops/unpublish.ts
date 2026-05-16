/**
 * `unpublish` — close the open PR for `wl/<rig>/<id>` while keeping
 * the branch.
 *
 * Idempotent: if there's no matching open PR, returns success no-op.
 *
 * Useful when the contributor wants to take the change out of review
 * (e.g. to push more commits) without discarding the branch.
 */

import { closePull, getPull, listPulls } from '../dolthub/pulls';
import { makeWlBranch } from './branch';
import type { DoltHubAuth, DoltFetchHooks } from '../dolthub/api';
import type { RigHandle, WastelandRef, WlResult } from './types';
import { WlError } from './types';

export type UnpublishOptions = {
  auth: DoltHubAuth;
  upstream: WastelandRef;
  fork: { forkOwner: string; forkDb: string };
  rigHandle: RigHandle;
  wantedId: string;
  fetch?: typeof fetch;
  hooks?: DoltFetchHooks;
};

export type UnpublishResult = {
  /** Pull id we closed, or empty string if there was nothing to close. */
  pullId: string;
  /** True when this call closed a PR; false when it was already closed/missing. */
  closed: boolean;
};

export async function unpublish(opts: UnpublishOptions): Promise<WlResult<UnpublishResult>> {
  const branchName = makeWlBranch(opts.rigHandle, opts.wantedId);

  try {
    let pulls;
    try {
      pulls = await listPulls({
        auth: opts.auth,
        owner: opts.upstream.owner,
        db: opts.upstream.db,
        state: 'open',
        fetch: opts.fetch,
        hooks: opts.hooks,
      });
    } catch (err) {
      throw new WlError('list pulls failed', 'upstream', err);
    }

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
        detail.from_branch_name === branchName &&
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
        return { ok: true, data: { pullId: detail.pull_id, closed: true } };
      }
    }

    return { ok: true, data: { pullId: '', closed: false } };
  } catch (err) {
    if (err instanceof WlError) return { ok: false, error: err };
    return { ok: false, error: new WlError('unpublish failed', 'upstream', err) };
  }
}
