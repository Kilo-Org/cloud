import { Hono } from 'hono';
import { z } from 'zod';
import { zodJsonValidator } from '../util/validation.util';
import { resSuccess, resError } from '../util/res.util';
import { authMiddleware, agentOnlyMiddleware } from '../middleware/auth.middleware';
import { getRigStubFromContext } from './rig-stub.route';
import { AgentRole, AgentStatus } from '../types';
import type { GastownEnv } from '../gastown.worker';

const RegisterAgentBody = z.object({
  role: AgentRole,
  name: z.string().min(1),
  identity: z.string().min(1),
});

const HookBeadBody = z.object({
  bead_id: z.string().min(1),
});

const AgentDoneBody = z.object({
  branch: z.string().min(1),
  pr_url: z.string().optional(),
  summary: z.string().optional(),
});

const WriteCheckpointBody = z.object({
  data: z.unknown(),
});

export const agentRoutes = new Hono<GastownEnv>();

agentRoutes.use('/*', authMiddleware);

// POST /api/rigs/:rigId/agents → registerAgent
agentRoutes.post('/', zodJsonValidator(RegisterAgentBody), async c => {
  const body = c.req.valid('json');
  const rig = getRigStubFromContext(c);
  const agent = await rig.registerAgent(body);
  return c.json(resSuccess(agent), 201);
});

// GET /api/rigs/:rigId/agents → listAgents
agentRoutes.get('/', async c => {
  const rig = getRigStubFromContext(c);
  const filter = {
    role: c.req.query('role') as z.infer<typeof AgentRole> | undefined,
    status: c.req.query('status') as z.infer<typeof AgentStatus> | undefined,
  };
  const agents = await rig.listAgents(filter);
  return c.json(resSuccess(agents));
});

// GET /api/rigs/:rigId/agents/:agentId → getAgent
agentRoutes.get('/:agentId', async c => {
  const rig = getRigStubFromContext(c);
  const agent = await rig.getAgentAsync(c.req.param('agentId'));
  if (!agent) return c.json(resError('Agent not found'), 404);
  return c.json(resSuccess(agent));
});

// POST /api/rigs/:rigId/agents/:agentId/hook → hookBead
agentRoutes.post('/:agentId/hook', agentOnlyMiddleware, zodJsonValidator(HookBeadBody), async c => {
  const body = c.req.valid('json');
  const rig = getRigStubFromContext(c);
  await rig.hookBead(c.req.param('agentId'), body.bead_id);
  return c.json(resSuccess({ hooked: true }));
});

// DELETE /api/rigs/:rigId/agents/:agentId/hook → unhookBead
agentRoutes.delete('/:agentId/hook', agentOnlyMiddleware, async c => {
  const rig = getRigStubFromContext(c);
  await rig.unhookBead(c.req.param('agentId'));
  return c.json(resSuccess({ unhooked: true }));
});

// GET /api/rigs/:rigId/agents/:agentId/prime → prime
agentRoutes.get('/:agentId/prime', agentOnlyMiddleware, async c => {
  const rig = getRigStubFromContext(c);
  const context = await rig.prime(c.req.param('agentId'));
  return c.json(resSuccess(context));
});

// POST /api/rigs/:rigId/agents/:agentId/done → agentDone
agentRoutes.post(
  '/:agentId/done',
  agentOnlyMiddleware,
  zodJsonValidator(AgentDoneBody),
  async c => {
    const body = c.req.valid('json');
    const rig = getRigStubFromContext(c);
    await rig.agentDone(c.req.param('agentId'), body);
    return c.json(resSuccess({ done: true }));
  }
);

// POST /api/rigs/:rigId/agents/:agentId/checkpoint → writeCheckpoint
agentRoutes.post(
  '/:agentId/checkpoint',
  agentOnlyMiddleware,
  zodJsonValidator(WriteCheckpointBody),
  async c => {
    const body = c.req.valid('json');
    const rig = getRigStubFromContext(c);
    await rig.writeCheckpoint(c.req.param('agentId'), body.data);
    return c.json(resSuccess({ written: true }));
  }
);

// GET /api/rigs/:rigId/agents/:agentId/mail → checkMail
agentRoutes.get('/:agentId/mail', agentOnlyMiddleware, async c => {
  const rig = getRigStubFromContext(c);
  const messages = await rig.checkMail(c.req.param('agentId'));
  return c.json(resSuccess(messages));
});
