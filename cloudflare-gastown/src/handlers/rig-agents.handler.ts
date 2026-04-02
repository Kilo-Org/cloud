import type { Context } from 'hono';
import { z } from 'zod';
import { getTownDOStub } from '../dos/Town.do';
import { resSuccess, resError } from '../util/res.util';
import { parseJsonBody } from '../util/parse-json-body.util';
import { AgentRole, AgentStatus } from '../types';
import type { GastownEnv } from '../gastown.worker';
import { getEnforcedAgentId } from '../middleware/auth.middleware';

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

const AgentCompletedBody = z.object({
  status: z.enum(['completed', 'failed']),
  reason: z.string().optional(),
});

const WriteCheckpointBody = z.object({
  data: z.unknown(),
});

const UpdateAgentStatusMessageBody = z.object({
  message: z.string().trim().min(1).max(280),
});

export async function handleRegisterAgent(c: Context<GastownEnv>, params: { rigId: string }) {
  const parsed = RegisterAgentBody.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }
  const townId = c.get('townId');
  const town = getTownDOStub(c.env, townId);
  const agent = await town.registerAgent({ ...parsed.data, rig_id: params.rigId });
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

  const townId = c.get('townId');
  const town = getTownDOStub(c.env, townId);
  const agents = await town.listAgents({
    role: role?.data,
    status: status?.data,
    rig_id: params.rigId,
  });
  return c.json(resSuccess(agents));
}

export async function handleGetAgent(
  c: Context<GastownEnv>,
  params: { rigId: string; agentId: string }
) {
  const townId = c.get('townId');
  const town = getTownDOStub(c.env, townId);
  const agent = await town.getAgentAsync(params.agentId);
  if (!agent || agent.rig_id !== params.rigId) return c.json(resError('Agent not found'), 404);
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
  const townId = c.get('townId');
  const town = getTownDOStub(c.env, townId);
  await town.hookBead(params.agentId, parsed.data.bead_id);
  console.log(`${AGENT_LOG} handleHookBead: hooked successfully`);
  return c.json(resSuccess({ hooked: true }));
}

export async function handleUnhookBead(
  c: Context<GastownEnv>,
  params: { rigId: string; agentId: string }
) {
  const townId = c.get('townId');
  const town = getTownDOStub(c.env, townId);
  await town.unhookBead(params.agentId);
  return c.json(resSuccess({ unhooked: true }));
}

export async function handlePrime(
  c: Context<GastownEnv>,
  params: { rigId: string; agentId: string }
) {
  const townId = c.get('townId');
  const town = getTownDOStub(c.env, townId);
  const context = await town.prime(params.agentId);
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
  const townId = c.get('townId');
  const town = getTownDOStub(c.env, townId);
  await town.agentDone(params.agentId, parsed.data);
  return c.json(resSuccess({ done: true }));
}

/**
 * Called by the container when an agent session completes or fails.
 * Transitions the hooked bead to closed/failed and unhooks the agent.
 */
export async function handleAgentCompleted(
  c: Context<GastownEnv>,
  params: { rigId: string; agentId: string }
) {
  const parsed = AgentCompletedBody.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }
  const townId = c.get('townId');
  const town = getTownDOStub(c.env, townId);
  await town.agentCompleted(params.agentId, parsed.data);
  return c.json(resSuccess({ completed: true }));
}

/**
 * Called by the container when the mayor's session goes idle (turn done,
 * waiting for user input). Transitions the mayor from "working" to
 * "waiting" so the alarm drops to the idle cadence and health-check
 * pings stop resetting the container's sleepAfter timer.
 */
export async function handleAgentWaiting(
  c: Context<GastownEnv>,
  params: { rigId: string; agentId: string }
) {
  const body = (await parseJsonBody(c)) as Record<string, unknown>;
  const firedAt = typeof body?.firedAt === 'number' ? body.firedAt : undefined;
  const townId = c.get('townId');
  const town = getTownDOStub(c.env, townId);
  await town.mayorWaiting(params.agentId, firedAt);
  return c.json(resSuccess({ acknowledged: true }));
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
  const townId = c.get('townId');
  const town = getTownDOStub(c.env, townId);
  await town.writeCheckpoint(params.agentId, parsed.data.data);
  return c.json(resSuccess({ written: true }));
}

const EvictionContextBody = z.object({
  branch: z.string(),
  agent_name: z.string(),
  saved_at: z.string(),
});

export async function handleWriteEvictionContext(
  c: Context<GastownEnv>,
  params: { rigId: string; agentId: string }
) {
  const parsed = EvictionContextBody.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }
  const townId = c.get('townId');
  const town = getTownDOStub(c.env, townId);
  await town.writeBeadEvictionContext(params.agentId, parsed.data);
  return c.json(resSuccess({ written: true }));
}

export async function handleCheckMail(
  c: Context<GastownEnv>,
  params: { rigId: string; agentId: string }
) {
  const townId = c.get('townId');
  const town = getTownDOStub(c.env, townId);
  const messages = await town.checkMail(params.agentId);
  return c.json(resSuccess(messages));
}

const HeartbeatWatermark = z
  .object({
    lastEventType: z.string().nullable().optional(),
    lastEventAt: z.string().nullable().optional(),
    activeTools: z.array(z.string()).optional(),
    containerInstanceId: z.string().optional(),
  })
  .passthrough();

/**
 * Heartbeat endpoint called by the container's heartbeat reporter.
 * Updates the agent's last_activity_at timestamp and SDK activity
 * watermark in the Town DO's agent_metadata.
 */
export async function handleHeartbeat(
  c: Context<GastownEnv>,
  params: { rigId: string; agentId: string }
) {
  const townId = c.get('townId');
  const town = getTownDOStub(c.env, townId);

  // Parse watermark from body (best-effort — old containers send no body)
  let watermark: z.infer<typeof HeartbeatWatermark> | undefined;
  try {
    const body: unknown = await c.req.json();
    const parsed = HeartbeatWatermark.safeParse(body);
    if (parsed.success) {
      watermark = parsed.data;
    }
  } catch {
    // No body or invalid JSON — old container format, just touch
  }

  // touchAgentHeartbeat returns the drain nonce atomically — no
  // second RPC needed, which prevents a TOCTOU race where an
  // in-flight heartbeat from the old container could observe a nonce
  // generated between two separate DO calls.
  const { drainNonce } = await town.touchAgentHeartbeat(
    params.agentId,
    watermark
      ? {
          lastEventType: watermark.lastEventType ?? null,
          lastEventAt: watermark.lastEventAt ?? null,
          activeTools: watermark.activeTools,
          containerInstanceId: watermark.containerInstanceId,
        }
      : undefined
  );

  return c.json(resSuccess({ heartbeat: true, ...(drainNonce ? { drainNonce } : {}) }));
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
  const townId = c.get('townId');
  const town = getTownDOStub(c.env, townId);
  const agent = await town.getOrCreateAgent(parsed.data.role, params.rigId);
  console.log(`${AGENT_LOG} handleGetOrCreateAgent: result=${JSON.stringify(agent).slice(0, 200)}`);
  return c.json(resSuccess(agent));
}

export async function handleUpdateAgentStatusMessage(
  c: Context<GastownEnv>,
  params: { rigId: string; agentId: string }
) {
  const parsed = UpdateAgentStatusMessageBody.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }
  const townId = c.get('townId');
  const town = getTownDOStub(c.env, townId);
  await town.updateAgentStatusMessage(params.agentId, parsed.data.message);
  return c.json(resSuccess({ ok: true }));
}

export async function handleDeleteAgent(
  c: Context<GastownEnv>,
  params: { rigId: string; agentId: string }
) {
  const townId = c.get('townId');
  const town = getTownDOStub(c.env, townId);
  const agent = await town.getAgentAsync(params.agentId);
  if (!agent || agent.rig_id !== params.rigId) return c.json(resError('Agent not found'), 404);
  await town.deleteAgent(params.agentId);
  return c.json(resSuccess({ deleted: true }));
}

/**
 * Returns undelivered, non-expired nudges for the agent.
 * Called by the container's process-manager when the agent goes idle.
 */
export async function handleGetPendingNudges(
  c: Context<GastownEnv>,
  params: { rigId: string; agentId: string }
) {
  const townId = c.get('townId');
  const town = getTownDOStub(c.env, townId);
  const nudges = await town.getPendingNudges(params.agentId);
  return c.json(resSuccess(nudges));
}

const QueueNudgeBody = z.object({
  target_agent_id: z.string().min(1),
  message: z.string().min(1),
  mode: z.enum(['wait-idle', 'immediate', 'queue']).optional(),
});

const NudgeDeliveredBody = z.object({
  nudge_id: z.string().min(1),
});

/**
 * Agent-facing endpoint: queues a nudge from one agent to another.
 * The requesting agent's identity is taken from the auth token.
 */
export async function handleNudge(c: Context<GastownEnv>, params: { rigId: string }) {
  const parsed = QueueNudgeBody.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }
  const sourceAgentId = getEnforcedAgentId(c) ?? 'unknown';
  console.log(
    `${AGENT_LOG} handleNudge: rigId=${params.rigId} from=${sourceAgentId} target=${parsed.data.target_agent_id}`
  );
  const townId = c.get('townId');
  const town = getTownDOStub(c.env, townId);
  const nudgeId = await town.queueNudge(parsed.data.target_agent_id, parsed.data.message, {
    mode: parsed.data.mode,
    source: 'agent',
  });
  return c.json(resSuccess({ nudge_id: nudgeId }));
}

/**
 * Marks a nudge as delivered after the container has injected it into the agent.
 */
export async function handleNudgeDelivered(
  c: Context<GastownEnv>,
  _params: { rigId: string; agentId: string }
) {
  const parsed = NudgeDeliveredBody.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }
  const townId = c.get('townId');
  const town = getTownDOStub(c.env, townId);
  await town.markNudgeDelivered(parsed.data.nudge_id);
  return c.json(resSuccess({ marked: true }));
}

// ── Request Changes ──────────────────────────────────────────────────

const RequestChangesBody = z.object({
  feedback: z.string().min(1, 'Feedback is required'),
  files: z.array(z.string()).optional(),
});

/**
 * Refinery requests changes on an in-progress MR. Creates a rework bead
 * that blocks the MR bead. The reconciler assigns a polecat to the rework
 * bead; when it closes, the MR unblocks for re-review.
 */
export async function handleRequestChanges(
  c: Context<GastownEnv>,
  params: { rigId: string; agentId: string }
) {
  const parsed = RequestChangesBody.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }
  const townId = c.get('townId');
  const town = getTownDOStub(c.env, townId);
  const result = await town.requestChanges(params.agentId, parsed.data);
  return c.json(resSuccess(result), 201);
}
