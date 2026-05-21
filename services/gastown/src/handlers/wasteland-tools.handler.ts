import type { Context } from 'hono';
import { z } from 'zod';
import { resSuccess, resError } from '../util/res.util';
import { parseJsonBody } from '../util/parse-json-body.util';
import { getTownDOStub } from '../dos/Town.do';
import type { GastownEnv } from '../gastown.worker';
import { pickRigIdForWastelandBead } from './wasteland-bead.helpers';
import type { WastelandConnectionRecord } from '../dos/town/wasteland';

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
  // Evidence MUST be a single URL (PR / commit / artifact). The wasteland
  // review UI renders this as a clickable link, so passing a sentence with
  // a URL embedded in it (e.g. "PR submitted: https://…") breaks the link
  // affordance for admins. Mirrors the strict `z.string().url()` validation
  // on the tRPC `markWantedItemDone` procedure used by the web UI; the
  // mayor path was previously the only entry that allowed free-form text.
  evidence: z.string().url(),
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

/**
 * Resolve the full wasteland connection for this town. Returns null when
 * the town is not connected. Used by code paths that need both the
 * `wasteland_id` and the upstream `rig_handle` (e.g. to attach a bead to a
 * matching local rig).
 */
async function resolveWastelandConnection(
  c: Context<GastownEnv>,
  townId: string
): Promise<WastelandConnectionRecord | null> {
  const town = getTownDOStub(c.env, townId);
  // eslint-disable-next-line @typescript-eslint/await-thenable -- DO RPC returns promise at runtime
  return town.getWastelandConnection();
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
 *
 * Claims the upstream wanted item and returns a rich planning context to
 * the mayor: the item title/body/priority/type, the upstream PR URL (if
 * any), a suggested local `rig_id`, and the canonical `wasteland` origin
 * tag the mayor MUST attach to whatever beads it creates next (single
 * bead via gt_sling, or convoy via gt_sling_batch). The mayor decides the
 * shape of the work; gastown does NOT create any beads here.
 */
export async function handleWastelandClaim(c: Context<GastownEnv>, params: { townId: string }) {
  const userId = resolveUserId(c);
  if (!userId) return c.json(resError('Authentication required'), 401);

  const connection = await resolveWastelandConnection(c, params.townId);
  if (!connection) {
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
    `${HANDLER_LOG} handleWastelandClaim: townId=${params.townId} wastelandId=${connection.wasteland_id} itemId=${parsed.data.item_id}`
  );

  const result = await c.env.WASTELAND_SERVICE.claimWantedItem({
    wastelandId: connection.wasteland_id,
    userId,
    itemId: parsed.data.item_id,
  });

  if (!result.success) {
    return wastelandFailureToResponse(c, result);
  }

  const item = await fetchClaimedItem(c, connection.wasteland_id, userId, parsed.data.item_id);
  const suggestedRigId = await suggestLocalRigId(c, params.townId, connection.rig_handle);

  return c.json(
    resSuccess({
      claim: result.data,
      item,
      planning: {
        wasteland_origin: {
          kind: 'wanted-item-claim',
          wasteland_id: connection.wasteland_id,
          item_id: parsed.data.item_id,
          pull_id: null,
          source_url: result.data.pr_url,
        },
        suggested_rig_id: suggestedRigId,
      },
    })
  );
}

/**
 * Look up the just-claimed item on the wanted board so we can return its
 * title, description, priority, and type to the mayor for planning. Best
 * effort: returns null if the item can't be found.
 */
async function fetchClaimedItem(
  c: Context<GastownEnv>,
  wastelandId: string,
  userId: string,
  itemId: string
): Promise<Record<string, unknown> | null> {
  try {
    const browse = await c.env.WASTELAND_SERVICE.browseWantedBoard({
      wastelandId,
      userId,
    });
    if (!browse.success) return null;
    return browse.data.find(it => it.id === itemId) ?? null;
  } catch (err) {
    console.warn(
      `${HANDLER_LOG} fetchClaimedItem: browse failed for wastelandId=${wastelandId} itemId=${itemId}:`,
      err
    );
    return null;
  }
}

/**
 * Suggest a local rig id for the mayor to scope wasteland-originated work to.
 * Uses the same rule the wasteland-bead helpers use: match by `rig_handle`,
 * else pick the only rig if exactly one exists, else null.
 */
async function suggestLocalRigId(
  c: Context<GastownEnv>,
  townId: string,
  rigHandle: string
): Promise<string | null> {
  try {
    const town = getTownDOStub(c.env, townId);
    // eslint-disable-next-line @typescript-eslint/await-thenable -- DO RPC returns promise at runtime
    const rigList = await town.listRigs();
    return pickRigIdForWastelandBead(
      rigList.map(r => ({ id: r.id, name: r.name })),
      rigHandle
    );
  } catch (err) {
    console.warn(`${HANDLER_LOG} suggestLocalRigId: listRigs failed for townId=${townId}:`, err);
    return null;
  }
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
    publish: true,
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

  // Stamp the canonical bead so the auto-done reconciler doesn't re-fire
  // for an item the mayor already reported manually. Best-effort: a stamp
  // failure is logged but does NOT fail the response — the upstream call
  // already succeeded.
  try {
    const town = getTownDOStub(c.env, params.townId);
    // eslint-disable-next-line @typescript-eslint/await-thenable -- DO RPC returns promise at runtime
    await town.stampWastelandReported({
      wastelandId,
      itemId: parsed.data.item_id,
      evidence: parsed.data.evidence,
    });
  } catch (err) {
    console.warn(
      `${HANDLER_LOG} handleWastelandDone: stampWastelandReported failed for item=${parsed.data.item_id}:`,
      err
    );
  }

  return c.json(resSuccess(result.data));
}
