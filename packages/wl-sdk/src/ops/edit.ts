/**
 * `edit` — UPDATE an existing wanted item on the caller's fork branch.
 *
 * This targets the same `wl/<rig>/<wantedId>` branch used by post/claim.
 * For branch-only posts with an open PR, callers can follow this with
 * `publish` to update the existing PR.
 */

import { updateWantedDML } from '../commons/dml.generated';
import { applyMutation } from './mutate';
import type { MutationContext, MutationOutcome, WlResult } from './types';
import { WlError } from './types';

export type EditOptions = {
  ctx: MutationContext;
  wantedId: string;
  title?: string;
  description?: string;
  project?: string;
  type?: string;
  priority?: number;
  effortLevel?: string;
  tags?: readonly string[];
};

export async function edit(opts: EditOptions): Promise<WlResult<MutationOutcome>> {
  try {
    const dml = updateWantedDML({
      wantedId: opts.wantedId,
      fields: {
        title: opts.title,
        description: opts.description,
        project: opts.project,
        type: opts.type,
        priority: opts.priority,
        effortLevel: opts.effortLevel,
        tags: opts.tags,
      },
    });
    const outcome = await applyMutation({
      ctx: opts.ctx,
      wantedId: opts.wantedId,
      targetStatus: 'open',
      statements: [dml],
      commitMessage: `wl edit: ${opts.wantedId}`,
      autoCleanup: false,
    });
    return { ok: true, data: outcome };
  } catch (err) {
    if (err instanceof WlError) return { ok: false, error: err };
    return { ok: false, error: new WlError('edit failed', 'internal', err) };
  }
}
