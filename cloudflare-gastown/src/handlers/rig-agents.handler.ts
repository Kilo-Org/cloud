import type { Context } from 'hono';
import { z } from 'zod';
import { getRigDOStub } from '../dos/Rig.do';
import { resSuccess, resError } from '../util/res.util';
import { parseJsonBody } from '../util/parse-json-body.util';
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

export async function handleRegisterAgent(c: Context<GastownEnv>, params: { rigId: string }) {
  const parsed = RegisterAgentBody.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }
  const rig = getRigDOStub(c.env, params.rigId);
  const agent = await rig.registerAgent(parsed.data);
  return c.json(resSuccess(agent), 201);
}

export async function handleListAgents(c: Context<GastownEnv>, params: { rigId: string }) {
  const roleRaw = c.req.query('role');
  const statusRaw = c.req.query('status');
  const role = roleRaw !== undefined ? AgentRole.safeParse(roleRaw) : undefined;
  const status = statusRaw !== undefined ? AgentStatus.safeParse(statusRaw) : undefined;
  if ((role && !role.success) || (status && !status.success)) {
    return c.json(resError('Invalid role or status filter'), 400);
  }

  const rig = getRigDOStub(c.env, params.rigId);
  const agents = await rig.listAgents({
    role: role?.data,
    status: status?.data,
  });
  return c.json(resSuccess(agents));
}

export async function handleGetAgent(
  c: Context<GastownEnv>,
  params: { rigId: string; agentId: string }
) {
  const rig = getRigDOStub(c.env, params.rigId);
  const agent = await rig.getAgentAsync(params.agentId);
  if (!agent) return c.json(resError('Agent not found'), 404);
  return c.json(resSuccess(agent));
}

export async function handleHookBead(
  c: Context<GastownEnv>,
  params: { rigId: string; agentId: string }
) {
  const parsed = HookBeadBody.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }
  const rig = getRigDOStub(c.env, params.rigId);
  await rig.hookBead(params.agentId, parsed.data.bead_id);
  return c.json(resSuccess({ hooked: true }));
}

export async function handleUnhookBead(
  c: Context<GastownEnv>,
  params: { rigId: string; agentId: string }
) {
  const rig = getRigDOStub(c.env, params.rigId);
  await rig.unhookBead(params.agentId);
  return c.json(resSuccess({ unhooked: true }));
}

export async function handlePrime(
  c: Context<GastownEnv>,
  params: { rigId: string; agentId: string }
) {
  const rig = getRigDOStub(c.env, params.rigId);
  const context = await rig.prime(params.agentId);
  return c.json(resSuccess(context));
}

export async function handleAgentDone(
  c: Context<GastownEnv>,
  params: { rigId: string; agentId: string }
) {
  const parsed = AgentDoneBody.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }
  const rig = getRigDOStub(c.env, params.rigId);
  await rig.agentDone(params.agentId, parsed.data);
  return c.json(resSuccess({ done: true }));
}

export async function handleWriteCheckpoint(
  c: Context<GastownEnv>,
  params: { rigId: string; agentId: string }
) {
  const parsed = WriteCheckpointBody.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }
  const rig = getRigDOStub(c.env, params.rigId);
  await rig.writeCheckpoint(params.agentId, parsed.data.data);
  return c.json(resSuccess({ written: true }));
}

export async function handleCheckMail(
  c: Context<GastownEnv>,
  params: { rigId: string; agentId: string }
) {
  const rig = getRigDOStub(c.env, params.rigId);
  const messages = await rig.checkMail(params.agentId);
  return c.json(resSuccess(messages));
}

/**
 * Heartbeat endpoint called by the container's heartbeat reporter.
 * Updates the agent's last_activity_at timestamp in the Rig DO.
 */
export async function handleHeartbeat(
  c: Context<GastownEnv>,
  params: { rigId: string; agentId: string }
) {
  const rig = getRigDOStub(c.env, params.rigId);
  await rig.touchAgentHeartbeat(params.agentId);
  return c.json(resSuccess({ heartbeat: true }));
}
