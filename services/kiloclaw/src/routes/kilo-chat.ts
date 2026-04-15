/**
 * Kilo-Chat outbound proxy for Fly-side controllers.
 *
 *   Plugin (Fly) ──> Controller (Fly, localhost)
 *                           │  Bearer = OPENCLAW_GATEWAY_TOKEN
 *                           ▼
 *                    kiloclaw CF Worker (this file)
 *                           │  verifies HMAC(GATEWAY_TOKEN_SECRET, sandboxId) == bearer
 *                           │  service binding (trusted by CF platform)
 *                           ▼
 *                    kilo-chat CF Worker (RPC method)
 *                           identity = bot:kiloclaw:<sandboxId>  (trusted; came from the
 *                                                                 verified kiloclaw hop)
 *
 * This replaces the old scheme where the Fly controller talked to the kilo-chat
 * public HTTP API directly with a shared KILOCHAT_API_TOKEN. The per-sandbox
 * gateway token is already minted and injected at sandbox creation time, so
 * nothing else needs to be provisioned. A leaked gateway token's blast radius
 * is already one tenant — exactly what we want for kilo-chat auth too.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { timingSafeEqual } from '@kilocode/encryption';
import type { AppEnv } from '../types';
import { deriveGatewayToken } from '../auth/gateway-token';

// ──────────────────────────────────────────────────────────────────────────
// Auth + helpers
// ──────────────────────────────────────────────────────────────────────────

const sandboxIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'Invalid sandboxId');

/** Extract and verify the per-sandbox gateway token, return the sandboxId. */
async function authenticateSandbox(c: Context<AppEnv>): Promise<
  { ok: true; sandboxId: string } | { ok: false; status: 400 | 401 | 403 | 503; error: string }
> {
  const sandboxParam = c.req.param('sandboxId');
  const parsed = sandboxIdSchema.safeParse(sandboxParam);
  if (!parsed.success) return { ok: false, status: 400, error: 'Invalid sandboxId' };
  const sandboxId = parsed.data;

  const authHeader = c.req.header('authorization');
  const bearer = authHeader?.toLowerCase().startsWith('bearer ')
    ? authHeader.slice(7)
    : undefined;
  if (!bearer) return { ok: false, status: 401, error: 'Unauthorized' };

  if (!c.env.GATEWAY_TOKEN_SECRET || !c.env.KILOCHAT) {
    return { ok: false, status: 503, error: 'Configuration error' };
  }

  const expected = await deriveGatewayToken(sandboxId, c.env.GATEWAY_TOKEN_SECRET);
  if (!timingSafeEqual(bearer, expected)) {
    return { ok: false, status: 403, error: 'Forbidden' };
  }
  return { ok: true, sandboxId };
}

/** Fetch the KILOCHAT binding once, asserting non-null after authenticateSandbox. */
function requireKilochat(c: Context<AppEnv>): NonNullable<AppEnv['Bindings']['KILOCHAT']> {
  const binding = c.env.KILOCHAT;
  if (!binding) {
    // authenticateSandbox should have already returned 503 in this case; this
    // branch only trips if a caller uses requireKilochat without first awaiting
    // authenticateSandbox — treat as an invariant violation.
    throw new Error('KILOCHAT service binding is not configured');
  }
  return binding;
}

// Body size cap — messages are tiny; 1 MB is generous and guards the RPC layer.
const MAX_BODY_BYTES = 1 * 1024 * 1024;
const MAX_SMALL_BODY_BYTES = 8 * 1024;

function guardBodySize(c: Context<AppEnv>, limit: number): Response | null {
  const header = c.req.header('content-length');
  if (!header) return null;
  const n = Number(header);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n > limit) return c.json({ error: 'Payload too large' }, 413);
  return null;
}

const ulidSchema = z.string().regex(/^[0-9A-Z]{26}$/, 'Invalid ULID');
const contentBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().min(1) }),
]);

// ──────────────────────────────────────────────────────────────────────────
// Route group
// ──────────────────────────────────────────────────────────────────────────

const kiloChatProxy = new Hono<AppEnv>();

// POST /api/kilo-chat/sandboxes/:sandboxId/messages — create a bot message.
kiloChatProxy.post('/sandboxes/:sandboxId/messages', async c => {
  const oversized = guardBodySize(c, MAX_BODY_BYTES);
  if (oversized) return oversized;

  const auth = await authenticateSandbox(c);
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);

  const bodySchema = z.object({
    conversationId: z.string().min(1),
    content: z.array(contentBlockSchema).min(1),
    inReplyToMessageId: ulidSchema.optional(),
  });
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', issues: parsed.error.issues }, 400);
  }

  const result = await requireKilochat(c).botCreateMessage({
    sandboxId: auth.sandboxId,
    conversationId: parsed.data.conversationId,
    content: parsed.data.content,
    inReplyToMessageId: parsed.data.inReplyToMessageId,
  });
  if (!result.ok) {
    if (result.code === 'forbidden') return c.json({ error: result.error }, 403);
    if (result.code === 'invalid_sandbox') return c.json({ error: result.error }, 400);
    return c.json({ error: result.error }, 500);
  }
  return c.json({ messageId: result.messageId, version: result.version }, 201);
});

// PATCH /api/kilo-chat/sandboxes/:sandboxId/messages/:messageId — edit.
kiloChatProxy.patch('/sandboxes/:sandboxId/messages/:messageId', async c => {
  const oversized = guardBodySize(c, MAX_BODY_BYTES);
  if (oversized) return oversized;

  const auth = await authenticateSandbox(c);
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);

  const messageIdParam = ulidSchema.safeParse(c.req.param('messageId'));
  if (!messageIdParam.success) return c.json({ error: 'Invalid message ID' }, 400);

  const bodySchema = z.object({
    conversationId: z.string().min(1),
    content: z.array(contentBlockSchema).min(1),
    version: z.number().int().nonnegative(),
  });
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', issues: parsed.error.issues }, 400);
  }

  const result = await requireKilochat(c).botEditMessage({
    sandboxId: auth.sandboxId,
    conversationId: parsed.data.conversationId,
    messageId: messageIdParam.data,
    content: parsed.data.content,
    version: parsed.data.version,
  });
  if (!result.ok) {
    if (result.code === 'forbidden') return c.json({ error: result.error }, 403);
    if (result.code === 'not_found') return c.json({ error: result.error }, 404);
    if (result.code === 'invalid_sandbox') return c.json({ error: result.error }, 400);
    return c.json({ error: result.error }, 500);
  }
  if (result.conflict) {
    return c.json(
      { error: 'Conflict', messageId: result.messageId, version: result.version },
      409
    );
  }
  return c.json({ messageId: result.messageId, version: result.version });
});

// DELETE /api/kilo-chat/sandboxes/:sandboxId/messages/:messageId — soft delete.
kiloChatProxy.delete('/sandboxes/:sandboxId/messages/:messageId', async c => {
  const oversized = guardBodySize(c, MAX_SMALL_BODY_BYTES);
  if (oversized) return oversized;

  const auth = await authenticateSandbox(c);
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);

  const messageIdParam = ulidSchema.safeParse(c.req.param('messageId'));
  if (!messageIdParam.success) return c.json({ error: 'Invalid message ID' }, 400);

  const bodySchema = z.object({ conversationId: z.string().min(1) });
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', issues: parsed.error.issues }, 400);
  }

  const result = await requireKilochat(c).botDeleteMessage({
    sandboxId: auth.sandboxId,
    conversationId: parsed.data.conversationId,
    messageId: messageIdParam.data,
  });
  if (!result.ok) {
    if (result.code === 'forbidden') return c.json({ error: result.error }, 403);
    if (result.code === 'not_found') return c.json({ error: result.error }, 404);
    if (result.code === 'invalid_sandbox') return c.json({ error: result.error }, 400);
    return c.json({ error: result.error }, 500);
  }
  return new Response(null, { status: 204 });
});

// POST /api/kilo-chat/sandboxes/:sandboxId/conversations/:conversationId/typing.
kiloChatProxy.post('/sandboxes/:sandboxId/conversations/:conversationId/typing', async c => {
  const oversized = guardBodySize(c, MAX_SMALL_BODY_BYTES);
  if (oversized) return oversized;

  const auth = await authenticateSandbox(c);
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);

  const conversationIdParam = ulidSchema.safeParse(c.req.param('conversationId'));
  if (!conversationIdParam.success) return c.json({ error: 'Invalid conversation ID' }, 400);

  const result = await requireKilochat(c).botSendTyping({
    sandboxId: auth.sandboxId,
    conversationId: conversationIdParam.data,
  });
  if (!result.ok) {
    if (result.code === 'forbidden') return c.json({ error: result.error }, 403);
    if (result.code === 'invalid_sandbox') return c.json({ error: result.error }, 400);
  }
  return c.body(null, 204);
});

// POST /api/kilo-chat/sandboxes/:sandboxId/messages/:messageId/reactions.
kiloChatProxy.post('/sandboxes/:sandboxId/messages/:messageId/reactions', async c => {
  const oversized = guardBodySize(c, MAX_SMALL_BODY_BYTES);
  if (oversized) return oversized;

  const auth = await authenticateSandbox(c);
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);

  const messageIdParam = ulidSchema.safeParse(c.req.param('messageId'));
  if (!messageIdParam.success) return c.json({ error: 'Invalid message ID' }, 400);

  const bodySchema = z.object({
    conversationId: z.string().min(1),
    emoji: z.string().min(1).max(64),
  });
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', issues: parsed.error.issues }, 400);
  }

  const result = await requireKilochat(c).botAddReaction({
    sandboxId: auth.sandboxId,
    conversationId: parsed.data.conversationId,
    messageId: messageIdParam.data,
    emoji: parsed.data.emoji,
  });
  if (!result.ok) {
    if (result.code === 'forbidden') return c.json({ error: result.error }, 403);
    if (result.code === 'invalid_sandbox') return c.json({ error: result.error }, 400);
    return c.json({ error: result.error }, 500);
  }
  return c.json({ id: result.id }, result.added ? 201 : 200);
});

// DELETE /api/kilo-chat/sandboxes/:sandboxId/messages/:messageId/reactions.
kiloChatProxy.delete('/sandboxes/:sandboxId/messages/:messageId/reactions', async c => {
  const oversized = guardBodySize(c, MAX_SMALL_BODY_BYTES);
  if (oversized) return oversized;

  const auth = await authenticateSandbox(c);
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);

  const messageIdParam = ulidSchema.safeParse(c.req.param('messageId'));
  if (!messageIdParam.success) return c.json({ error: 'Invalid message ID' }, 400);

  const bodySchema = z.object({
    conversationId: z.string().min(1),
    emoji: z.string().min(1).max(64),
  });
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', issues: parsed.error.issues }, 400);
  }

  const result = await requireKilochat(c).botRemoveReaction({
    sandboxId: auth.sandboxId,
    conversationId: parsed.data.conversationId,
    messageId: messageIdParam.data,
    emoji: parsed.data.emoji,
  });
  if (!result.ok) {
    if (result.code === 'forbidden') return c.json({ error: result.error }, 403);
    if (result.code === 'invalid_sandbox') return c.json({ error: result.error }, 400);
    return c.json({ error: result.error }, 500);
  }
  return new Response(null, { status: 204 });
});

export { kiloChatProxy };
