// Webhook payload zod schemas and their inferred TypeScript types.
// Historical callers sent `message.created` payloads without a `type` field;
// the preprocess step injects the default so the discriminated union always
// matches. The action.executed schema narrows the shared webhook `value` to
// the approval decision enum at the plugin boundary.

import { z } from 'zod';
import type { ExecApprovalDecision } from 'openclaw/plugin-sdk/approval-runtime';

import { chatWebhookSchema, messageCreatedWebhookSchema } from '../shared/webhook-schemas.js';

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

const execApprovalDecisionSchema = z.enum(['allow-once', 'allow-always', 'deny']);

export type ActionExecutedPayload = {
  conversationId: string;
  messageId: string;
  groupId: string;
  value: ExecApprovalDecision;
  executedBy: string;
};

// The shared webhook schema keeps `value` as a free-form string so non-approval
// action producers can flow through. The plugin narrows it to the approval
// decision enum at this boundary, and only requires the fields it actually
// consumes — conversationId/messageId/executedAt are forwarded by the Worker
// but not needed to resolve the approval.
const actionExecutedPluginSchema = z.preprocess(
  withDefaultType('action.executed'),
  z.object({
    type: z.literal('action.executed'),
    conversationId: z.string().min(1),
    messageId: z.string().min(1),
    groupId: z.string().min(1),
    value: execApprovalDecisionSchema,
    executedBy: z.string().min(1),
  })
);

export function parseActionExecutedPayload(raw: unknown): ActionExecutedPayload | null {
  const result = actionExecutedPluginSchema.safeParse(raw);
  if (!result.success) return null;
  return {
    conversationId: result.data.conversationId,
    messageId: result.data.messageId,
    groupId: result.data.groupId,
    value: result.data.value,
    executedBy: result.data.executedBy,
  };
}
