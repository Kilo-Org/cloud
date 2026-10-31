import * as z from 'zod';
import {
  kiloSdkAssistantMessageSchema,
  kiloSdkUserMessageSchema,
  kiloSdkPartSchema,
  sessionIdSchema,
  kilo2ConversationSourceSchema,
  kilo2MessageSchema,
} from '@kilocode/session-ingest-contracts';
import { readKilo2Messages } from './kilo2-source-messages';
import type {
  CloudAgentSessionId,
  CloudSessionSnapshotPage,
  MessageInfo,
  Part,
  SessionGoal,
} from './types';

export const cloudAgentSessionIdSchema = z.custom<CloudAgentSessionId>(
  value => typeof value === 'string' && value.length > 0
);

export const mutationCursorSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const cloudAgentEventSchema = z.object({
  eventId: z.number(),
  cursor: mutationCursorSchema.optional(),
  executionId: z.string().nullable().optional(),
  sessionId: z.string(),
  streamEventType: z.string(),
  timestamp: z.string(),
  data: z.unknown(),
});
export type CloudAgentEvent = z.infer<typeof cloudAgentEventSchema>;

export function isValidCloudAgentEvent(event: unknown): event is CloudAgentEvent {
  return cloudAgentEventSchema.safeParse(event).success;
}

export const cloudSessionMetadataSchema = z.object({
  sessionId: z.string().min(1),
  kiloSessionId: z.string().optional(),
  orgId: z.string().optional(),
  title: z.string().nullable().optional(),
  githubRepo: z.string().optional(),
  gitUrl: z.string().optional(),
  branchName: z.string().optional(),
  upstreamBranch: z.string().optional(),
  worktreeId: z.string().nullable().optional(),
  mode: z.string().optional(),
  model: z.string().optional(),
  variant: z.string().optional(),
  preparedAt: z.number().optional(),
  initiatedAt: z.number().optional(),
  routeReady: z.boolean().optional(),
  prompt: z.string().optional(),
  initialMessageId: z.string().optional(),
  associatedPr: z
    .object({
      url: z.string(),
      number: z.number(),
      state: z.string(),
      title: z.string().nullable(),
      headSha: z.string().nullable(),
      lastSyncedAt: z.string(),
      platform: z.string().optional(),
      reviewDecision: z.enum(['approved', 'changes_requested', 'review_required']).nullable(),
      reviewDecisionPending: z.boolean(),
    })
    .nullable()
    .optional(),
  totalCostMicrodollars: z.number().finite().nonnegative().nullable().optional(),
  createdOnPlatform: z.string().nullable().optional(),
  profileId: z.string().nullable().optional(),
  runtimeAgents: z
    .array(
      z.object({
        slug: z.string(),
        name: z.string(),
        model: z.string().optional(),
        variant: z.string().optional(),
      })
    )
    .optional(),
});

const sessionGoalSchema = z
  .object({
    text: z.string().min(1),
    status: z.enum(['active', 'complete', 'blocked', 'paused']),
    reason: z.string().min(1).optional().catch(undefined),
  })
  .transform(goal => ({
    text: goal.text,
    status: goal.status,
    ...(goal.reason === undefined ? {} : { reason: goal.reason }),
  }));

export function projectSessionGoal(rawMetadata: unknown): SessionGoal | undefined {
  if (typeof rawMetadata !== 'object' || rawMetadata === null) return undefined;
  const direct = sessionGoalSchema.safeParse(
    'kilo.goal' in rawMetadata ? rawMetadata['kilo.goal'] : undefined
  );
  if (direct.success) return direct.data;
  if (
    'kilo' in rawMetadata &&
    typeof rawMetadata.kilo === 'object' &&
    rawMetadata.kilo !== null &&
    'goal' in rawMetadata.kilo
  ) {
    const nested = sessionGoalSchema.safeParse(rawMetadata.kilo.goal);
    if (nested.success) return nested.data;
  }
  return undefined;
}

const cloudSessionInfoSchema = z
  .object({
    id: z.string().min(1),
    parentID: z.string().optional(),
    title: z.string().optional(),
    model: z
      .object({ providerID: z.string(), id: z.string(), variant: z.string().optional() })
      .optional(),
    goal: sessionGoalSchema.optional(),
    metadata: z.unknown().optional(),
  })
  .transform(({ metadata, ...info }) => {
    const goal = info.goal ?? projectSessionGoal(metadata);
    return { ...info, ...(goal ? { goal } : {}) };
  });

const cloudMessageSchema = z.discriminatedUnion('role', [
  kiloSdkUserMessageSchema.extend({
    summary: z
      .object({
        title: z.string().optional(),
        body: z.string().optional(),
        diffs: z.array(
          z.object({
            file: z.string(),
            before: z.string(),
            after: z.string(),
            additions: z.number(),
            deletions: z.number(),
            status: z.enum(['added', 'deleted', 'modified']).optional(),
          })
        ),
      })
      .optional(),
    variant: z.string().optional(),
  }),
  kiloSdkAssistantMessageSchema,
]);

export function normalizeAssistantMessageError(value: unknown): unknown {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('role' in value) ||
    value.role !== 'assistant' ||
    !('error' in value) ||
    typeof value.error !== 'string'
  ) {
    return value;
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(value.error);
  } catch {
    decoded = undefined;
  }
  const parsed = kiloSdkAssistantMessageSchema.shape.error.safeParse(decoded);
  return {
    ...value,
    error:
      parsed.success && parsed.data !== undefined
        ? parsed.data
        : { name: 'UnknownError', data: { message: value.error } },
  };
}

export const cloudMessageInfoSchema = z.preprocess(
  value => {
    value = normalizeAssistantMessageError(value);
    if (
      typeof value !== 'object' ||
      value === null ||
      !('role' in value) ||
      value.role !== 'user' ||
      !('summary' in value) ||
      typeof value.summary !== 'object' ||
      value.summary === null ||
      'diffs' in value.summary
    ) {
      return value;
    }
    return { ...value, summary: { ...value.summary, diffs: [] } };
  },
  z.custom<MessageInfo>(value => cloudMessageSchema.safeParse(value).success)
);

export const cloudMessagePartSchema = z.preprocess(
  value => {
    if (typeof value !== 'object' || value === null || !('type' in value)) return value;
    if ((value.type === 'text' || value.type === 'reasoning') && !('text' in value)) {
      return { ...value, text: '' };
    }
    if (value.type === 'patch' && !('files' in value)) {
      return { ...value, files: [] };
    }
    if (
      value.type === 'tool' &&
      'state' in value &&
      typeof value.state === 'object' &&
      value.state !== null &&
      'status' in value.state &&
      value.state.status === 'completed' &&
      !('metadata' in value.state)
    ) {
      return { ...value, state: { ...value.state, metadata: {} } };
    }
    return value;
  },
  z.custom<Part>(value => kiloSdkPartSchema.safeParse(value).success)
);

export const cloudSessionMessagesPageInputSchema = z.object({
  sessionId: z.string().pipe(z.templateLiteral(['workspace_', z.uuid()])),
  kiloSessionId: sessionIdSchema.optional(),
  cursor: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

const cloudV1MessagesPageWireSchema = z.object({
  source: z.object({ version: z.literal('v1') }).optional(),
  kind: z.literal('success'),
  info: cloudSessionInfoSchema,
  messages: z.array(z.object({ info: z.unknown(), parts: z.array(z.unknown()) })),
  nextCursor: z.string().nullable(),
  omittedItemCount: z.number().int().nonnegative(),
  updateCursor: mutationCursorSchema,
  totalCostMicrodollars: cloudSessionMetadataSchema.shape.totalCostMicrodollars,
});

export const cloudSessionMessagesPageWireSchema = z
  .union([
    cloudV1MessagesPageWireSchema,
    cloudV1MessagesPageWireSchema.extend({
      source: kilo2ConversationSourceSchema,
      messages: z.array(z.object({ message: z.unknown(), parentID: z.string().optional() })),
    }),
  ])
  .nullable();
export type CloudSessionMessagesWirePage = z.infer<typeof cloudSessionMessagesPageWireSchema>;

export const cloudSessionMessagesPageSchema = cloudSessionMessagesPageWireSchema.transform(
  (page): CloudSessionSnapshotPage | null => {
    if (page === null) return null;
    if (page.source?.version === 'v2') {
      const native = cloudV1MessagesPageWireSchema
        .extend({
          source: kilo2ConversationSourceSchema,
          messages: z.array(z.object({ message: z.unknown(), parentID: z.string().optional() })),
        })
        .parse(page);
      const messages: CloudSessionSnapshotPage['messages'] = [];
      let omittedItemCount = native.omittedItemCount;
      if (native.source.session.id !== native.info.id)
        throw new Error('Conversation source belongs to another session');
      for (const item of native.messages) {
        const parsed = kilo2MessageSchema.safeParse(item.message);
        if (!parsed.success) {
          omittedItemCount++;
          continue;
        }
        const display = readKilo2Messages(native.source.session, [parsed.data])[0];
        if (!display) continue;
        if (display.info.role === 'assistant' && item.parentID !== undefined)
          display.info.parentID = item.parentID;
        messages.push(display);
      }
      const { source, ...metadata } = native;
      return { ...metadata, sourceVersion: source.version, messages, omittedItemCount };
    }
    const v1 = cloudV1MessagesPageWireSchema.parse(page);
    const messages: CloudSessionSnapshotPage['messages'] = [];
    let omittedItemCount = page.omittedItemCount;
    for (const message of v1.messages) {
      const info = cloudMessageInfoSchema.safeParse(message.info);
      if (!info.success || info.data.sessionID !== page.info.id) {
        omittedItemCount += 1 + message.parts.length;
        continue;
      }
      const parts: Part[] = [];
      for (const value of message.parts) {
        const part = cloudMessagePartSchema.safeParse(value);
        if (
          part.success &&
          part.data.sessionID === info.data.sessionID &&
          part.data.messageID === info.data.id
        ) {
          parts.push(part.data);
        } else {
          omittedItemCount += 1;
        }
      }
      messages.push({ info: info.data, parts });
    }
    return { ...page, messages, omittedItemCount };
  }
) satisfies z.ZodType<CloudSessionSnapshotPage | null>;
