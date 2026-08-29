import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { BridgeReadinessSchema } from '@kilocode/agent-harness/bridge';
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
  ExecutionGrantSchema,
  ToolCallSchema,
  ToolOutcomeSchema,
  type EventEnvelope,
  type ExecutionGrant,
  type ToolCall,
} from '@kilocode/agent-harness/contracts';
import type { CommandReply } from '@kilocode/agent-harness/journal';
import { readConversation, type StoreDatabase } from './db/records';
import type { ConversationStore } from './db/store';
import * as s from './db/sqlite-schema';
import { StoreError } from './db/wake';
import { RuntimeError, fail } from './limits';
import { validateStoredCall } from './model-step';

export type ClientToolCommand = Extract<
  Command,
  { type: 'claimClientTool' | 'completeClientTool' }
>;
const AuthoritySchema = z.strictObject({
  conversation: ConversationSchema,
  client: ClientSchema,
  readiness: BridgeReadinessSchema,
  // Require the original durable journal. A replacement journal cannot restore this registration.
  storageReady: z.boolean(),
});
export type ClientToolAuthority = z.infer<typeof AuthoritySchema>;
// Resolve identity and current registration from authentication. Readiness is only a gate hint;
// it cannot supply account authority, replace the target, or attest a durable execution receipt.
export type ClientToolAuthorizer = (
  command: ClientToolCommand
) => Promise<ClientToolAuthority | { error: z.infer<typeof ErrorSchema> }>;
export const supportsClientCall = (authority: ClientToolAuthority, call: ToolCall) =>
  authority.client.supportedTools.some(
    tool => tool.name === call.name && tool.version === call.definitionVersion
  );
export const rejectClientCommand = (
  commandId: string,
  error: z.infer<typeof ErrorSchema>
): CommandReply => ({ status: 'rejected', commandId, error });

export function clientAction(
  call: ToolCall,
  reason: 'offline' | 'background' | 'locked' | 'gesture' | 'unavailable' | 'reconciliation' | null,
  grant: ExecutionGrant | null = null
): EventEnvelope['event'] {
  return {
    type: 'client_action',
    toolCallId: call.id,
    action: reason === null ? null : { toolCall: call, grant, reason },
  };
}

const IntentSchema = z.strictObject({
  toolCall: ToolCallSchema,
  inputDigest: z.string().min(1),
  policy: z.json(),
  grant: ExecutionGrantSchema,
});
export function readClientGrant(db: StoreDatabase, call: ToolCall) {
  const grants = db.select().from(s.grants).where(eq(s.grants.toolCallId, call.id)).limit(2).all();
  const attempts = db
    .select()
    .from(s.attempts)
    .where(eq(s.attempts.toolCallId, call.id))
    .limit(2)
    .all();
  if (!grants.length && !attempts.length) return null;
  if (grants.length !== 1 || attempts.length !== 1)
    fail('invalid_output', 'The client call has no single dispatch fence.');
  const grant = ExecutionGrantSchema.parse(grants[0].data),
    attempt = attempts[0];
  const intent = IntentSchema.parse(attempt.intent),
    conversation = readConversation(db);
  validateStoredCall(call, intent.toolCall, [], null);
  const digest = createHash('sha256')
    .update(canonicalizeValidatedInput(call.arguments))
    .digest('hex');
  if (
    call.executionTarget.kind !== 'client' ||
    grant.clientId !== call.executionTarget.clientId ||
    grant.toolCallId !== call.id ||
    grant.conversationId !== conversation.id ||
    grant.ownerUserId !== conversation.ownerUserId ||
    grant.definitionVersion !== call.definitionVersion ||
    grant.inputDigest !== digest ||
    intent.inputDigest !== digest ||
    grants[0].id !== grant.id ||
    grants[0].generation !== grant.generation ||
    attempt.generation !== grant.generation ||
    canonicalizeValidatedInput(grant.context) !== canonicalizeValidatedInput(call.context) ||
    canonicalizeValidatedInput(intent.grant) !== canonicalizeValidatedInput(grant)
  )
    fail('invalid_output', 'The persisted client grant does not match its immutable intent.');
  const outcome = attempt.outcome === null ? null : ToolOutcomeSchema.parse(attempt.outcome);
  if (
    (call.result !== null &&
      canonicalizeValidatedInput(call.result) !== canonicalizeValidatedInput(outcome)) ||
    (call.result === null && outcome !== null && outcome.status !== 'outcome_unknown')
  )
    fail('invalid_output', 'The stored completion does not match its dispatch attempt.');
  return { grant, attemptId: attempt.id, outcome };
}

type Changes = ReturnType<Parameters<ConversationStore['transition']>[1]>;
// Only the scheduler supplies transitions. This boundary validates commands and authenticates retries.
export async function clientToolCommand(
  store: ConversationStore,
  input: unknown,
  authorize: ClientToolAuthorizer,
  prepare: (
    command: ClientToolCommand,
    authority: ClientToolAuthority,
    replay: boolean
  ) => Promise<{ call: ToolCall; apply: (authority: ClientToolAuthority) => Changes }>,
  now: () => number
): Promise<CommandReply> {
  const envelope = z.object({ commandId: z.uuid(), protocolVersion: z.unknown() }).parse(input);
  const parsed = CommandSchema.safeParse(input);
  if (
    !parsed.success ||
    (parsed.data.type !== 'claimClientTool' && parsed.data.type !== 'completeClientTool')
  )
    return rejectClientCommand(envelope.commandId, {
      code: envelope.protocolVersion === 1 ? 'invalid_input' : 'unsupported_protocol',
      message: 'The client tool command is invalid.',
      retryable: false,
    });
  const command = parsed.data;
  let journal: { id: string; fingerprint: string } | undefined;
  async function currentAuthority() {
    const result = await authorize(command);
    if ('error' in result) throw new RuntimeError(ErrorSchema.parse(result.error));
    const authority = AuthoritySchema.parse(result),
      current = store.snapshot()?.conversation;
    if (
      !current ||
      authority.client.id !== command.clientId ||
      authority.client.ownerUserId !== current.ownerUserId ||
      authority.conversation.id !== current.id ||
      command.conversationId !== current.id ||
      authority.conversation.ownerUserId !== current.ownerUserId ||
      canonicalizeValidatedInput(authority.conversation.context) !==
        canonicalizeValidatedInput(current.context)
    )
      fail('access_revoked', 'The command has no current client or context authority.');
    return authority;
  }
  try {
    const authority = await currentAuthority();
    const fingerprint = await fingerprintCommand(
      { actorUserId: authority.client.ownerUserId, conversationId: command.conversationId },
      command,
      text => createHash('sha256').update(text).digest('hex')
    );
    // Validate saved calls before replay, but do not prepare another dispatch for a journaled command.
    const replay = store.getCommand(command.commandId) !== null;
    const prepared = await prepare(command, authority, replay);
    const current = await currentAuthority();
    if (
      prepared.call.executionTarget.kind !== 'client' ||
      prepared.call.executionTarget.clientId !== current.client.id
    )
      fail('access_revoked', 'Only the designated client can claim or complete this call.');
    // Revocation and storage loss override replay: never disclose a saved grant to an invalid client.
    if (
      current.client.revokedAt === null &&
      current.storageReady &&
      supportsClientCall(current, prepared.call)
    )
      journal = { id: command.commandId, fingerprint };
    const reply = await store.transition({ command: journal, wakeAt: now() + 1 }, () =>
      prepared.apply(current)
    );
    if (!reply) throw new StoreError('storage_unavailable', true);
    return reply;
  } catch (error) {
    const detail =
      error instanceof RuntimeError
        ? error.detail
        : {
            code:
              error instanceof StoreError
                ? error.code
                : error instanceof z.ZodError
                  ? ('invalid_output' as const)
                  : ('storage_unavailable' as const),
            message: 'The client command could not be committed.',
            retryable:
              error instanceof StoreError ? error.retryable : !(error instanceof z.ZodError),
          };
    const reply = rejectClientCommand(command.commandId, detail);
    if (journal && error instanceof RuntimeError)
      return store
        .transition({ command: journal, wakeAt: null }, () => ({ events: [], reply }))
        .then(
          stored => stored ?? reply,
          () =>
            rejectClientCommand(command.commandId, {
              code: 'storage_unavailable',
              message: 'The client rejection could not be committed. Retry the same command.',
              retryable: true,
            })
        );
    return reply;
  }
}
