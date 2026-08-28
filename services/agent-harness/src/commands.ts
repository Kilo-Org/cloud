import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { z } from 'zod';
import {
  CommandSchema,
  canonicalizeValidatedInput,
  fingerprintCommand,
  type Command,
} from '@kilocode/agent-harness/commands';
import {
  ClientSchema,
  ContextSchema,
  ConversationSchema,
  ErrorSchema,
  MessageSchema,
  RunSchema,
  type EventEnvelope,
} from '@kilocode/agent-harness/contracts';
import type { CommandReply } from '@kilocode/agent-harness/journal';
import { commandAdmission } from '@kilocode/agent-harness/policy';
import { conversationRow, readConversation, type StoreDatabase } from './db/records';
import type { ConversationStore } from './db/store';
import { runs } from './db/sqlite-schema';
import { StoreError } from './db/wake';

const bounded = (maximum: number) => z.int().positive().max(maximum).default(maximum);
export const RunLimitsSchema = z
  .strictObject({
    messageBytes: bounded(32 * 1024),
    pendingMessages: bounded(32),
    calls: bounded(32),
    modelSteps: bounded(20),
    modelInputTokens: bounded(32_000),
    modelOutputTokens: bounded(8192),
    toolInputBytes: bounded(64 * 1024),
    toolOutputBytes: bounded(64 * 1024),
    httpResponseBytes: bounded(1024 * 1024),
    modelAttemptMs: bounded(90_000),
    toolAttemptMs: bounded(30_000),
    activeRunMs: bounded(600_000),
    webRequests: bounded(5),
    searchResults: bounded(5),
    snippetCharacters: bounded(1200),
    pageBytes: bounded(32 * 1024),
    modelCostUsd: z.number().positive().max(1).default(1),
  })
  .readonly();
const ModelAdmissionSchema = z.strictObject({
  contextTokens: z.int().positive(),
  inputUsdPerMillion: z.number().nonnegative(),
  outputUsdPerMillion: z.number().nonnegative(),
});
export const SendResultSchema = z.strictObject({
  runId: z.uuid(),
  messageId: z.uuid(),
  context: ContextSchema,
  limits: RunLimitsSchema,
  model: ModelAdmissionSchema,
});
const AuthoritySchema = z.strictObject({
  conversation: ConversationSchema,
  client: ClientSchema,
  origin: z.enum(['user', 'agent']),
});
type AdmissionCommand = Extract<
  Command,
  { type: 'getOrCreateConversation' | 'sendMessage' | 'setPermissionMode' | 'cancelRun' }
>;
type CommandError = z.infer<typeof ErrorSchema>;
export type CommandAdapter = {
  // The web adapter resolves the existing thread from current authentication and primary authority.
  // It must reject retired accounts/contexts and revoked client/session access on every call.
  authorize: (
    command: AdmissionCommand
  ) => Promise<z.input<typeof AuthoritySchema> | { error: CommandError }>;
  // Return current eligibility/context/prices for this exact model and variant, or null when invalid.
  validateModel: (
    command: Extract<Command, { type: 'sendMessage' }>,
    conversation: z.output<typeof ConversationSchema>
  ) => Promise<unknown>;
  limits?: z.input<typeof RunLimitsSchema>;
  now?: () => number;
};
const rejected = (
  commandId: string,
  code: CommandError['code'],
  message: string,
  retryable = false
): Extract<CommandReply, { status: 'rejected' }> => ({
  status: 'rejected',
  commandId,
  error: { code, message, retryable },
});
const terminal = (status: string) => ['completed', 'cancelled', 'failed'].includes(status);
function readRun(db: StoreDatabase, id: string) {
  const row = db.select().from(runs).where(eq(runs.id, id)).get();
  return row ? RunSchema.parse(row.data) : null;
}

async function authorizeCommand(
  command: AdmissionCommand,
  adapter: CommandAdapter
): Promise<z.output<typeof AuthoritySchema> | Extract<CommandReply, { status: 'rejected' }>> {
  const authorization = await adapter.authorize(command);
  if ('error' in authorization)
    return {
      status: 'rejected',
      commandId: command.commandId,
      error: ErrorSchema.parse(authorization.error),
    };
  const authority = AuthoritySchema.parse(authorization);
  const { conversation, client, origin } = authority;
  if (
    client.id !== command.clientId ||
    client.ownerUserId !== conversation.ownerUserId ||
    client.revokedAt !== null ||
    ('conversationId' in command && command.conversationId !== conversation.id) ||
    (command.type === 'getOrCreateConversation' &&
      canonicalizeValidatedInput(command.context) !==
        canonicalizeValidatedInput(conversation.context)) ||
    commandAdmission(command, conversation.permissionRevision, origin) === 'denied'
  )
    return rejected(
      command.commandId,
      'access_revoked',
      'The command has no current user or context authority.'
    );
  return authority;
}

export async function admitCommand(
  state: DurableObjectState,
  store: ConversationStore,
  input: unknown,
  adapter: CommandAdapter
): Promise<CommandReply> {
  const envelope = z.object({ commandId: z.uuid(), protocolVersion: z.unknown() }).parse(input);
  const parsed = CommandSchema.safeParse(input);
  if (!parsed.success)
    return rejected(
      envelope.commandId,
      envelope.protocolVersion === 1 ? 'invalid_input' : 'unsupported_protocol',
      'The command or protocol is invalid.'
    );
  const command = parsed.data;
  if (
    command.type !== 'getOrCreateConversation' &&
    command.type !== 'sendMessage' &&
    command.type !== 'setPermissionMode' &&
    command.type !== 'cancelRun'
  )
    return rejected(command.commandId, 'invalid_input', 'This command requires another handler.');
  try {
    const authorization = await authorizeCommand(command, adapter);
    if ('status' in authorization) return authorization;
    const { conversation, client, origin } = authorization;
    const fingerprint = await fingerprintCommand(
      { actorUserId: conversation.ownerUserId, conversationId: conversation.id },
      command,
      text => createHash('sha256').update(text).digest('hex')
    );
    const prior = store.getCommand(command.commandId);
    if (prior)
      return prior.fingerprint === fingerprint
        ? prior.reply
        : rejected(
            command.commandId,
            'command_conflict',
            'This command has different stored input.'
          );
    store.bindExistingConversation(conversation);
    const limits = RunLimitsSchema.parse(adapter.limits ?? {});
    const model =
      command.type === 'sendMessage'
        ? ModelAdmissionSchema.safeParse(await adapter.validateModel(command, conversation))
        : null;
    if (command.type === 'sendMessage') {
      // Model validation can yield while the account, context, or client loses authority.
      const currentAuthorization = await authorizeCommand(command, adapter);
      if ('status' in currentAuthorization) return currentAuthorization;
      store.bindExistingConversation(currentAuthorization.conversation);
    }
    const now = adapter.now?.() ?? Date.now();
    const previous =
      command.type === 'cancelRun' ? readRun(drizzle(state.storage), command.runId) : null;
    const wakeAt =
      command.type === 'getOrCreateConversation' || (previous && terminal(previous.state.status))
        ? null
        : now;
    const reply = await store
      .transition({ command: { id: command.commandId, fingerprint }, wakeAt }, db => {
        const current = readConversation(db);
        const accept = (
          result: Extract<CommandReply, { status: 'accepted' }>['result'],
          events: EventEnvelope['event'][] = []
        ) => ({
          events,
          reply: {
            status: 'accepted',
            commandId: command.commandId,
            result,
          } satisfies CommandReply,
        });
        const fail = (code: CommandError['code'], message: string, retryable = false) => ({
          events: [],
          reply: rejected(command.commandId, code, message, retryable),
        });
        if (commandAdmission(command, current.permissionRevision, origin) === 'stale_revision')
          return fail(
            'stale_revision',
            'Permission settings changed. Refresh and review before retrying.',
            true
          );
        switch (command.type) {
          case 'getOrCreateConversation':
            return accept({ conversation: current }, [
              { type: 'conversation', conversation: current },
            ]);
          case 'sendMessage': {
            if (!model?.success)
              return fail(
                'invalid_input',
                'The selected model or variant has no valid authorized price bound.'
              );
            if (
              new TextEncoder().encode(command.text).byteLength > limits.messageBytes ||
              store.queuedRuns(0, limits.pendingMessages).length >= limits.pendingMessages
            )
              return fail('limit_exceeded', 'The message or queue limit is exceeded.');
            // The run ID keys its permanent command result, including the immutable admission limits.
            const run = RunSchema.parse({
              id: command.commandId,
              conversationId: current.id,
              inputMessageId: crypto.randomUUID(),
              originClientId: client.id,
              modelId: command.modelId,
              variant: command.variant,
              state: { status: 'queued' },
            });
            const message = MessageSchema.parse({
              id: run.inputMessageId,
              role: 'user',
              content: command.text,
              clientId: client.id,
              createdAt: new Date(now).toISOString(),
              provenance: 'harness',
              protocolVersion: 1,
              runId: run.id,
            });
            return accept(
              SendResultSchema.parse({
                runId: run.id,
                messageId: message.id,
                context: current.context,
                limits: {
                  ...limits,
                  modelInputTokens: Math.min(limits.modelInputTokens, model.data.contextTokens),
                },
                model: model.data,
              }),
              [
                { type: 'message', message },
                { type: 'run', run },
              ]
            );
          }
          case 'setPermissionMode': {
            const next = {
              ...current,
              permissionMode: command.permissionMode,
              permissionRevision: current.permissionRevision + 1,
            };
            const events: EventEnvelope['event'][] = [{ type: 'conversation', conversation: next }];
            const activeId = conversationRow(db).activeRunId;
            const active = activeId ? readRun(db, activeId) : null;
            if (
              next.permissionMode === 'yolo' &&
              active?.state.status === 'waiting' &&
              active.state.waiting.reason === 'approval'
            )
              events.push({ type: 'run', run: { ...active, state: { status: 'running' } } });
            return accept({ conversation: next }, events);
          }
          case 'cancelRun': {
            const run = readRun(db, command.runId);
            if (!run) return fail('invalid_input', 'The named run does not exist.');
            const next =
              terminal(run.state.status) || run.state.status === 'stopping'
                ? run
                : {
                    ...run,
                    state: {
                      status:
                        run.state.status === 'queued'
                          ? ('cancelled' as const)
                          : ('stopping' as const),
                    },
                  };
            return accept(
              { runId: next.id, state: next.state },
              next === run ? [] : [{ type: 'run', run: next }]
            );
          }
        }
      })
      .catch((error: unknown) => {
        if (!(error instanceof StoreError) || error.code !== 'limit_exceeded') throw error;
        // The event transaction rolled back. Retain its permanent rejection before acknowledgment.
        return store.transition(
          { command: { id: command.commandId, fingerprint }, wakeAt: null },
          () => ({
            events: [],
            reply: rejected(
              command.commandId,
              'limit_exceeded',
              'The command exceeds the event size limit.'
            ),
          })
        );
      });
    if (!reply) throw new StoreError('storage_unavailable', true);
    return reply;
  } catch (error) {
    return error instanceof StoreError
      ? rejected(
          command.commandId,
          error.code,
          'The command could not be committed.',
          error.retryable
        )
      : rejected(
          command.commandId,
          'storage_unavailable',
          'Command storage or authorization is unavailable. Retry the same command.',
          true
        );
  }
}
