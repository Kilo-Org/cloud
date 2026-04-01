import type { Context } from 'hono';
import { z } from 'zod';
import { resSuccess, resError } from '../util/res.util';
import { parseJsonBody } from '../util/parse-json-body.util';
import {
  createWastelandClient,
  WastelandClientError,
} from '../util/wasteland-client.util';
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

/**
 * Extract the bearer token from the Authorization header.
 * The mayor auth middleware already validated it; we just forward it
 * to the Wasteland service for user identification.
 */
function extractAuthToken(c: Context<GastownEnv>): string | null {
  const header = c.req.header('Authorization');
  if (!header?.startsWith('Bearer ')) return null;
  return header.slice(7);
}

/**
 * Build a wasteland client from the Hono context. Uses the Cloudflare
 * service binding when available, falling back to HTTP URL for dev.
 */
function buildWastelandClient(c: Context<GastownEnv>) {
  const authToken = extractAuthToken(c);
  if (!authToken) {
    return null;
  }
  return createWastelandClient({
    wastelandService: c.env.WASTELAND_SERVICE,
    wastelandApiUrl: c.env.WASTELAND_API_URL,
    authToken,
  });
}

/**
 * Format a WastelandClientError into a Hono JSON response.
 */
function wastelandErrorResponse(c: Context<GastownEnv>, err: unknown) {
  if (err instanceof WastelandClientError) {
    const status = err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 502;
    return c.json(resError(err.message), status as 400);
  }
  throw err;
}

// ── Handlers ─────────────────────────────────────────────────────────────

/**
 * GET /api/mayor/:townId/tools/wasteland/:wastelandId/browse
 * Browse the wanted board. Supports optional `status` and `limit` query params.
 */
export async function handleWastelandBrowse(
  c: Context<GastownEnv>,
  params: { townId: string; wastelandId: string }
) {
  const client = buildWastelandClient(c);
  if (!client) {
    return c.json(resError('Authentication required'), 401);
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
    `${HANDLER_LOG} handleWastelandBrowse: townId=${params.townId} wastelandId=${params.wastelandId} status=${statusRaw ?? 'all'} limit=${limitRaw ?? 'default'}`
  );

  try {
    let items = await client.browseWantedBoard({ wastelandId: params.wastelandId });

    // Apply client-side filtering (status and limit)
    if (statusRaw) {
      items = items.filter(item => item.status === statusRaw);
    }
    if (limit !== undefined) {
      items = items.slice(0, limit);
    }

    return c.json(resSuccess(items));
  } catch (err) {
    return wastelandErrorResponse(c, err);
  }
}

/**
 * POST /api/mayor/:townId/tools/wasteland/:wastelandId/claim
 * Claim an open wanted item.
 */
export async function handleWastelandClaim(
  c: Context<GastownEnv>,
  params: { townId: string; wastelandId: string }
) {
  const client = buildWastelandClient(c);
  if (!client) {
    return c.json(resError('Authentication required'), 401);
  }

  const parsed = WastelandClaimBody.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }

  console.log(
    `${HANDLER_LOG} handleWastelandClaim: townId=${params.townId} wastelandId=${params.wastelandId} itemId=${parsed.data.item_id}`
  );

  try {
    const result = await client.claimWantedItem({
      wastelandId: params.wastelandId,
      itemId: parsed.data.item_id,
    });
    return c.json(resSuccess(result));
  } catch (err) {
    return wastelandErrorResponse(c, err);
  }
}

/**
 * POST /api/mayor/:townId/tools/wasteland/:wastelandId/post
 * Post a new wanted item.
 */
export async function handleWastelandPost(
  c: Context<GastownEnv>,
  params: { townId: string; wastelandId: string }
) {
  const client = buildWastelandClient(c);
  if (!client) {
    return c.json(resError('Authentication required'), 401);
  }

  const parsed = WastelandPostBody.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }

  console.log(
    `${HANDLER_LOG} handleWastelandPost: townId=${params.townId} wastelandId=${params.wastelandId} title="${parsed.data.title.slice(0, 80)}"`
  );

  try {
    const result = await client.postWantedItem({
      wastelandId: params.wastelandId,
      title: parsed.data.title,
      description: parsed.data.description,
      priority: parsed.data.priority,
      type: parsed.data.type,
    });
    return c.json(resSuccess(result), 201);
  } catch (err) {
    return wastelandErrorResponse(c, err);
  }
}

/**
 * POST /api/mayor/:townId/tools/wasteland/:wastelandId/done
 * Mark a claimed wanted item as done with evidence.
 */
export async function handleWastelandDone(
  c: Context<GastownEnv>,
  params: { townId: string; wastelandId: string }
) {
  const client = buildWastelandClient(c);
  if (!client) {
    return c.json(resError('Authentication required'), 401);
  }

  const parsed = WastelandDoneBody.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }

  console.log(
    `${HANDLER_LOG} handleWastelandDone: townId=${params.townId} wastelandId=${params.wastelandId} itemId=${parsed.data.item_id}`
  );

  try {
    const result = await client.markWantedItemDone({
      wastelandId: params.wastelandId,
      itemId: parsed.data.item_id,
      evidence: parsed.data.evidence,
    });
    return c.json(resSuccess(result));
  } catch (err) {
    return wastelandErrorResponse(c, err);
  }
}
