/**
 * `acceptUpstream` — adopt a contributor's open upstream PR submission.
 *
 * This mirrors the canonical `wl accept-upstream` flow: read the selected
 * contributor branch completion, write `AcceptUpstreamDML` on the admin's
 * `wl/<rig>/<wantedId>` branch, then callers publish that branch for the
 * upstream owner to merge.
 */

import { acceptUpstreamDML, type StampInput } from '../commons/dml.generated';
import { CompletionsRowSchema } from '../commons/schema.generated';
import { doltRead } from '../dolthub/read';
import { applyMutation } from './mutate';
import { makeWlBranch } from './branch';
import type { AcceptOutcome, MutationContext, WlResult } from './types';
import { WlError } from './types';

export type AcceptUpstreamOptions = {
  ctx: MutationContext;
  wantedId: string;
  submitterRigHandle: string;
  /**
   * The DoltHub owner of the fork that hosts the submitter's
   * `wl/<submitterRigHandle>/<wantedId>` branch. Required when the
   * submitter's fork is different from `ctx.fork.forkOwner` (i.e. the
   * common cross-fork worker → admin case). Defaults to
   * `ctx.fork.forkOwner` when omitted, which is correct only for the
   * single-fork case.
   */
  submitterForkOwner?: string;
  completionId?: string;
  evidence?: string;
  hopUri?: string;
  stamp: StampInput;
};

export async function acceptUpstream(
  opts: AcceptUpstreamOptions
): Promise<WlResult<AcceptOutcome>> {
  try {
    if (opts.submitterRigHandle === opts.ctx.rigHandle) {
      throw new WlError('cannot issue a stamp to yourself', 'precondition');
    }

    const completion = await resolveSubmitterCompletion(opts);
    const evidence = opts.evidence ?? completion.evidence;
    if (!completion.completed_by) {
      throw new WlError('submission has no completed_by value', 'precondition');
    }
    if (!evidence) {
      throw new WlError('submission has no evidence value', 'precondition');
    }

    const stmts = acceptUpstreamDML({
      wantedId: opts.wantedId,
      completionId: completion.id,
      completedBy: completion.completed_by,
      evidence,
      rigHandle: opts.ctx.rigHandle,
      hopUri: opts.hopUri ?? completion.hop_uri ?? undefined,
      stamp: opts.stamp,
    });
    const outcome = await applyMutation({
      ctx: opts.ctx,
      wantedId: opts.wantedId,
      targetStatus: 'completed',
      statements: stmts,
      commitMessage: `wl accept-upstream: ${opts.wantedId}`,
    });
    return { ok: true, data: { ...outcome, stampId: opts.stamp.id } };
  } catch (err) {
    if (err instanceof WlError) return { ok: false, error: err };
    return { ok: false, error: new WlError('accept-upstream failed', 'internal', err) };
  }
}

async function resolveSubmitterCompletion(opts: AcceptUpstreamOptions) {
  if (opts.completionId && opts.evidence) {
    return {
      id: opts.completionId,
      completed_by: opts.submitterRigHandle,
      evidence: opts.evidence,
      hop_uri: opts.hopUri ?? null,
    };
  }

  // The submitter's `wl/<rig>/<id>` branch lives on the submitter's
  // fork, NOT the admin's fork. Default to `ctx.fork.forkOwner` only
  // for the legacy single-fork case (e.g. admin and submitter share a
  // sandbox fork in tests).
  const submitterForkOwner = opts.submitterForkOwner ?? opts.ctx.fork.forkOwner;
  const branchName = makeWlBranch(opts.submitterRigHandle, opts.wantedId);
  const sql = `SELECT id, wanted_id, completed_by, evidence, validated_by, stamp_id, parent_completion_id, block_hash, hop_uri, completed_at, validated_at FROM completions WHERE wanted_id = '${opts.wantedId.replace(/'/g, "''").replace(/\\/g, '\\\\')}' ORDER BY completed_at DESC LIMIT 1`;
  const res = await doltRead({
    auth: opts.ctx.auth,
    owner: submitterForkOwner,
    db: opts.ctx.fork.forkDb,
    ref: branchName,
    query: sql,
    fetch: opts.ctx.fetch,
    hooks: opts.ctx.hooks,
  });
  if (res.rows.length === 0) {
    throw new WlError(
      `no completion found on ${submitterForkOwner}/${opts.ctx.fork.forkDb}@${branchName}`,
      'precondition'
    );
  }
  const parsed = CompletionsRowSchema.safeParse(res.rows[0]);
  if (!parsed.success) {
    throw new WlError(`completion on ${branchName} has unexpected shape`, 'upstream', parsed.error);
  }
  return parsed.data;
}
