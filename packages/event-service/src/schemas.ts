import { z } from 'zod';

// ── HTTP responses ─────────────────────────────────────────────────

export const connectTicketResponseSchema = z.object({
  ticket: z.string(),
  userId: z.string(),
});

// ── Client → Server ────────────────────────────────────────────────

export const contextSubscribeMessageSchema = z.object({
  type: z.literal('context.subscribe'),
  contexts: z.array(z.string()),
});

export const contextUnsubscribeMessageSchema = z.object({
  type: z.literal('context.unsubscribe'),
  contexts: z.array(z.string()),
});

export const clientMessageSchema = z.discriminatedUnion('type', [
  contextSubscribeMessageSchema,
  contextUnsubscribeMessageSchema,
]);

// ── Server → Client ────────────────────────────────────────────────

export const eventMessageSchema = z.object({
  type: z.literal('event'),
  context: z.string(),
  event: z.string(),
  payload: z.unknown(),
});

export const serverMessageSchema = eventMessageSchema;
