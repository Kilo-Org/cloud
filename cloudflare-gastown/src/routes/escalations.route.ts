import { Hono } from 'hono';
import { z } from 'zod';
import { zodJsonValidator } from '../util/validation.util';
import { resSuccess } from '../util/res.util';
import { authMiddleware } from '../middleware/auth.middleware';
import { getRigStubFromContext } from './rig-stub.route';
import { BeadPriority } from '../types';
import type { GastownEnv } from '../gastown.worker';

const CreateEscalationBody = z.object({
  title: z.string().min(1),
  body: z.string().optional(),
  priority: BeadPriority.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const escalationRoutes = new Hono<GastownEnv>();

escalationRoutes.use('/*', authMiddleware);

// POST /api/rigs/:rigId/escalations → createEscalation
escalationRoutes.post('/', zodJsonValidator(CreateEscalationBody), async c => {
  const body = c.req.valid('json');
  const rig = getRigStubFromContext(c);
  const bead = await rig.createBead({
    type: 'escalation',
    title: body.title,
    body: body.body,
    priority: body.priority,
    metadata: body.metadata,
  });
  return c.json(resSuccess(bead), 201);
});
