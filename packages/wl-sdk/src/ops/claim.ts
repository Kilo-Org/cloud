/**
 * `claim` — claim a wanted item for the current rig.
 *
 * Mirrors `Client.Claim` (`wasteland/internal/sdk/mutations.go:39`).
 */

import { claimWantedDML } from '../commons/dml.generated';
import { applyMutation } from './mutate';
import type { MutationContext, MutationOutcome, WlResult } from './types';
import { WlError } from './types';

export type ClaimOptions = {
  ctx: MutationContext;
  wantedId: string;
};

export async function claim(opts: ClaimOptions): Promise<WlResult<MutationOutcome>> {
  try {
    const dml = claimWantedDML({ wantedId: opts.wantedId, rigHandle: opts.ctx.rigHandle });
    const outcome = await applyMutation({
      ctx: opts.ctx,
      wantedId: opts.wantedId,
      targetStatus: 'claimed',
      statements: [dml],
      commitMessage: `wl claim: ${opts.wantedId}`,
    });
    return { ok: true, data: outcome };
  } catch (err) {
    if (err instanceof WlError) return { ok: false, error: err };
    return { ok: false, error: new WlError('claim failed', 'internal', err) };
  }
}
