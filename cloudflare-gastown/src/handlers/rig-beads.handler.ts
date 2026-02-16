import type { Context } from 'hono';
import { z } from 'zod';
import { getRigDOStub } from '../dos/Rig.do';
import { resSuccess, resError } from '../util/res.util';
import { parseJsonBody } from '../util/parse-json-body.util';
import { getEnforcedAgentId } from '../middleware/auth.middleware';
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

const NonNegativeInt = z.coerce.number().int().nonnegative();

export async function handleCreateBead(c: Context<GastownEnv>, params: { rigId: string }) {
  const parsed = CreateBeadBody.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }
  const rig = getRigDOStub(c.env, params.rigId);
  const bead = await rig.createBead(parsed.data);
  return c.json(resSuccess(bead), 201);
}

export async function handleListBeads(c: Context<GastownEnv>, params: { rigId: string }) {
  const limitRaw = c.req.query('limit');
  const offsetRaw = c.req.query('offset');
  const limit = limitRaw !== undefined ? NonNegativeInt.safeParse(limitRaw) : undefined;
  const offset = offsetRaw !== undefined ? NonNegativeInt.safeParse(offsetRaw) : undefined;
  if ((limit && !limit.success) || (offset && !offset.success)) {
    return c.json(resError('limit and offset must be non-negative integers'), 400);
  }

  const statusRaw = c.req.query('status');
  const typeRaw = c.req.query('type');
  const status = statusRaw !== undefined ? BeadStatus.safeParse(statusRaw) : undefined;
  const type = typeRaw !== undefined ? BeadType.safeParse(typeRaw) : undefined;
  if ((status && !status.success) || (type && !type.success)) {
    return c.json(resError('Invalid status or type filter'), 400);
  }

  const rig = getRigDOStub(c.env, params.rigId);
  const beads = await rig.listBeads({
    status: status?.data,
    type: type?.data,
    assignee_agent_id: c.req.query('assignee_agent_id'),
    convoy_id: c.req.query('convoy_id'),
    limit: limit?.data,
    offset: offset?.data,
  });
  return c.json(resSuccess(beads));
}

export async function handleGetBead(
  c: Context<GastownEnv>,
  params: { rigId: string; beadId: string }
) {
  const rig = getRigDOStub(c.env, params.rigId);
  const bead = await rig.getBeadAsync(params.beadId);
  if (!bead) return c.json(resError('Bead not found'), 404);
  return c.json(resSuccess(bead));
}

export async function handleUpdateBeadStatus(
  c: Context<GastownEnv>,
  params: { rigId: string; beadId: string }
) {
  const parsed = UpdateBeadStatusBody.safeParse(await parseJsonBody(c));
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
  const bead = await rig.updateBeadStatus(params.beadId, parsed.data.status, parsed.data.agent_id);
  return c.json(resSuccess(bead));
}

export async function handleCloseBead(
  c: Context<GastownEnv>,
  params: { rigId: string; beadId: string }
) {
  const parsed = CloseBeadBody.safeParse(await parseJsonBody(c));
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
  const bead = await rig.closeBead(params.beadId, parsed.data.agent_id);
  return c.json(resSuccess(bead));
}
