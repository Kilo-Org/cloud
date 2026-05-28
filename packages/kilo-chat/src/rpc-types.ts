import { z } from 'zod';

// Cross-service RPC contracts exposed by the kilo-chat WorkerEntrypoint.
//
// Producer:  services/kilo-chat/src/index.ts (KiloChatService)
// Consumers: any worker with a service binding to kilo-chat
//            (e.g. webhook-agent-ingest, kiloclaw)
//
// The kilo-chat producer imports these types directly. Consumers import
// them when declaring their service-binding shape (Cloudflare's wrangler
// types only emit a generic `Service` for service bindings; the precise
// RPC method shape is declared per-consumer alongside the binding).
//
// Keeping the contract in one shared package gives us compile-time drift
// detection: a change here breaks both producer and consumer in the same
// build.

// ── postMessageAsUser ──────────────────────────────────────────────

export type PostMessageAsUserCorrelation = {
  triggerId?: string;
  webhookRequestId?: string;
  reason?: string;
};

export type PostMessageAsUserParams = {
  userId: string;
  sandboxId: string;
  message: string;
  // Origin identifier for diagnostics (e.g. "webhook", "onboarding-warmup").
  // Logged so structured-log queries can attribute new conversations to a
  // specific source.
  source: string;
  // Default true. Pass false to fail the call if the user has never opened
  // a chat with this bot.
  autoCreateConversation?: boolean;
  correlation?: PostMessageAsUserCorrelation;
};

export type PostMessageAsUserOk = {
  ok: true;
  conversationId: string;
  messageId: string;
  conversationCreated: boolean;
};

export type PostMessageAsUserErr = {
  ok: false;
  code: 'invalid_request' | 'no_conversation' | 'forbidden' | 'internal';
  error: string;
};

export type PostMessageAsUserResult = PostMessageAsUserOk | PostMessageAsUserErr;

// Runtime schema for `PostMessageAsUserParams` so HTTP callers and the
// HTTP route share one source of truth (Worker RPC callers rely on the
// declared types). The bounds (`min(1)`, `max(64)` on source, etc.) are
// HTTP-boundary safety and apply uniformly to both call paths.
export const postMessageAsUserCorrelationSchema = z.object({
  triggerId: z.string().max(200).optional(),
  webhookRequestId: z.string().max(200).optional(),
  reason: z.string().max(200).optional(),
});

export const postMessageAsUserParamsSchema = z.object({
  userId: z.string().min(1).max(200),
  sandboxId: z.string().min(1).max(200),
  message: z.string().min(1),
  source: z.string().min(1).max(64),
  autoCreateConversation: z.boolean().optional(),
  correlation: postMessageAsUserCorrelationSchema.optional(),
});

// Runtime schemas for the same shapes, so HTTP callers (e.g. cloud's
// Next.js app) can Zod-validate responses against one source of truth
// shared with the producer. Keep `z.infer` aligned with the types above —
// if you add a field or error code here, mirror it in the type union.
export const postMessageAsUserOkSchema = z.object({
  ok: z.literal(true),
  conversationId: z.string(),
  messageId: z.string(),
  conversationCreated: z.boolean(),
});

export const postMessageAsUserErrSchema = z.object({
  ok: z.literal(false),
  code: z.enum(['invalid_request', 'no_conversation', 'forbidden', 'internal']),
  error: z.string(),
});

export const postMessageAsUserResultSchema = z.discriminatedUnion('ok', [
  postMessageAsUserOkSchema,
  postMessageAsUserErrSchema,
]);
