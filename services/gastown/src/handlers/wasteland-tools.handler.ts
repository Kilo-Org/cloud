import type { Context } from 'hono';
import { z } from 'zod';
import { resSuccess, resError } from '../util/res.util';
import { parseJsonBody } from '../util/parse-json-body.util';
import { getTownDOStub } from '../dos/Town.do';
import type { GastownEnv } from '../gastown.worker';

const HANDLER_LOG = '[wasteland-tools.handler]';

// ── Schemas ──────────────────────────────────────────────────────────────

const WastelandClaimBody = z.object({
  item_id: z.string().min(1),
});

const WastelandPostBody = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  type: z.enum(['feature', 'bug', 'docs', 'other']).optional(),
});

const WastelandDoneBody = z.object({
  item_id: z.string().min(1),
  evidence: z.string().min(1),
});

// ── Helpers ──────────────────────────────────────────────────────────────

/** Resolve the userId of the caller from the mayor auth middleware. */
function resolveUserId(c: Context<GastownEnv>): string | null {
  const agentJWT = c.get('agentJWT');
  return agentJWT?.userId ?? null;
}

/**
 * Resolve the wasteland ID for this town. Returns null if the town is
 * not connected to any wasteland.
 */
async function resolveWastelandId(c: Context<GastownEnv>, townId: string): Promise<string | null> {
  const town = getTownDOStub(c.env, townId);
  // eslint-disable-next-line @typescript-eslint/await-thenable -- DO RPC returns promise at runtime
  const connection = await town.getWastelandConnection();
  return connection?.wasteland_id ?? null;
}

/** Map a wasteland RPC failure into a Hono response. */
function wastelandFailureToResponse(
  c: Context<GastownEnv>,
  failure: { code: string; message: string }
) {
  const status =
    failure.code === 'PRECONDITION_FAILED' ? 412 : failure.code === 'NOT_FOUND' ? 404 : 502;
  return c.json(resError(failure.message), status as 400);
}

// ── Handlers ─────────────────────────────────────────────────────────────

/**
 * GET /api/mayor/:townId/tools/wasteland/browse
 * Browse the wanted board. Supports optional `status` and `limit` query params.
 */
export async function handleWastelandBrowse(c: Context<GastownEnv>, params: { townId: string }) {
  const userId = resolveUserId(c);
  if (!userId) return c.json(resError('Authentication required'), 401);

  const wastelandId = await resolveWastelandId(c, params.townId);
  if (!wastelandId) {
    return c.json(resError('This town is not connected to any wasteland'), 404);
  }

  const statusRaw = c.req.query('status');
  const limitRaw = c.req.query('limit');

  if (statusRaw && !['open', 'claimed', 'done'].includes(statusRaw)) {
    return c.json(resError('Invalid status filter. Must be one of: open, claimed, done'), 400);
  }

  const limit = limitRaw !== undefined ? Number(limitRaw) : undefined;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) {
    return c.json(resError('limit must be an integer between 1 and 100'), 400);
  }

  console.log(
    `${HANDLER_LOG} handleWastelandBrowse: townId=${params.townId} wastelandId=${wastelandId} status=${statusRaw ?? 'all'} limit=${limitRaw ?? 'default'}`
  );

  const result = await c.env.WASTELAND_SERVICE.browseWantedBoard({
    wastelandId,
    userId,
  });

  if (!result.success) {
    return wastelandFailureToResponse(c, result);
  }

  let items = result.data;
  if (statusRaw) {
    items = items.filter(item => item.status === statusRaw);
  }
  if (limit !== undefined) {
    items = items.slice(0, limit);
  }

  return c.json(resSuccess(items));
}

/**
 * POST /api/mayor/:townId/tools/wasteland/claim
 */
export async function handleWastelandClaim(c: Context<GastownEnv>, params: { townId: string }) {
  const userId = resolveUserId(c);
  if (!userId) return c.json(resError('Authentication required'), 401);

  const wastelandId = await resolveWastelandId(c, params.townId);
  if (!wastelandId) {
    return c.json(resError('This town is not connected to any wasteland'), 404);
  }

  const parsed = WastelandClaimBody.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }

  console.log(
    `${HANDLER_LOG} handleWastelandClaim: townId=${params.townId} wastelandId=${wastelandId} itemId=${parsed.data.item_id}`
  );

  const result = await c.env.WASTELAND_SERVICE.claimWantedItem({
    wastelandId,
    userId,
    itemId: parsed.data.item_id,
  });

  if (!result.success) {
    return wastelandFailureToResponse(c, result);
  }

  return c.json(resSuccess(result.data));
}

/**
 * POST /api/mayor/:townId/tools/wasteland/post
 */
export async function handleWastelandPost(c: Context<GastownEnv>, params: { townId: string }) {
  const userId = resolveUserId(c);
  if (!userId) return c.json(resError('Authentication required'), 401);

  const wastelandId = await resolveWastelandId(c, params.townId);
  if (!wastelandId) {
    return c.json(resError('This town is not connected to any wasteland'), 404);
  }

  const parsed = WastelandPostBody.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }

  console.log(
    `${HANDLER_LOG} handleWastelandPost: townId=${params.townId} wastelandId=${wastelandId} title="${parsed.data.title.slice(0, 80)}"`
  );

  const result = await c.env.WASTELAND_SERVICE.postWantedItem({
    wastelandId,
    userId,
    title: parsed.data.title,
    description: parsed.data.description,
    priority: parsed.data.priority,
    type: parsed.data.type,
  });

  if (!result.success) {
    return wastelandFailureToResponse(c, result);
  }

  return c.json(resSuccess(result.data), 201);
}

/**
 * POST /api/mayor/:townId/tools/wasteland/done
 */
export async function handleWastelandDone(c: Context<GastownEnv>, params: { townId: string }) {
  const userId = resolveUserId(c);
  if (!userId) return c.json(resError('Authentication required'), 401);

  const wastelandId = await resolveWastelandId(c, params.townId);
  if (!wastelandId) {
    return c.json(resError('This town is not connected to any wasteland'), 404);
  }

  const parsed = WastelandDoneBody.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }

  console.log(
    `${HANDLER_LOG} handleWastelandDone: townId=${params.townId} wastelandId=${wastelandId} itemId=${parsed.data.item_id}`
  );

  const result = await c.env.WASTELAND_SERVICE.markWantedItemDone({
    wastelandId,
    userId,
    itemId: parsed.data.item_id,
    evidence: parsed.data.evidence,
  });

  if (!result.success) {
    return wastelandFailureToResponse(c, result);
  }

  return c.json(resSuccess(result.data));
}
