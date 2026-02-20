import type { Context } from 'hono';
import { z } from 'zod';
import { getTownDOStub } from '../dos/Town.do';
import { getGastownUserStub } from '../dos/GastownUser.do';
import { resSuccess, resError } from '../util/res.util';
import { parseJsonBody } from '../util/parse-json-body.util';
import { BeadStatus, BeadType } from '../types';
import type { GastownEnv } from '../gastown.worker';

const HANDLER_LOG = '[mayor-tools.handler]';

// ── Schemas ──────────────────────────────────────────────────────────────

const MayorSlingBody = z.object({
  rig_id: z.string().min(1),
  title: z.string().min(1),
  body: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const MayorMailBody = z.object({
  rig_id: z.string().min(1),
  to_agent_id: z.string().min(1),
  subject: z.string().min(1),
  body: z.string().min(1),
  from_agent_id: z.string().min(1),
});

const NonNegativeInt = z.coerce.number().int().nonnegative();

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Resolve the userId for the mayor's town.
 *
 * In production the JWT is always present (set by mayorAuthMiddleware).
 * In development the middleware is skipped, so we fall back to a
 * `userId` query parameter to keep the routes testable.
 */
function resolveUserId(c: Context<GastownEnv>): string | null {
  const jwt = c.get('agentJWT');
  if (jwt?.userId) return jwt.userId;
  // Dev-mode fallback: accept userId as a query param
  return c.req.query('userId') ?? null;
}

/**
 * Verify that `rigId` belongs to `townId` by checking the user's rig
 * registry. Returns the rig record on success, or null if the rig
 * doesn't belong to this town (or doesn't exist).
 */
async function verifyRigBelongsToTown(
  c: Context<GastownEnv>,
  townId: string,
  rigId: string
): Promise<boolean> {
  const userId = resolveUserId(c);
  if (!userId) return false;
  const userDO = getGastownUserStub(c.env, userId);
  const rig = await userDO.getRigAsync(rigId);
  return rig !== null && rig.town_id === townId;
}

// ── Handlers ─────────────────────────────────────────────────────────────

/**
 * POST /api/mayor/:townId/tools/sling
 * Sling a task to a polecat in a specific rig. Creates a bead, assigns
 * an agent, and arms the alarm for dispatch.
 */
export async function handleMayorSling(c: Context<GastownEnv>, params: { townId: string }) {
  const parsed = MayorSlingBody.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }

  const rigOwned = await verifyRigBelongsToTown(c, params.townId, parsed.data.rig_id);
  if (!rigOwned) {
    return c.json(resError('Rig not found in this town'), 403);
  }

  console.log(
    `${HANDLER_LOG} handleMayorSling: townId=${params.townId} rigId=${parsed.data.rig_id} title="${parsed.data.title.slice(0, 80)}"`
  );

  const town = getTownDOStub(c.env, params.townId);
  const result = await town.slingBead({
    rigId: parsed.data.rig_id,
    ...parsed.data,
  });

  console.log(
    `${HANDLER_LOG} handleMayorSling: completed, result=${JSON.stringify(result).slice(0, 300)}`
  );

  return c.json(resSuccess(result), 201);
}

/**
 * GET /api/mayor/:townId/tools/rigs
 * List all rigs in the town. Requires userId to route to the correct
 * GastownUserDO instance (from JWT in prod, query param in dev).
 */
export async function handleMayorListRigs(c: Context<GastownEnv>, params: { townId: string }) {
  const userId = resolveUserId(c);
  if (!userId) {
    return c.json(resError('Missing userId in token (or userId query param in dev mode)'), 401);
  }

  console.log(`${HANDLER_LOG} handleMayorListRigs: townId=${params.townId} userId=${userId}`);

  const userDO = getGastownUserStub(c.env, userId);
  const rigs = await userDO.listRigs(params.townId);

  return c.json(resSuccess(rigs));
}

/**
 * GET /api/mayor/:townId/tools/rigs/:rigId/beads
 * List beads in a specific rig. Supports status and type filtering.
 */
export async function handleMayorListBeads(
  c: Context<GastownEnv>,
  params: { townId: string; rigId: string }
) {
  const rigOwned = await verifyRigBelongsToTown(c, params.townId, params.rigId);
  if (!rigOwned) {
    return c.json(resError('Rig not found in this town'), 403);
  }

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

  console.log(
    `${HANDLER_LOG} handleMayorListBeads: townId=${params.townId} rigId=${params.rigId} status=${statusRaw ?? 'all'} type=${typeRaw ?? 'all'}`
  );

  const town = getTownDOStub(c.env, params.townId);
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

/**
 * GET /api/mayor/:townId/tools/rigs/:rigId/agents
 * List agents in a specific rig.
 */
export async function handleMayorListAgents(
  c: Context<GastownEnv>,
  params: { townId: string; rigId: string }
) {
  const rigOwned = await verifyRigBelongsToTown(c, params.townId, params.rigId);
  if (!rigOwned) {
    return c.json(resError('Rig not found in this town'), 403);
  }

  console.log(
    `${HANDLER_LOG} handleMayorListAgents: townId=${params.townId} rigId=${params.rigId}`
  );

  const town = getTownDOStub(c.env, params.townId);
  const agents = await town.listAgents({});

  return c.json(resSuccess(agents));
}

/**
 * POST /api/mayor/:townId/tools/mail
 * Send mail to an agent in any rig. The mayor can communicate cross-rig.
 */
export async function handleMayorSendMail(c: Context<GastownEnv>, params: { townId: string }) {
  const parsed = MayorMailBody.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }

  const rigOwned = await verifyRigBelongsToTown(c, params.townId, parsed.data.rig_id);
  if (!rigOwned) {
    return c.json(resError('Rig not found in this town'), 403);
  }

  console.log(
    `${HANDLER_LOG} handleMayorSendMail: townId=${params.townId} rigId=${parsed.data.rig_id} to=${parsed.data.to_agent_id} subject="${parsed.data.subject.slice(0, 80)}"`
  );

  const town = getTownDOStub(c.env, params.townId);
  await town.sendMail({
    from_agent_id: parsed.data.from_agent_id,
    to_agent_id: parsed.data.to_agent_id,
    subject: parsed.data.subject,
    body: parsed.data.body,
  });

  return c.json(resSuccess({ sent: true }));
}
