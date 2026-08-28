// The MCP barrel includes Web globals. Use this source entry until it has a portable public export.
import { GatewayExecutionContextSchema } from '../../mcp-gateway/src/types';
import { z } from 'zod';
import { AGENT_HARNESS_PROTOCOL_VERSION } from './version';

const Id = z.uuid();
const Name = z.string().min(1);
const Timestamp = z.iso.datetime();
export const ProtocolVersionSchema = z.literal(AGENT_HARNESS_PROTOCOL_VERSION);
export const ContextSchema = GatewayExecutionContextSchema.readonly();
export const PermissionModeSchema = z.enum(['ask', 'yolo']);
export const EventCursorSchema = z.int().nonnegative();
// Keep the deployed opaque keyset cursor; it is not a durable event sequence.
export const HistoryCursorSchema = Name;
export const ErrorSchema = z.strictObject({
  code: z.enum([
    'stale_revision',
    'command_conflict',
    'access_revoked',
    'retired',
    'storage_unavailable',
    'unsupported_protocol',
    'unavailable_tool',
    'reauthorization_required',
    'invalid_input',
    'invalid_output',
    'limit_exceeded',
    'cancelled',
    'outcome_unknown',
  ]),
  message: z.string(),
  retryable: z.boolean(),
});

// Legacy stored settings omit mode/revision. Keep these defaults until old writers and records are gone.
export const ConversationSchema = z
  .strictObject({
    id: Id,
    ownerUserId: z.string(),
    context: ContextSchema,
    permissionMode: PermissionModeSchema.default('ask'),
    permissionRevision: EventCursorSchema.default(0),
  })
  .readonly();
export const WaitingSchema = z.strictObject({
  toolCallId: Id,
  reason: z.enum(['approval', 'question', 'client', 'reconciliation']),
});
export const RunStateSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal(['queued', 'running', 'stopping', 'completed', 'cancelled']),
  }),
  z.strictObject({ status: z.literal('waiting'), waiting: WaitingSchema }),
  z.strictObject({ status: z.literal('failed'), error: ErrorSchema }),
]);
export const RunSchema = z
  .strictObject({
    id: Id,
    conversationId: Id,
    inputMessageId: Id,
    originClientId: Id,
    modelId: Name,
    variant: Name.optional(),
    state: RunStateSchema,
  })
  .readonly();

// Readonly containers also protect nested validated arguments, not just the call's outer record.
type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema).readonly(),
    z.record(z.string(), JsonValueSchema).readonly(),
  ])
);
export const ToolOutcomeSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('succeeded'), output: JsonValueSchema }),
  z.strictObject({ status: z.literal('failed'), error: ErrorSchema }),
  z.strictObject({ status: z.literal(['denied', 'cancelled']) }),
  z.strictObject({
    status: z.literal('outcome_unknown'),
    reason: Name,
    providerReference: Name.optional(),
  }),
]);
export const ExecutionTargetSchema = z
  .discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('backend') }),
    z.strictObject({ kind: z.literal('client'), clientId: Id }),
    z.strictObject({ kind: z.literal('interaction') }),
  ])
  .readonly();
export const ApprovalRecordSchema = z
  .strictObject({
    interactionId: Id,
    commandId: Id,
    decision: z.enum(['approve', 'deny']),
  })
  .readonly();
export const ToolCallSchema = z
  .strictObject({
    id: Id,
    runId: Id,
    name: Name,
    definitionVersion: Name,
    arguments: z.record(z.string(), JsonValueSchema).readonly(),
    context: ContextSchema,
    effect: z.enum(['read', 'side_effect', 'unknown']),
    executionTarget: ExecutionTargetSchema,
    approval: ApprovalRecordSchema.nullable(),
    state: z.enum(['pending', 'waiting', 'executing', 'settled']),
    result: ToolOutcomeSchema.nullable(),
  })
  .refine(call => (call.state === 'settled') === (call.result !== null))
  .readonly();
export const InteractionSchema = z
  .discriminatedUnion('kind', [
    z.strictObject({
      id: Id,
      kind: z.literal('approval'),
      toolCall: ToolCallSchema,
      resolution: ApprovalRecordSchema.nullable(),
    }),
    z.strictObject({
      id: Id,
      kind: z.literal('question'),
      toolCall: ToolCallSchema,
      questionId: Name,
      resolution: z
        .discriminatedUnion('kind', [
          z.strictObject({
            kind: z.literal('answer'),
            choiceIds: z.array(Name),
            text: z.string().optional(),
          }),
          z.strictObject({ kind: z.literal('dismiss') }),
        ])
        .nullable(),
    }),
  ])
  .readonly();
export const ClientSchema = z
  .strictObject({
    id: Id,
    ownerUserId: z.string(),
    kind: z.enum(['browser', 'mobile']),
    supportedTools: z.array(z.strictObject({ name: Name, version: Name })),
    revokedAt: Timestamp.nullable(),
  })
  .readonly();
export const ExecutionGrantSchema = z
  .strictObject({
    id: Id,
    conversationId: Id,
    ownerUserId: z.string(),
    clientId: Id,
    toolCallId: Id,
    context: ContextSchema,
    definitionVersion: Name,
    inputDigest: Name,
    generation: EventCursorSchema,
    expiresAt: Timestamp,
  })
  .readonly();
export const PendingClientActionSchema = z
  .strictObject({
    toolCall: ToolCallSchema,
    grant: ExecutionGrantSchema.nullable(),
    reason: z.enum(['offline', 'background', 'locked', 'gesture', 'unavailable', 'reconciliation']),
  })
  .refine(action => action.toolCall.executionTarget.kind === 'client');

export const MessagePartSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('text'), text: z.string() }),
  // Snapshots, history pages, and message events must carry the record without a separate call lookup.
  z.strictObject({ type: z.literal('tool_call'), toolCall: ToolCallSchema }),
  z.strictObject({
    type: z.literal('citation'),
    url: z.url({ protocol: /^https?$/ }),
    title: Name,
  }),
]);
const MessageFieldsSchema = z.object({
  id: Id,
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  clientId: z.string().nullable().default(null),
  createdAt: Timestamp,
});
// Old append rows are text only, even with attached authority fields. Remove only after old clients/records are gone.
export const LegacyMessageSchema = MessageFieldsSchema.transform(message => ({
  ...message,
  provenance: 'legacy' as const,
  parts: [{ type: 'text' as const, text: message.content }],
}));
// Parsing is not authentication. Only trusted producers can supply harness provenance.
// Old producers omit provenance/parts; consumers always get both. Retain until old clients/records are gone.
export const MessageSchema = z.union([
  MessageFieldsSchema.extend({
    provenance: z.literal('harness'),
    protocolVersion: ProtocolVersionSchema,
    runId: Id,
    parts: z.array(MessagePartSchema).optional(),
    incomplete: z.boolean().default(false),
  })
    .strict()
    .transform(message => ({
      ...message,
      parts: message.parts ?? [{ type: 'text' as const, text: message.content }],
    })),
  MessageFieldsSchema.extend({
    provenance: z.literal('legacy').optional(),
    protocolVersion: ProtocolVersionSchema.optional(),
    // Old producers can attach ID-only parts. Discard them until old clients and records are gone.
    parts: z.unknown().optional(),
  }).transform(message => LegacyMessageSchema.parse(message)),
]);
export const SnapshotSchema = z.strictObject({
  protocolVersion: ProtocolVersionSchema,
  conversation: ConversationSchema,
  recentMessages: z.array(MessageSchema),
  historyCursor: HistoryCursorSchema.nullable(),
  activeRun: RunSchema.refine(run =>
    ['running', 'waiting', 'stopping'].includes(run.state.status)
  ).nullable(),
  queuedRuns: z.array(RunSchema.refine(run => run.state.status === 'queued')),
  unresolvedInteractions: z.array(
    InteractionSchema.refine(interaction => interaction.resolution === null)
  ),
  pendingClientActions: z.array(PendingClientActionSchema),
  eventCursor: EventCursorSchema,
});
export const EventEnvelopeSchema = z.strictObject({
  protocolVersion: ProtocolVersionSchema,
  conversationId: Id,
  sequence: EventCursorSchema.positive(),
  event: z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('conversation'), conversation: ConversationSchema }),
    z.strictObject({ type: z.literal('message'), message: MessageSchema }),
    z.strictObject({ type: z.literal('run'), run: RunSchema }),
    z.strictObject({ type: z.literal('interaction'), interaction: InteractionSchema }),
    z.strictObject({
      type: z.literal('client_action'),
      toolCallId: Id,
      action: PendingClientActionSchema.nullable(),
    }),
  ]),
});

export type ConversationProducer = z.input<typeof ConversationSchema>;
export type Conversation = z.output<typeof ConversationSchema>;
export type MessageProducer = z.input<typeof MessageSchema>;
export type Message = z.output<typeof MessageSchema>;
export type Run = z.infer<typeof RunSchema>;
export type ToolCall = z.infer<typeof ToolCallSchema>;
export type ToolOutcome = z.infer<typeof ToolOutcomeSchema>;
export type Interaction = z.infer<typeof InteractionSchema>;
export type Client = z.infer<typeof ClientSchema>;
export type ExecutionGrant = z.infer<typeof ExecutionGrantSchema>;
export type Snapshot = z.infer<typeof SnapshotSchema>;
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;
