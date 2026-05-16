/**
 * `reject` — bounce a completion back to `claimed`.
 *
 * Mirrors `Client.Reject` (`wasteland/internal/sdk/mutations.go:322`).
 *
 * Two statements run: DELETE the completion row, then UPDATE the
 * wanted row's status from `in_review` back to `claimed`.
 */

import { rejectCompletionDML } from '../commons/dml.generated';
import { applyMutation } from './mutate';
import type { MutationContext, MutationOutcome, WlResult } from './types';
import { WlError } from './types';

export type RejectOptions = {
  ctx: MutationContext;
  wantedId: string;
  /** Optional human-readable reason; kept short — the Go reference truncates at 500. */
  reason?: string;
};

export async function reject(opts: RejectOptions): Promise<WlResult<MutationOutcome>> {
  try {
    const stmts = rejectCompletionDML({ wantedId: opts.wantedId });
    const reasonSuffix = opts.reason
      ? ` — ${opts.reason.length > 500 ? `${opts.reason.slice(0, 500)}...` : opts.reason}`
      : '';
    const outcome = await applyMutation({
      ctx: opts.ctx,
      wantedId: opts.wantedId,
      targetStatus: 'claimed',
      statements: stmts,
      commitMessage: `wl reject: ${opts.wantedId}${reasonSuffix}`,
    });
    return { ok: true, data: outcome };
  } catch (err) {
    if (err instanceof WlError) return { ok: false, error: err };
    return { ok: false, error: new WlError('reject failed', 'internal', err) };
  }
}
