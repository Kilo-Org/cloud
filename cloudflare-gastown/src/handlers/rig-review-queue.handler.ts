import type { Context } from 'hono';
import { z } from 'zod';
import { getRigDOStub } from '../dos/Rig.do';
import { resSuccess, resError } from '../util/res.util';
import { getEnforcedAgentId } from '../middleware/auth.middleware';
import type { GastownEnv } from '../gastown.worker';

const SubmitToReviewQueueBody = z.object({
  agent_id: z.string().min(1),
  bead_id: z.string().min(1),
  branch: z.string().min(1),
  pr_url: z.string().optional(),
  summary: z.string().optional(),
});

export async function handleSubmitToReviewQueue(c: Context<GastownEnv>, params: { rigId: string }) {
  const parsed = SubmitToReviewQueueBody.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }
  const enforced = getEnforcedAgentId(c);
  if (enforced && enforced !== parsed.data.agent_id) {
    return c.json(resError('agent_id does not match authenticated agent'), 403);
  }
  const rig = getRigDOStub(c.env, params.rigId);
  await rig.submitToReviewQueue(parsed.data);
  return c.json(resSuccess({ submitted: true }), 201);
}
