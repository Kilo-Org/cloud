import { Hono } from 'hono';
import { z } from 'zod';
import { zodJsonValidator } from '../util/validation.util';
import { resSuccess, resError } from '../util/res.util';
import { authMiddleware, getEnforcedAgentId } from '../middleware/auth.middleware';
import { getRigStubFromContext } from './rig-stub.route';
import type { GastownEnv } from '../gastown.worker';

const SubmitToReviewQueueBody = z.object({
  agent_id: z.string().min(1),
  bead_id: z.string().min(1),
  branch: z.string().min(1),
  pr_url: z.string().optional(),
  summary: z.string().optional(),
});

export const reviewQueueRoutes = new Hono<GastownEnv>();

reviewQueueRoutes.use('/*', authMiddleware);

// POST /api/rigs/:rigId/review-queue → submitToReviewQueue
reviewQueueRoutes.post('/', zodJsonValidator(SubmitToReviewQueueBody), async c => {
  const body = c.req.valid('json');
  const enforced = getEnforcedAgentId(c);
  if (enforced && enforced !== body.agent_id) {
    return c.json(resError('agent_id does not match authenticated agent'), 403);
  }
  const rig = getRigStubFromContext(c);
  await rig.submitToReviewQueue(body);
  return c.json(resSuccess({ submitted: true }), 201);
});
