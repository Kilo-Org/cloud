import type { Context } from 'hono';
import { z } from 'zod';
import { getTownDOStub } from '../dos/Town.do';
import { resSuccess, resError } from '../util/res.util';
import { parseJsonBody } from '../util/parse-json-body.util';
import { getEnforcedAgentId, getTownId } from '../middleware/auth.middleware';
import { BeadType, BeadPriority, BeadStatus } from '../types';
import type { GastownEnv } from '../gastown.worker';

const HANDLER_LOG = '[rig-beads.handler]';

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
    console.error(`${HANDLER_LOG} handleCreateBead: invalid body`, parsed.error.issues);
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }
  console.log(
    `${HANDLER_LOG} handleCreateBead: rigId=${params.rigId} type=${parsed.data.type} title="${parsed.data.title?.slice(0, 80)}" assignee=${parsed.data.assignee_agent_id ?? 'none'}`
  );
  const townId = getTownId(c);
  if (!townId) return c.json(resError('Missing townId'), 400);
  const town = getTownDOStub(c.env, townId);
  const bead = await town.createBead(parsed.data);
  console.log(
    `${HANDLER_LOG} handleCreateBead: created bead ${JSON.stringify(bead).slice(0, 200)}`
  );
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

  const townId = getTownId(c);
  if (!townId) return c.json(resError('Missing townId'), 400);
  const town = getTownDOStub(c.env, townId);
  const beads = await town.listBeads({
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
  const townId = getTownId(c);
  if (!townId) return c.json(resError('Missing townId'), 400);
  const town = getTownDOStub(c.env, townId);
  const bead = await town.getBeadAsync(params.beadId);
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
  const townId = getTownId(c);
  if (!townId) return c.json(resError('Missing townId'), 400);
  const town = getTownDOStub(c.env, townId);
  const bead = await town.updateBeadStatus(params.beadId, parsed.data.status, parsed.data.agent_id);
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
  const townId = getTownId(c);
  if (!townId) return c.json(resError('Missing townId'), 400);
  const town = getTownDOStub(c.env, townId);
  const bead = await town.closeBead(params.beadId, parsed.data.agent_id);
  return c.json(resSuccess(bead));
}

const SlingBeadBody = z.object({
  title: z.string().min(1),
  body: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export async function handleSlingBead(c: Context<GastownEnv>, params: { rigId: string }) {
  const parsed = SlingBeadBody.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    console.error(`${HANDLER_LOG} handleSlingBead: invalid body`, parsed.error.issues);
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }
  console.log(
    `${HANDLER_LOG} handleSlingBead: rigId=${params.rigId} title="${parsed.data.title?.slice(0, 80)}" metadata=${JSON.stringify(parsed.data.metadata)}`
  );
  const townId = getTownId(c);
  if (!townId) return c.json(resError('Missing townId'), 400);
  const town = getTownDOStub(c.env, townId);
  const result = await town.slingBead({ ...parsed.data, rigId: params.rigId });
  console.log(
    `${HANDLER_LOG} handleSlingBead: completed, result=${JSON.stringify(result).slice(0, 300)}`
  );
  return c.json(resSuccess(result), 201);
}

export async function handleDeleteBead(
  c: Context<GastownEnv>,
  params: { rigId: string; beadId: string }
) {
  const townId = getTownId(c);
  if (!townId) return c.json(resError('Missing townId'), 400);
  const town = getTownDOStub(c.env, townId);
  await town.deleteBead(params.beadId);
  return c.json(resSuccess({ deleted: true }));
}
