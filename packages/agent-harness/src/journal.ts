import { z } from 'zod';
import { canonicalizeValidatedInput, CommandSchema, type Command } from './commands';
import { ErrorSchema, ExecutionGrantSchema, ToolCallSchema, ToolOutcomeSchema } from './contracts';
import { AGENT_HARNESS_PROTOCOL_VERSION } from './version';

export const JournalScopeSchema = z
  .strictObject({ ownerUserId: z.string().min(1), clientId: z.uuid(), storageGeneration: z.uuid() })
  .readonly();
export type JournalScope = z.infer<typeof JournalScopeSchema>;
export const CommandReplySchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('accepted'), commandId: z.uuid(), result: z.json() }),
  z.strictObject({ status: z.literal('rejected'), commandId: z.uuid(), error: ErrorSchema }),
]);
export type CommandReply = z.infer<typeof CommandReplySchema>;
export const CommandIntentSchema = z
  .strictObject({
    command: CommandSchema,
    canonicalInput: z.string(),
    reviewOf: z.uuid().optional(),
  })
  .refine(intent => canonicalizeValidatedInput(intent.command) === intent.canonicalInput);
export type CommandIntent = z.infer<typeof CommandIntentSchema>;
const AcknowledgmentSchema = z
  .strictObject({ intent: CommandIntentSchema, reply: CommandReplySchema })
  .refine(ack => ack.intent.command.commandId === ack.reply.commandId);
export const ExecutionRequestSchema = z.strictObject({
  toolCall: ToolCallSchema,
  grant: ExecutionGrantSchema,
  completionCommandId: z.uuid(),
});
export const ExecutionIntentSchema = ExecutionRequestSchema.extend({
  receipt: ToolOutcomeSchema.nullable(),
}).refine(
  ({ toolCall, grant }) =>
    toolCall.executionTarget.kind === 'client' &&
    toolCall.executionTarget.clientId === grant.clientId &&
    toolCall.id === grant.toolCallId &&
    toolCall.definitionVersion === grant.definitionVersion &&
    canonicalizeValidatedInput(toolCall.context) === canonicalizeValidatedInput(grant.context)
);
export type ExecutionIntent = z.infer<typeof ExecutionIntentSchema>;
export type ExecutionRequest = z.infer<typeof ExecutionRequestSchema>;
export function completionCommand(execution: ExecutionIntent): Command {
  if (!execution.receipt) throw new Error('A committed receipt is required');
  return CommandSchema.parse({
    type: 'completeClientTool',
    protocolVersion: AGENT_HARNESS_PROTOCOL_VERSION,
    commandId: execution.completionCommandId,
    clientId: execution.grant.clientId,
    conversationId: execution.grant.conversationId,
    toolCallId: execution.grant.toolCallId,
    grantId: execution.grant.id,
    generation: execution.grant.generation,
    result: execution.receipt,
  });
}
export const executionKey = (execution: ExecutionRequest) =>
  `${execution.grant.conversationId}:${execution.toolCall.id}`;
const unique = (values: string[]) => new Set(values).size === values.length;
export const JournalSnapshotSchema = z
  .strictObject({
    scope: JournalScopeSchema,
    revision: z.int().nonnegative(),
    intents: z.array(CommandIntentSchema),
    acknowledgments: z.array(AcknowledgmentSchema),
    executions: z.array(ExecutionIntentSchema),
  })
  .refine(state => {
    const records = [...state.intents, ...state.acknowledgments.map(ack => ack.intent)];
    return (
      unique(state.intents.map(intent => intent.command.commandId)) &&
      unique(state.acknowledgments.map(ack => ack.reply.commandId)) &&
      unique(state.executions.map(executionKey)) &&
      unique(state.executions.map(execution => execution.completionCommandId)) &&
      state.executions.every(
        execution =>
          execution.grant.ownerUserId === state.scope.ownerUserId &&
          execution.grant.clientId === state.scope.clientId
      ) &&
      records.every(intent => {
        const command = intent.command;
        const ack = state.acknowledgments.find(item => item.reply.commandId === command.commandId);
        const reviewed = state.acknowledgments.find(
          item => item.reply.commandId === intent.reviewOf
        );
        return (
          command.clientId === state.scope.clientId &&
          !state.executions.some(
            execution =>
              execution.completionCommandId === command.commandId &&
              command.type !== 'completeClientTool'
          ) &&
          (!ack || canonicalizeValidatedInput(ack.intent) === canonicalizeValidatedInput(intent)) &&
          (!intent.reviewOf ||
            (reviewed?.reply.status === 'rejected' &&
              reviewed.reply.error.code === 'stale_revision' &&
              reviewed.intent.command.type === 'sendMessage' &&
              command.type === 'sendMessage' &&
              command.commandId !== intent.reviewOf &&
              command.conversationId === reviewed.intent.command.conversationId)) &&
          (command.type !== 'completeClientTool' ||
            state.executions.some(
              execution =>
                execution.receipt !== null &&
                canonicalizeValidatedInput(completionCommand(execution)) === intent.canonicalInput
            ))
        );
      })
    );
  });
export type JournalSnapshot = z.infer<typeof JournalSnapshotSchema>;

// Initialize a generation only for a fresh clientId during registration. Storage loss must suspend the old
// registration, never reuse its grants. Missing/corrupt storage is an error, never an empty journal.
// Reads must return one atomic, durable, exactly scoped snapshot.
export type HarnessJournal = {
  read: (scope: JournalScope) => Promise<unknown>;
  // Compare scope AND revision in one strictly durable transaction. Resolve true only after commit;
  // false means no write. Reject uncertain commits. Never replace, reset, or fall back to memory.
  compareAndSwap: (
    scope: JournalScope,
    expectedRevision: number,
    next: JournalSnapshot
  ) => Promise<boolean>;
};
