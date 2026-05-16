/**
 * `unclaim` — release a previously-claimed wanted item back to `open`.
 *
 * Mirrors `Client.Unclaim` (`wasteland/internal/sdk/mutations.go:48`).
 *
 * The interesting case is "claim then unclaim with no other state":
 * after the unclaim the branch's wanted row matches upstream `main`
 * exactly, so {@link applyMutation}'s auto-cleanup fires and the
 * branch is deleted.
 */

import { unclaimWantedDML } from '../commons/dml.generated';
import { applyMutation } from './mutate';
import type { MutationContext, MutationOutcome, WlResult } from './types';
import { WlError } from './types';

export type UnclaimOptions = {
  ctx: MutationContext;
  wantedId: string;
};

export async function unclaim(opts: UnclaimOptions): Promise<WlResult<MutationOutcome>> {
  try {
    const dml = unclaimWantedDML({ wantedId: opts.wantedId });
    const outcome = await applyMutation({
      ctx: opts.ctx,
      wantedId: opts.wantedId,
      targetStatus: 'open',
      statements: [dml],
      commitMessage: `wl unclaim: ${opts.wantedId}`,
    });
    return { ok: true, data: outcome };
  } catch (err) {
    if (err instanceof WlError) return { ok: false, error: err };
    return { ok: false, error: new WlError('unclaim failed', 'internal', err) };
  }
}
