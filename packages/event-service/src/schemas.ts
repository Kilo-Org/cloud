import { z } from 'zod';

// ── Client → Server ────────────────────────────────────────────────

export const MAX_CONTEXTS = 200;
export const MAX_CONTEXT_LENGTH = 256;
const contextSchema = z.string().min(1).max(MAX_CONTEXT_LENGTH);

export const contextSubscribeMessageSchema = z.object({
  type: z.literal('context.subscribe'),
  contexts: z.array(contextSchema).max(MAX_CONTEXTS),
});

export const contextUnsubscribeMessageSchema = z.object({
  type: z.literal('context.unsubscribe'),
  contexts: z.array(contextSchema).max(MAX_CONTEXTS),
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

export const errorMessageSchema = z.object({
  type: z.literal('error'),
  code: z.enum(['too_many_contexts']),
  max: z.number().int().positive(),
});

export const serverMessageSchema = z.discriminatedUnion('type', [
  eventMessageSchema,
  errorMessageSchema,
]);
