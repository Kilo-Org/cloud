import {
  CloudAgentAssistantFailureReasonSchema,
  CloudAgentProviderOwnershipSchema,
  WorkspaceFailureSubtypeSchema,
} from '@kilocode/worker-utils/cloud-agent-failure';
import { z } from 'zod';
import { isTerminalMessage, type MessageReduction, type SessionMessage } from './messages.js';

const messageSettlementSchema = z.object({
  facts: z
    .object({
      assistantReason: CloudAgentAssistantFailureReasonSchema.optional(),
      providerOwnership: CloudAgentProviderOwnershipSchema.optional(),
      workspaceSubtype: WorkspaceFailureSubtypeSchema.optional(),
      gateResult: z.enum(['pass', 'fail']).optional(),
    })
    .optional(),
  assistantMessageId: z.string().min(1).optional(),
  branch: z.string().optional(),
});

export type MessageSettlement = z.infer<typeof messageSettlementSchema>;

export function parseMessageSettlement(raw: string | null): MessageSettlement | undefined {
  if (raw === null) return undefined;
  try {
    const parsed = messageSettlementSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function serializeMessageSettlement(
  settlement: MessageSettlement | undefined
): string | null {
  return settlement === undefined ? null : JSON.stringify(settlement);
}

export function withMessageSettlements(
  reduction: MessageReduction,
  settlementFor: (message: SessionMessage) => MessageSettlement
): MessageReduction {
  const settled = new Map<string, SessionMessage>();
  const changed = reduction.changed.map(message => {
    if (!isTerminalMessage(message.state)) return message;
    const updated = { ...message, settlement: settlementFor(message) };
    settled.set(message.messageId, updated);
    return updated;
  });
  return {
    ...reduction,
    changed,
    messages: reduction.messages.map(message => settled.get(message.messageId) ?? message),
  };
}
