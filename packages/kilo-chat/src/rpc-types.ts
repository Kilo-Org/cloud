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
