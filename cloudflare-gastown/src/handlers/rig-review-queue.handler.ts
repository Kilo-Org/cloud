import type { Context } from 'hono';
import { z } from 'zod';
import { getRigDOStub } from '../dos/Rig.do';
import { resSuccess, resError } from '../util/res.util';
import { parseJsonBody } from '../util/parse-json-body.util';
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
  const parsed = SubmitToReviewQueueBody.safeParse(await parseJsonBody(c));
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

const CompleteReviewBody = z.object({
  status: z.enum(['merged', 'conflict']),
  message: z.string(),
  commit_sha: z.string().optional(),
});

export async function handleCompleteReview(
  c: Context<GastownEnv>,
  params: { rigId: string; entryId: string }
) {
  const parsed = CompleteReviewBody.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }
  const rig = getRigDOStub(c.env, params.rigId);
  await rig.completeReviewWithResult({
    entry_id: params.entryId,
    ...parsed.data,
  });
  return c.json(resSuccess({ completed: true }));
}
