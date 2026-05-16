/**
 * `close` — mark an `in_review` item as `completed` without issuing a
 * stamp.
 *
 * Mirrors `Client.Close` (`wasteland/internal/sdk/mutations.go:338`).
 */

import { closeWantedDML } from '../commons/dml.generated';
import { applyMutation } from './mutate';
import type { MutationContext, MutationOutcome, WlResult } from './types';
import { WlError } from './types';

export type CloseOptions = {
  ctx: MutationContext;
  wantedId: string;
};

export async function close(opts: CloseOptions): Promise<WlResult<MutationOutcome>> {
  try {
    const dml = closeWantedDML({ wantedId: opts.wantedId });
    const outcome = await applyMutation({
      ctx: opts.ctx,
      wantedId: opts.wantedId,
      targetStatus: 'completed',
      statements: [dml],
      commitMessage: `wl close: ${opts.wantedId}`,
    });
    return { ok: true, data: outcome };
  } catch (err) {
    if (err instanceof WlError) return { ok: false, error: err };
    return { ok: false, error: new WlError('close failed', 'internal', err) };
  }
}
