import type { z } from 'zod';
import type {
  contextSubscribeMessageSchema,
  contextUnsubscribeMessageSchema,
  clientMessageSchema,
  errorMessageSchema,
  eventMessageSchema,
  serverMessageSchema,
  connectTicketQuerySchema,
  connectTicketResponseSchema,
} from './schemas';

// ── Client → Server ────────────────────────────────────────────────

export type ContextSubscribeMessage = z.infer<typeof contextSubscribeMessageSchema>;
export type ContextUnsubscribeMessage = z.infer<typeof contextUnsubscribeMessageSchema>;
export type ClientMessage = z.infer<typeof clientMessageSchema>;

// ── Server → Client ────────────────────────────────────────────────

export type EventMessage = z.infer<typeof eventMessageSchema>;
export type ErrorMessage = z.infer<typeof errorMessageSchema>;
export type ServerMessage = z.infer<typeof serverMessageSchema>;

// ── HTTP Requests ──────────────────────────────────────────────────

export type ConnectTicketQuery = z.infer<typeof connectTicketQuerySchema>;

// ── HTTP Responses ─────────────────────────────────────────────────

export type ConnectTicketResponse = z.infer<typeof connectTicketResponseSchema>;

// ── Config ─────────────────────────────────────────────────────────

export type UnauthorizedRecoveryDecision = 'retry' | 'stop';

export type EventServiceConfig = {
  url: string;
  getToken: () => Promise<string>;
  /**
   * Called when the WebSocket upgrade is rejected (typically 401/403, though
   * browsers do not expose the HTTP status of a failed handshake). Return
   * 'retry' after clearing cached token state to let the client reconnect with
   * a fresh token, or 'stop' to permanently stop reconnecting.
   */
  onUnauthorized?: () =>
    | void
    | UnauthorizedRecoveryDecision
    | Promise<void | UnauthorizedRecoveryDecision>;
};
