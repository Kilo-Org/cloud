/**
 * `post` — INSERT a new wanted item on a fresh `wl/<rig>/<id>` branch.
 *
 * Mirrors `Client.Post` (`wasteland/internal/sdk/mutations.go:378`).
 *
 * Differences from the Go reference:
 *  - The wl-sdk does not own ID generation. Callers pass `wantedId`
 *    explicitly. (Web/CLI callers should use a stable hash-of-title
 *    convention; see `commons.GenerateWantedID` in Go for the format.)
 *  - Auto-cleanup is disabled because a fresh post never matches
 *    upstream main (the row only exists on the branch).
 */

import { insertWantedDML, formatNowUtc } from '../commons/dml.generated';
import { applyMutation } from './mutate';
import type { MutationContext, PostOutcome, WlResult } from './types';
import { WlError } from './types';

export type PostOptions = {
  ctx: MutationContext;
  /** Caller-generated wanted id. */
  wantedId: string;
  title: string;
  description?: string;
  project?: string;
  type?: string;
  /** Numeric priority (0..3). See `commons/dml.generated.ts`. */
  priority?: number;
  effortLevel?: string;
  tags?: readonly string[];
};

export async function post(opts: PostOptions): Promise<WlResult<PostOutcome>> {
  try {
    const now = (opts.ctx.now ?? (() => new Date()))();
    const dml = insertWantedDML({
      id: opts.wantedId,
      title: opts.title,
      description: opts.description,
      project: opts.project,
      type: opts.type,
      priority: opts.priority,
      tags: opts.tags,
      postedBy: opts.ctx.rigHandle,
      effortLevel: opts.effortLevel,
      now: formatNowUtc(now),
    });
    const outcome = await applyMutation({
      ctx: opts.ctx,
      wantedId: opts.wantedId,
      // A new INSERT lands at status='open'.
      targetStatus: 'open',
      statements: [dml],
      commitMessage: `wl post: ${opts.wantedId}`,
      // Brand-new items don't exist on main, so cleanup would
      // misfire (treating absence-on-main as "match" via
      // `wantedRowsEquivalent` returning false → no cleanup
      // anyway, but disable explicitly for clarity).
      autoCleanup: false,
    });
    return { ok: true, data: { ...outcome, wantedId: opts.wantedId } };
  } catch (err) {
    if (err instanceof WlError) return { ok: false, error: err };
    return { ok: false, error: new WlError('post failed', 'internal', err) };
  }
}
