// Webhook payload zod schemas and their inferred TypeScript types.
// Historical callers sent `message.created` payloads without a `type` field;
// the preprocess step injects the default so the discriminated union always
// matches. The action.executed schema narrows `value` to the approval decision
// enum in the single source-of-truth synced schema.

import { z } from 'zod';

import {
  actionExecutedWebhookSchema,
  chatWebhookSchema,
  messageCreatedWebhookSchema,
} from '../synced/webhook-schemas.js';

const rawObjectSchema = z.record(z.string(), z.unknown());

export function withDefaultType(defaultType: string) {
  return (raw: unknown): unknown => {
    const obj = rawObjectSchema.safeParse(raw);
    if (!obj.success) return raw;
    return 'type' in obj.data ? obj.data : { ...obj.data, type: defaultType };
  };
}

export const messageCreatedInboundSchema = z.preprocess(
  withDefaultType('message.created'),
  messageCreatedWebhookSchema
);

export const chatWebhookInboundSchema = z.preprocess(
  withDefaultType('message.created'),
  chatWebhookSchema
);

export type KiloChatInboundPayload = z.infer<typeof messageCreatedWebhookSchema>;

export function parseInboundPayload(raw: unknown): KiloChatInboundPayload | null {
  const result = messageCreatedInboundSchema.safeParse(raw);
  return result.success ? result.data : null;
}

export type ActionExecutedPayload = z.infer<typeof actionExecutedWebhookSchema>;

const actionExecutedInboundSchema = z.preprocess(
  withDefaultType('action.executed'),
  actionExecutedWebhookSchema
);

export function parseActionExecutedPayload(raw: unknown): ActionExecutedPayload | null {
  const result = actionExecutedInboundSchema.safeParse(raw);
  return result.success ? result.data : null;
}
