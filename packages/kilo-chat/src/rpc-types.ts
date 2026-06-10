import { z } from 'zod';
import { messageTextSchema } from './schemas';

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
//
// The Zod schemas are the single source of truth; the exported TS types are
// derived from them via `z.infer`. Worker RPC callers import the types (which
// compile away — `z.infer` is type-only, no runtime cost), while HTTP callers
// and the HTTP route reuse the schemas for validation. Add a field or error
// code in one place and both call paths stay in sync by construction. The
// bounds (`min(1)`, `max(64)` on source, etc.) are HTTP-boundary safety and
// apply uniformly to both call paths.

export const postMessageAsUserCorrelationSchema = z.object({
  triggerId: z.string().max(200).optional(),
  webhookRequestId: z.string().max(200).optional(),
  reason: z.string().max(200).optional(),
});

export const postMessageAsUserParamsSchema = z.object({
  userId: z.string().min(1).max(200),
  sandboxId: z.string().min(1).max(200),
  // Shared with `textBlockSchema` (the message-creation boundary) so the HTTP
  // boundary and the service can't drift: trimmed, non-empty, ≤ 8000 chars.
  message: messageTextSchema,
  // Origin identifier for diagnostics (e.g. "webhook", "onboarding-warmup").
  // Logged so structured-log queries can attribute new conversations to a
  // specific source.
  source: z.string().min(1).max(64),
  // Default true. Pass false to fail the call if the user has never opened
  // a chat with this bot.
  autoCreateConversation: z.boolean().optional(),
  // Default false. When true, always start a NEW conversation instead of
  // reusing the user's most-recent one. The install flow sets this so each
  // install lands in its own dedicated chat; webhook-style callers omit it to
  // keep appending to the ongoing conversation.
  forceNewConversation: z.boolean().optional(),
  correlation: postMessageAsUserCorrelationSchema.optional(),
});

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

export type PostMessageAsUserCorrelation = z.infer<typeof postMessageAsUserCorrelationSchema>;
export type PostMessageAsUserParams = z.infer<typeof postMessageAsUserParamsSchema>;
export type PostMessageAsUserOk = z.infer<typeof postMessageAsUserOkSchema>;
export type PostMessageAsUserErr = z.infer<typeof postMessageAsUserErrSchema>;
export type PostMessageAsUserResult = z.infer<typeof postMessageAsUserResultSchema>;
