import type { Context } from 'hono';
import { z } from 'zod';
import { getRigDOStub } from '../dos/Rig.do';
import { resSuccess, resError } from '../util/res.util';
import { parseJsonBody } from '../util/parse-json-body.util';
import { AgentRole, AgentStatus } from '../types';
import type { GastownEnv } from '../gastown.worker';

const AGENT_LOG = '[rig-agents.handler]';

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
    console.error(`${AGENT_LOG} handleHookBead: invalid body`, parsed.error.issues);
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }
  console.log(
    `${AGENT_LOG} handleHookBead: rigId=${params.rigId} agentId=${params.agentId} beadId=${parsed.data.bead_id}`
  );
  const rig = getRigDOStub(c.env, params.rigId);
  await rig.hookBead(params.agentId, parsed.data.bead_id);
  console.log(`${AGENT_LOG} handleHookBead: hooked successfully`);
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

const GetOrCreateAgentBody = z.object({
  role: AgentRole,
});

/**
 * Atomically get an existing agent of the given role (idle preferred) or create one.
 * Prevents duplicate agent creation from concurrent calls.
 */
export async function handleGetOrCreateAgent(c: Context<GastownEnv>, params: { rigId: string }) {
  const parsed = GetOrCreateAgentBody.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    console.error(`${AGENT_LOG} handleGetOrCreateAgent: invalid body`, parsed.error.issues);
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }
  console.log(
    `${AGENT_LOG} handleGetOrCreateAgent: rigId=${params.rigId} role=${parsed.data.role}`
  );
  const rig = getRigDOStub(c.env, params.rigId);
  const agent = await rig.getOrCreateAgent(parsed.data.role);
  console.log(`${AGENT_LOG} handleGetOrCreateAgent: result=${JSON.stringify(agent).slice(0, 200)}`);
  return c.json(resSuccess(agent));
}

export async function handleDeleteAgent(
  c: Context<GastownEnv>,
  params: { rigId: string; agentId: string }
) {
  const rig = getRigDOStub(c.env, params.rigId);
  const deleted = await rig.deleteAgent(params.agentId);
  if (!deleted) return c.json(resError('Agent not found'), 404);
  return c.json(resSuccess({ deleted: true }));
}
