import { inArray } from 'drizzle-orm';
import { model_experiment } from '@kilocode/db/schema';
import { readDb } from '@/lib/drizzle';

/**
 * Returns the subset of `publicIds` that are reserved by a model experiment.
 *
 * Per `.specs/model-experiments.md`, a model-experiment `public_model_id` is a
 * dedicated preview/experiment id that users must explicitly select; it MUST
 * NOT enter `kilo-auto` candidate sets or any other automatic selection path.
 * Ownership is independent of the experiment's current status, so this checks
 * every status (`draft`, `active`, `paused`, `completed`) — not just the
 * routing-relevant ones in the Redis membership hot-path (`isPublicIdExperimented`).
 *
 * Server-only (drizzle dependency); do not import from client-reachable modules.
 */
export async function findExperimentReservedModelIds(publicIds: string[]): Promise<string[]> {
  if (publicIds.length === 0) return [];
  const rows = await readDb
    .selectDistinct({ publicModelId: model_experiment.public_model_id })
    .from(model_experiment)
    .where(inArray(model_experiment.public_model_id, publicIds));
  return rows.map(r => r.publicModelId);
}
