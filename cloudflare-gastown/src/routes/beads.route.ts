import { Hono } from 'hono';
import { z } from 'zod';
import { zodJsonValidator } from '../util/validation.util';
import { resSuccess, resError } from '../util/res.util';
import { authMiddleware } from '../middleware/auth.middleware';
import { getRigStubFromContext } from './rig-stub.route';
import { BeadType, BeadPriority, BeadStatus } from '../types';
import type { GastownEnv } from '../gastown.worker';

const CreateBeadBody = z.object({
  type: BeadType,
  title: z.string().min(1),
  body: z.string().optional(),
  priority: BeadPriority.optional(),
  labels: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  assignee_agent_id: z.string().optional(),
  convoy_id: z.string().optional(),
});

const UpdateBeadStatusBody = z.object({
  status: BeadStatus,
  agent_id: z.string().min(1),
});

const CloseBeadBody = z.object({
  agent_id: z.string().min(1),
});

export const beadRoutes = new Hono<GastownEnv>();

beadRoutes.use('/*', authMiddleware);

// POST /api/rigs/:rigId/beads → createBead
beadRoutes.post('/', zodJsonValidator(CreateBeadBody), async c => {
  const body = c.req.valid('json');
  const rig = getRigStubFromContext(c);
  const bead = await rig.createBead(body);
  return c.json(resSuccess(bead), 201);
});

// GET /api/rigs/:rigId/beads → listBeads
beadRoutes.get('/', async c => {
  const rig = getRigStubFromContext(c);
  const filter = {
    status: c.req.query('status') as z.infer<typeof BeadStatus> | undefined,
    type: c.req.query('type') as z.infer<typeof BeadType> | undefined,
    assignee_agent_id: c.req.query('assignee_agent_id'),
    convoy_id: c.req.query('convoy_id'),
    limit: c.req.query('limit') ? Number(c.req.query('limit')) : undefined,
    offset: c.req.query('offset') ? Number(c.req.query('offset')) : undefined,
  };
  const beads = await rig.listBeads(filter);
  return c.json(resSuccess(beads));
});

// GET /api/rigs/:rigId/beads/:beadId → getBead
beadRoutes.get('/:beadId', async c => {
  const rig = getRigStubFromContext(c);
  const bead = await rig.getBeadAsync(c.req.param('beadId'));
  if (!bead) return c.json(resError('Bead not found'), 404);
  return c.json(resSuccess(bead));
});

// PATCH /api/rigs/:rigId/beads/:beadId/status → updateBeadStatus
beadRoutes.patch('/:beadId/status', zodJsonValidator(UpdateBeadStatusBody), async c => {
  const body = c.req.valid('json');
  const rig = getRigStubFromContext(c);
  const bead = await rig.updateBeadStatus(c.req.param('beadId'), body.status, body.agent_id);
  return c.json(resSuccess(bead));
});

// POST /api/rigs/:rigId/beads/:beadId/close → closeBead
beadRoutes.post('/:beadId/close', zodJsonValidator(CloseBeadBody), async c => {
  const body = c.req.valid('json');
  const rig = getRigStubFromContext(c);
  const bead = await rig.closeBead(c.req.param('beadId'), body.agent_id);
  return c.json(resSuccess(bead));
});
