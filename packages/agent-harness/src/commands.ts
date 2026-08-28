import { z } from 'zod';
import {
  ClientSchema,
  ContextSchema,
  EventCursorSchema,
  HistoryCursorSchema,
  PermissionModeSchema,
  ProtocolVersionSchema,
  ToolOutcomeSchema,
} from './contracts';
import { QuestionResponseSchema, ToolNameSchema, toolDefinitions } from './tools';

const Id = z.uuid();
const Text = z
  .string()
  .min(1)
  .refine(value => value.trim().length > 0);
const envelope = { protocolVersion: ProtocolVersionSchema, clientId: Id };
const mutation = { ...envelope, commandId: Id };
const scoped = { ...mutation, conversationId: Id };
const capability = z
  .strictObject({ name: ToolNameSchema, version: Text })
  .refine(value =>
    toolDefinitions.some(tool => tool.name === value.name && tool.executorKind === 'client')
  );
export const CommandSchema = z.discriminatedUnion('type', [
  z.strictObject({
    ...mutation,
    type: z.literal('getOrCreateConversation'),
    context: ContextSchema,
  }),
  z.strictObject({
    ...scoped,
    type: z.literal('sendMessage'),
    text: Text,
    modelId: Text,
    variant: Text.optional(),
    permissionRevision: EventCursorSchema,
  }),
  z
    .strictObject({
      ...scoped,
      type: z.literal('setPermissionMode'),
      permissionMode: PermissionModeSchema,
      expectedPermissionRevision: EventCursorSchema,
      acknowledgePendingActions: z.boolean().default(false),
    })
    .refine(command => command.permissionMode !== 'yolo' || command.acknowledgePendingActions),
  z.strictObject({
    ...scoped,
    type: z.literal('resolveInteraction'),
    interactionId: Id,
    resolution: z.union([
      z.strictObject({ kind: z.literal(['approve', 'deny']) }),
      QuestionResponseSchema,
    ]),
  }),
  z.strictObject({ ...scoped, type: z.literal('cancelRun'), runId: Id }),
  z.strictObject({ ...scoped, type: z.literal('claimClientTool'), toolCallId: Id }),
  z.strictObject({
    ...scoped,
    type: z.literal('completeClientTool'),
    toolCallId: Id,
    grantId: Id,
    generation: EventCursorSchema,
    result: ToolOutcomeSchema,
  }),
  z.strictObject({
    ...mutation,
    type: z.literal('registerClient'),
    kind: ClientSchema.unwrap().shape.kind,
    supportedTools: z.array(capability),
  }),
  z.strictObject({ ...mutation, type: z.literal('revokeClient') }),
]);
const read = { ...envelope, conversationId: Id };
export const ReadInputSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...read, type: z.literal(['getConversation', 'getSnapshot']) }),
  z.strictObject({ ...read, type: z.literal('getCommand'), commandId: Id }),
  z.strictObject({
    ...read,
    type: z.literal('getEvents'),
    after: EventCursorSchema,
    limit: z.int().min(1).max(200).default(200),
  }),
  z.strictObject({
    ...read,
    type: z.literal('getHistory'),
    before: HistoryCursorSchema.nullable().default(null),
    limit: z.int().min(1).max(200).default(50),
  }),
]);
export type Command = z.infer<typeof CommandSchema>;
export type ReadInput = z.infer<typeof ReadInputSchema>;

// Call only on validated JSON records. Optional undefined fields serialize as absent.
export function canonicalizeValidatedInput(input: unknown): string {
  return JSON.stringify(input, (_key, value: unknown) =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : value
  );
}
const AuthoritySchema = z.object({ actorUserId: Text, conversationId: Id.nullable() });
// The caller derives authority from authentication and thread lookup, never from model input.
// Inject the platform's SHA-256 implementation; no crypto globals enter the portable core.
export async function fingerprintCommand(
  authority: z.infer<typeof AuthoritySchema>,
  input: unknown,
  sha256: (canonicalInput: string) => string | Promise<string>
): Promise<string> {
  const scope = AuthoritySchema.parse(authority);
  const command = CommandSchema.parse(input);
  if ('conversationId' in command && command.conversationId !== scope.conversationId) {
    throw new Error('Conversation does not match authenticated scope');
  }
  return sha256(canonicalizeValidatedInput({ ...scope, command }));
}
export function commandReplayDecision(stored: string | undefined, incoming: string) {
  return stored === undefined ? 'new' : stored === incoming ? 'replay' : 'command_conflict';
}
