import type { z } from 'zod';
import type {
  contextSubscribeMessageSchema,
  contextUnsubscribeMessageSchema,
  clientMessageSchema,
  errorMessageSchema,
  eventMessageSchema,
  serverMessageSchema,
} from './schemas';

// ── Client → Server ────────────────────────────────────────────────

export type ContextSubscribeMessage = z.infer<typeof contextSubscribeMessageSchema>;
export type ContextUnsubscribeMessage = z.infer<typeof contextUnsubscribeMessageSchema>;
export type ClientMessage = z.infer<typeof clientMessageSchema>;

// ── Server → Client ────────────────────────────────────────────────

export type EventMessage = z.infer<typeof eventMessageSchema>;
export type ErrorMessage = z.infer<typeof errorMessageSchema>;
export type ServerMessage = z.infer<typeof serverMessageSchema>;

// ── Config ─────────────────────────────────────────────────────────

export type EventServiceConfig = {
  url: string;
  getToken: () => Promise<string>;
  /**
   * Called when the WebSocket upgrade is rejected (typically 401/403, though
   * browsers do not expose the HTTP status of a failed handshake). The client
   * marks itself destroyed and stops reconnecting; the caller should clear any
   * cached token and trigger re-authentication.
   */
  onUnauthorized?: () => void;
};
