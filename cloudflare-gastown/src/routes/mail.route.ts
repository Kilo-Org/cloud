import { Hono } from 'hono';
import { z } from 'zod';
import { zodJsonValidator } from '../util/validation.util';
import { resSuccess, resError } from '../util/res.util';
import { authMiddleware, getEnforcedAgentId } from '../middleware/auth.middleware';
import { getRigStubFromContext } from './rig-stub.route';
import type { GastownEnv } from '../gastown.worker';

const SendMailBody = z.object({
  from_agent_id: z.string().min(1),
  to_agent_id: z.string().min(1),
  subject: z.string().min(1),
  body: z.string().min(1),
});

export const mailRoutes = new Hono<GastownEnv>();

mailRoutes.use('/*', authMiddleware);

// POST /api/rigs/:rigId/mail → sendMail
mailRoutes.post('/', zodJsonValidator(SendMailBody), async c => {
  const body = c.req.valid('json');
  const enforced = getEnforcedAgentId(c);
  if (enforced && enforced !== body.from_agent_id) {
    return c.json(resError('from_agent_id does not match authenticated agent'), 403);
  }
  const rig = getRigStubFromContext(c);
  await rig.sendMail(body);
  return c.json(resSuccess({ sent: true }), 201);
});
