import { createHash } from 'node:crypto';
import { desc, eq, gt } from 'drizzle-orm';
import { z } from 'zod';
import {
  CommandSchema,
  canonicalizeValidatedInput,
  fingerprintCommand,
  type Command,
} from '@kilocode/agent-harness/commands';
import {
  ClientSchema,
  ConversationSchema,
  ErrorSchema,
  InteractionSchema,
  type Interaction,
  type ToolCall,
  type EventEnvelope,
} from '@kilocode/agent-harness/contracts';
import { CommandReplySchema, type CommandReply } from '@kilocode/agent-harness/journal';
import { QuestionSchema } from '@kilocode/agent-harness/tools';
import type { StoreDatabase } from './db/records';
import type { ConversationStore } from './db/store';
import * as s from './db/sqlite-schema';
import { StoreError } from './db/wake';
import { RuntimeError, fail } from './limits';
import { jsonValue } from './model-step';

export type InteractionCommand = Extract<Command, { type: 'resolveInteraction' }>;
const AuthoritySchema = z.strictObject({
  conversation: ConversationSchema,
  client: ClientSchema,
  origin: z.enum(['user', 'agent']),
});
export type InteractionAuthorizer = (
  command: InteractionCommand
) => Promise<z.input<typeof AuthoritySchema> | { error: z.infer<typeof ErrorSchema> }>;
type Changes = ReturnType<Parameters<ConversationStore['transition']>[1]>;
const rejected = (commandId: string, error: z.infer<typeof ErrorSchema>): CommandReply => ({
  status: 'rejected',
  commandId,
  error,
});

export function waitForInteraction(
  store: ConversationStore,
  toolCall: ToolCall,
  kind: Interaction['kind']
): EventEnvelope['event'] {
  const existing = store
    .snapshot()
    ?.unresolvedInteractions.find(item => item.kind === kind && item.toolCall.id === toolCall.id);
  return {
    type: 'interaction',
    interaction: InteractionSchema.parse(
      existing
        ? { ...existing, toolCall }
        : {
            id: crypto.randomUUID(),
            kind,
            toolCall,
            resolution: null,
            ...(kind === 'question'
              ? { questionId: QuestionSchema.parse(toolCall.arguments).questionId }
              : {}),
          }
    ),
  };
}

// A disclosed YOLO change permits pending actions, but does not create an exact-call approval.
// Stop resolves controls as well as calls. Both decisions reference their actual durable user command.
export function closeInteraction(
  db: StoreDatabase,
  store: ConversationStore,
  call: ToolCall,
  decision: 'approve' | 'deny'
): EventEnvelope['event'][] {
  const snapshot = store.snapshot();
  return (snapshot?.unresolvedInteractions ?? [])
    .filter(
      item => item.toolCall.id === call.id && (decision === 'deny' || item.kind === 'approval')
    )
    .map(interaction => {
      if (interaction.kind === 'question')
        return {
          type: 'interaction',
          interaction: { ...interaction, toolCall: call, resolution: { kind: 'dismiss' } },
        };
      const row = db
        .select()
        .from(s.interactions)
        .where(eq(s.interactions.id, interaction.id))
        .get();
      // The first accepted result for a new revision is its mode command, not a later settings read.
      const source = db
        .select()
        .from(s.commands)
        .where(gt(s.commands.sequence, row?.sequence ?? 0))
        .orderBy(desc(s.commands.sequence))
        .all()
        .reverse()
        .find(row => {
          const reply = CommandReplySchema.parse(row.reply);
          if (reply.status !== 'accepted') return false;
          return decision === 'approve'
            ? z.object({ conversation: ConversationSchema }).safeParse(reply.result).data
                ?.conversation.permissionMode === 'yolo'
            : z
                .object({
                  runId: z.literal(call.runId),
                  state: z.object({ status: z.literal('stopping') }),
                })
                .safeParse(reply.result).success;
        });
      if (!source) fail('invalid_input', 'The interaction has no durable policy or Stop decision.');
      return {
        type: 'interaction',
        interaction: {
          ...interaction,
          toolCall: call,
          resolution: { interactionId: interaction.id, commandId: source.id, decision },
        },
      };
    });
}

// Authorization supplies identity; the scheduler supplies the only state transition and never executes here.
export async function resolveInteractionCommand(
  store: ConversationStore,
  input: unknown,
  authorize: InteractionAuthorizer,
  apply: (
    db: StoreDatabase,
    interaction: Interaction,
    command: InteractionCommand
  ) => { interaction: Interaction; events: Changes['events'] },
  now: () => number
): Promise<CommandReply> {
  const envelope = z.object({ commandId: z.uuid(), protocolVersion: z.unknown() }).parse(input);
  const parsed = CommandSchema.safeParse(input);
  if (!parsed.success || parsed.data.type !== 'resolveInteraction')
    return rejected(envelope.commandId, {
      code: envelope.protocolVersion === 1 ? 'invalid_input' : 'unsupported_protocol',
      message: 'The interaction command is invalid.',
      retryable: false,
    });
  const command = parsed.data;
  try {
    const authorization = await authorize(command);
    if ('error' in authorization)
      return rejected(command.commandId, ErrorSchema.parse(authorization.error));
    const { conversation, client, origin } = AuthoritySchema.parse(authorization);
    const current = store.snapshot()?.conversation;
    if (
      !current ||
      origin !== 'user' ||
      client.id !== command.clientId ||
      client.revokedAt !== null ||
      client.ownerUserId !== current.ownerUserId ||
      conversation.ownerUserId !== current.ownerUserId ||
      conversation.id !== current.id ||
      command.conversationId !== current.id ||
      canonicalizeValidatedInput(conversation.context) !==
        canonicalizeValidatedInput(current.context)
    )
      return rejected(command.commandId, {
        code: 'access_revoked',
        message: 'Current user, client, or context access is unavailable.',
        retryable: false,
      });
    const fingerprint = await fingerprintCommand(
      { actorUserId: current.ownerUserId, conversationId: current.id },
      command,
      text => createHash('sha256').update(text).digest('hex')
    );
    const options = { command: { id: command.commandId, fingerprint }, wakeAt: now() };
    const reply = await store
      .transition(options, db => {
        const row = db
          .select()
          .from(s.interactions)
          .where(eq(s.interactions.id, command.interactionId))
          .get();
        if (!row)
          return {
            events: [],
            reply: rejected(command.commandId, {
              code: 'invalid_input',
              message: 'The interaction does not exist.',
              retryable: false,
            }),
          };
        const interaction = InteractionSchema.parse(row.data);
        const resolved =
          interaction.resolution === null
            ? apply(db, interaction, command)
            : { interaction, events: [] };
        return {
          events: resolved.events,
          reply: {
            status: 'accepted',
            commandId: command.commandId,
            result: jsonValue({ interaction: resolved.interaction }),
          },
        };
      })
      .catch((error: unknown) => {
        // Roll back every write before retaining a permanent validation rejection.
        if (!(error instanceof RuntimeError)) throw error;
        return store.transition({ ...options, wakeAt: null }, () => ({
          events: [],
          reply: rejected(command.commandId, error.detail),
        }));
      });
    if (!reply) throw new StoreError('storage_unavailable', true);
    return reply;
  } catch (error) {
    return rejected(command.commandId, {
      code: error instanceof StoreError ? error.code : 'storage_unavailable',
      message: 'The interaction could not be committed. Retry the same command.',
      retryable: error instanceof StoreError ? error.retryable : true,
    });
  }
}
