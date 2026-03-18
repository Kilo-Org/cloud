import type { Context } from 'hono';
import { z } from 'zod';
import { getTownDOStub } from '../dos/Town.do';
import { resSuccess, resError } from '../util/res.util';
import { parseJsonBody } from '../util/parse-json-body.util';
import { DependencyType } from '../db/tables/bead-dependencies.table';
import type { GastownEnv } from '../gastown.worker';

const AddDependencyBody = z.object({
  depends_on_bead_id: z.string().min(1),
  dependency_type: DependencyType.optional().default('blocks'),
});

/**
 * POST /api/towns/:townId/rigs/:rigId/beads/:beadId/dependencies
 * Add a dependency edge between two beads.
 */
export async function handleAddBeadDependency(
  c: Context<GastownEnv>,
  params: { townId: string; beadId: string }
) {
  const parsed = AddDependencyBody.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }

  const town = getTownDOStub(c.env, params.townId);
  try {
    await town.addBeadDependency(
      params.beadId,
      parsed.data.depends_on_bead_id,
      parsed.data.dependency_type
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json(resError(message), 400);
  }

  return c.json(resSuccess({ ok: true }));
}

/**
 * DELETE /api/towns/:townId/rigs/:rigId/beads/:beadId/dependencies/:dependsOnBeadId
 * Remove a dependency edge between two beads.
 */
export async function handleRemoveBeadDependency(
  c: Context<GastownEnv>,
  params: { townId: string; beadId: string; dependsOnBeadId: string }
) {
  const town = getTownDOStub(c.env, params.townId);
  const deleted = await town.removeBeadDependency(params.beadId, params.dependsOnBeadId);

  return c.json(resSuccess({ ok: true, deleted }));
}
