/**
 * `accept` — validate a completion: insert a stamp, mark the
 * completion validated, and flip the wanted row to `completed`.
 *
 * Mirrors `Client.Accept` (`wasteland/internal/sdk/mutations.go:67`).
 *
 * The Go reference does a self-stamp guard (a rig cannot stamp its
 * own completion) plus a server-side completion lookup. The wl-sdk
 * pushes both responsibilities to the caller — they pass the
 * completion id explicitly — because querying the completion would
 * require extra DoltHub round-trips. The caller is the right place
 * for the self-stamp policy decision anyway.
 *
 * Three statements run in order: INSERT stamp, UPDATE completion,
 * UPDATE wanted. {@link applyMutation} fans them across three writes
 * on the same branch.
 */

import { acceptCompletionDML, type StampInput } from '../commons/dml.generated';
import { applyMutation } from './mutate';
import type { AcceptOutcome, MutationContext, WlResult } from './types';
import { WlError } from './types';

export type AcceptOptions = {
  ctx: MutationContext;
  wantedId: string;
  completionId: string;
  /** Optional hop URI for the stamp. */
  hopUri?: string;
  stamp: StampInput;
};

export async function accept(opts: AcceptOptions): Promise<WlResult<AcceptOutcome>> {
  try {
    const stmts = acceptCompletionDML({
      wantedId: opts.wantedId,
      completionId: opts.completionId,
      rigHandle: opts.ctx.rigHandle,
      hopUri: opts.hopUri,
      stamp: opts.stamp,
    });
    const outcome = await applyMutation({
      ctx: opts.ctx,
      wantedId: opts.wantedId,
      targetStatus: 'completed',
      statements: stmts,
      commitMessage: `wl accept: ${opts.wantedId}`,
    });
    return { ok: true, data: { ...outcome, stampId: opts.stamp.id } };
  } catch (err) {
    if (err instanceof WlError) return { ok: false, error: err };
    return { ok: false, error: new WlError('accept failed', 'internal', err) };
  }
}
