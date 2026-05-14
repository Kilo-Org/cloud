/**
 * POC handlers that exercise the libwl WASM path under `/poc/wasm/...`
 * without requiring the Kilo auth middleware. The actual implementations
 * live in `wanted-board/wanted-board-ops` — those functions were swapped
 * to use libwl instead of the container, so the production tRPC and RPC
 * entrypoints already exercise the same code paths.
 *
 * These handlers exist to:
 * 1. Provide HTTP-callable endpoints for local validation that don't
 *    require the Kilo auth middleware (the production path requires a
 *    Kilo JWT).
 * 2. Surface timing + a stable `source` field so an operator can A/B
 *    test against any future container-restoration endpoint.
 *
 * Remove once the wasm path has soaked in production.
 */

import type { Context } from 'hono';
import { z } from 'zod';
import type { WastelandEnv } from '../wasteland.worker';
import * as wantedBoard from '../wanted-board/wanted-board-ops';
import { WantedBoardOpError } from '../wanted-board/wanted-board-ops';

// ── Browse ──────────────────────────────────────────────────────────────

export async function handleWasmBrowse(
  c: Context<WastelandEnv>,
  params: { wastelandId: string }
): Promise<Response> {
  const userId = c.req.query('userId');
  if (!userId) {
    return c.json({ error: 'Missing userId query param' }, 400);
  }

  const startedAt = performance.now();
  let items: Array<Record<string, unknown>>;
  try {
    items = await wantedBoard.browseWantedBoard(c.env, params.wastelandId, userId);
  } catch (err) {
    return errorResponse(c, err, performance.now() - startedAt);
  }

  return c.json({
    source: 'libwl-wasm',
    durationMs: Math.round(performance.now() - startedAt),
    itemCount: items.length,
    items,
  });
}

// ── Mutations ───────────────────────────────────────────────────────────

const ItemBody = z.object({
  userId: z.string().min(1),
  itemId: z.string().min(1),
  direct: z.boolean().optional(),
});

const PostBody = z.object({
  userId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  type: z.enum(['feature', 'bug', 'docs', 'other']).optional(),
  direct: z.boolean().optional(),
});

const DoneBody = ItemBody.extend({ evidence: z.string().min(1) });
const AcceptBody = ItemBody.extend({
  quality: z.enum(['excellent', 'good', 'fair', 'poor']),
  message: z.string().optional(),
});
const RejectBody = ItemBody.extend({ reason: z.string().min(1) });

export async function handleWasmClaim(
  c: Context<WastelandEnv>,
  params: { wastelandId: string }
): Promise<Response> {
  return runOp(c, params, ItemBody, async (env, body) => {
    return wantedBoard.claimWantedItem(env, params.wastelandId, body.userId, body.itemId, {
      direct: body.direct,
    });
  });
}

export async function handleWasmUnclaim(
  c: Context<WastelandEnv>,
  params: { wastelandId: string }
): Promise<Response> {
  return runOp(c, params, ItemBody, async (env, body) => {
    return wantedBoard.unclaimWantedItem(env, params.wastelandId, body.userId, body.itemId, {
      direct: body.direct,
    });
  });
}

export async function handleWasmDone(
  c: Context<WastelandEnv>,
  params: { wastelandId: string }
): Promise<Response> {
  return runOp(c, params, DoneBody, async (env, body) => {
    return wantedBoard.markWantedItemDone(env, params.wastelandId, body.userId, {
      itemId: body.itemId,
      evidence: body.evidence,
      direct: body.direct,
    });
  });
}

export async function handleWasmPost(
  c: Context<WastelandEnv>,
  params: { wastelandId: string }
): Promise<Response> {
  return runOp(c, params, PostBody, async (env, body) => {
    return wantedBoard.postWantedItem(env, params.wastelandId, body.userId, {
      title: body.title,
      description: body.description,
      priority: body.priority,
      type: body.type,
      direct: body.direct,
    });
  });
}

export async function handleWasmAccept(
  c: Context<WastelandEnv>,
  params: { wastelandId: string }
): Promise<Response> {
  return runOp(c, params, AcceptBody, async (env, body) => {
    return wantedBoard.acceptWantedItem(env, params.wastelandId, body.userId, {
      itemId: body.itemId,
      quality: body.quality,
      message: body.message,
      direct: body.direct,
    });
  });
}

export async function handleWasmReject(
  c: Context<WastelandEnv>,
  params: { wastelandId: string }
): Promise<Response> {
  return runOp(c, params, RejectBody, async (env, body) => {
    return wantedBoard.rejectWantedItem(env, params.wastelandId, body.userId, {
      itemId: body.itemId,
      reason: body.reason,
      direct: body.direct,
    });
  });
}

export async function handleWasmClose(
  c: Context<WastelandEnv>,
  params: { wastelandId: string }
): Promise<Response> {
  return runOp(c, params, ItemBody, async (env, body) => {
    return wantedBoard.closeWantedItem(env, params.wastelandId, body.userId, body.itemId, {
      direct: body.direct,
    });
  });
}

// ── Internals ───────────────────────────────────────────────────────────

async function runOp<T extends z.ZodTypeAny>(
  c: Context<WastelandEnv>,
  _params: { wastelandId: string },
  schema: T,
  exec: (env: Env, body: z.infer<T>) => Promise<unknown>
): Promise<Response> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request body', issues: parsed.error.issues }, 400);
  }

  const startedAt = performance.now();
  try {
    const result = await exec(c.env, parsed.data);
    return c.json({
      source: 'libwl-wasm',
      durationMs: Math.round(performance.now() - startedAt),
      result,
    });
  } catch (err) {
    return errorResponse(c, err, performance.now() - startedAt);
  }
}

function errorResponse(c: Context<WastelandEnv>, err: unknown, elapsedMs: number): Response {
  const durationMs = Math.round(elapsedMs);
  if (err instanceof WantedBoardOpError) {
    return c.json({ error: err.message, code: err.code, durationMs }, 502);
  }
  const message = err instanceof Error ? err.message : String(err);
  return c.json({ error: 'libwl op failed', detail: message, durationMs }, 500);
}
