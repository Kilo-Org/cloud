import * as z from 'zod';
import type {
  ExecutionMode,
  RetryableResultCode,
  SessionMessageIntent,
} from '../execution/types.js';
import { renderExecutionTurnContent } from '../execution/types.js';
import { logger } from '../logger.js';
import { AttachmentsSchema, CallbackTargetSchema } from '../persistence/schemas.js';
import { Limits } from '../schema.js';
import { MESSAGE_ID_FORMAT_DESCRIPTION, MESSAGE_ID_PATTERN } from './message-id.js';

export const PENDING_SESSION_MESSAGE_LIMIT = 10;
export const PENDING_FLUSH_RETRY_BASE_DELAY_MS = 2_000;
// Pending delivery currently gets one redelivery after its initial failed attempt.
const WARM_FOLLOWUP_RETRY_DELAYS_MS = [PENDING_FLUSH_RETRY_BASE_DELAY_MS] as const;
const COLD_INIT_RETRY_DELAYS_MS = [PENDING_FLUSH_RETRY_BASE_DELAY_MS] as const;

const PENDING_MESSAGE_PREFIX = 'pending_message:';
const CREATED_AT_WIDTH = 16;

const AgentSelectionSchema = z.object({
  mode: z
    .string()
    .min(1)
    .max(Limits.MAX_RUNTIME_AGENT_SLUG_LENGTH)
    .regex(/^[a-z][a-z0-9-]*$/),
  model: z.string(),
  variant: z.string().optional(),
});
const PromptIntentTurnFields = {
  type: z.literal('prompt'),
  messageId: z.string().regex(MESSAGE_ID_PATTERN, MESSAGE_ID_FORMAT_DESCRIPTION),
  prompt: z.string(),
};
const IntentEnvelopeFields = {
  agent: AgentSelectionSchema,
  finalization: z
    .object({
      autoCommit: z.boolean().optional(),
      condenseOnComplete: z.boolean().optional(),
    })
    .optional(),
};
const SessionMessageIntentSchema = z.object({
  turn: z.discriminatedUnion('type', [
    z.object({ ...PromptIntentTurnFields, attachments: AttachmentsSchema.optional() }).strict(),
    z
      .object({
        type: z.literal('command'),
        messageId: z.string().regex(MESSAGE_ID_PATTERN, MESSAGE_ID_FORMAT_DESCRIPTION),
        command: z.string().min(1),
        arguments: z.string(),
      })
      .strict(),
  ]),
  ...IntentEnvelopeFields,
});
const PendingSessionMessageCallbackSnapshotSchema = z
  .object({
    required: z.boolean(),
    target: CallbackTargetSchema.optional(),
  })
  .strict();
const PendingDeliveryDispositionSchema = z.enum(['terminalization-pending']);
const PendingDeliverySchema = z.object({
  queuedAt: z.number(),
  flushAttempts: z.number().int().min(0).optional(),
  nextFlushAttemptAt: z.number().optional(),
  lastFlushError: z.string().optional(),
  disposition: PendingDeliveryDispositionSchema.optional(),
});
export const PendingSessionMessageV2Schema = z.object({
  version: z.literal(2),
  intent: SessionMessageIntentSchema,
  delivery: PendingDeliverySchema,
  callbackSnapshot: PendingSessionMessageCallbackSnapshotSchema.optional(),
});
export type PendingSessionMessageV2 = z.infer<typeof PendingSessionMessageV2Schema>;

const LegacyPendingSessionMessageExecutionOptionsSchema = z.object({
  mode: z
    .string()
    .min(1)
    .max(Limits.MAX_RUNTIME_AGENT_SLUG_LENGTH)
    .regex(/^[a-z][a-z0-9-]*$/)
    .optional(),
  model: z.string().optional(),
  variant: z.string().optional(),
  autoCommit: z.boolean().optional(),
  condenseOnComplete: z.boolean().optional(),
  githubTokenOverride: z.string().optional(),
  gitTokenOverride: z.string().optional(),
});
const LegacyPendingSessionMessageTurnSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('prompt') }).strict(),
  z
    .object({ type: z.literal('command'), command: z.string().min(1), arguments: z.string() })
    .strict(),
]);
const LegacyPendingSessionMessageSchema = z
  .object({
    messageId: z.string().regex(MESSAGE_ID_PATTERN, MESSAGE_ID_FORMAT_DESCRIPTION),
    clientRequestId: z.string().optional(),
    role: z.literal('user'),
    content: z.string(),
    turn: LegacyPendingSessionMessageTurnSchema.optional(),
    createdAt: z.number(),
    callbackUrl: z.string().optional(),
    callbackMetadata: z.unknown().optional(),
    callbackSnapshot: PendingSessionMessageCallbackSnapshotSchema.optional(),
    executionOptions: LegacyPendingSessionMessageExecutionOptionsSchema.optional(),
    flushAttempts: z.number().int().min(0).optional(),
    nextFlushAttemptAt: z.number().optional(),
    lastFlushError: z.string().optional(),
    deliveryDisposition: PendingDeliveryDispositionSchema.optional(),
  })
  .passthrough();
export type LegacyPendingSessionMessage = z.infer<typeof LegacyPendingSessionMessageSchema>;
export type PendingSessionMessageExecutionOptions = z.infer<
  typeof LegacyPendingSessionMessageExecutionOptionsSchema
>;

/** Normalized queue record consumed outside this persistence compatibility seam. */
export type PendingSessionMessage = {
  messageId: string;
  content: string;
  createdAt: number;
  intent?: SessionMessageIntent;
  callbackSnapshot?: z.infer<typeof PendingSessionMessageCallbackSnapshotSchema>;
  flushAttempts?: number;
  nextFlushAttemptAt?: number;
  lastFlushError?: string;
  deliveryDisposition?: 'terminalization-pending';
  clientRequestId?: string;
  legacyExecutionId?: string;
  version?: 2;
  /** Kept only inside this persistence seam to decode old flat records with registered defaults. */
  legacy?: LegacyPendingSessionMessage;
};

export type PendingSessionMessageCapacity = {
  available: boolean;
  count: number;
  limit: number;
  message?: string;
};
export type PendingFlushFailureResult = {
  message: PendingSessionMessage;
  attempts: number;
  exhausted: boolean;
  nextFlushAttemptAt?: number;
};
export type PendingFlushPolicy = 'cold-init' | 'warm-followup';
export type PendingSessionExecutionDefaults = {
  mode?: ExecutionMode;
  model?: string;
  variant?: string;
  autoCommit?: boolean;
  condenseOnComplete?: boolean;
};
type PendingMessageEntry = { key: string; message: PendingSessionMessage };
export type SessionQueueStorage = {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(keys: string | string[]): Promise<unknown>;
  list<T = unknown>(options: { prefix: string }): Promise<Map<string, T>>;
};

function pendingMessageKey(
  message: Pick<PendingSessionMessage, 'createdAt' | 'messageId'>
): string {
  return `${PENDING_MESSAGE_PREFIX}${String(message.createdAt).padStart(CREATED_AT_WIDTH, '0')}:${message.messageId}`;
}
function hasLegacyExecutionOptions(
  options: PendingSessionMessageExecutionOptions | undefined
): boolean {
  return Boolean(
    options &&
    (options.mode !== undefined ||
      options.model !== undefined ||
      options.variant !== undefined ||
      options.autoCommit !== undefined ||
      options.condenseOnComplete !== undefined ||
      options.githubTokenOverride !== undefined ||
      options.gitTokenOverride !== undefined)
  );
}
function decodeLegacyPendingMessage(
  message: LegacyPendingSessionMessage,
  defaults?: PendingSessionExecutionDefaults
): PendingSessionMessage {
  const mode = message.executionOptions?.mode ?? defaults?.mode ?? 'code';
  const model = message.executionOptions?.model ?? defaults?.model;
  const variant = message.executionOptions?.variant ?? defaults?.variant;
  const autoCommit = message.executionOptions?.autoCommit ?? defaults?.autoCommit;
  const condenseOnComplete =
    message.executionOptions?.condenseOnComplete ?? defaults?.condenseOnComplete;
  const intent: SessionMessageIntent | undefined = model
    ? {
        turn:
          message.turn?.type === 'command'
            ? {
                type: 'command',
                messageId: message.messageId,
                command: message.turn.command,
                arguments: message.turn.arguments,
              }
            : {
                type: 'prompt',
                messageId: message.messageId,
                prompt: message.content,
              },
        agent: { mode, model, variant },
        finalization:
          autoCommit !== undefined || condenseOnComplete !== undefined
            ? { autoCommit, condenseOnComplete }
            : undefined,
      }
    : undefined;
  return {
    messageId: message.messageId,
    content: message.content,
    createdAt: message.createdAt,
    intent,
    callbackSnapshot: message.callbackSnapshot,
    flushAttempts: message.flushAttempts,
    nextFlushAttemptAt: message.nextFlushAttemptAt,
    lastFlushError: message.lastFlushError,
    deliveryDisposition: message.deliveryDisposition,
    clientRequestId: message.clientRequestId,
    legacyExecutionId: typeof message.executionId === 'string' ? message.executionId : undefined,
    legacy: {
      ...message,
      executionOptions: hasLegacyExecutionOptions(message.executionOptions)
        ? message.executionOptions
        : undefined,
    },
  };
}
function decodePendingMessage(
  raw: unknown,
  defaults?: PendingSessionExecutionDefaults
): PendingSessionMessage | undefined {
  const current = PendingSessionMessageV2Schema.safeParse(raw);
  if (current.success) {
    const message = current.data;
    return {
      version: 2,
      messageId: message.intent.turn.messageId,
      content: renderExecutionTurnContent(message.intent.turn),
      createdAt: message.delivery.queuedAt,
      intent: message.intent,
      callbackSnapshot: message.callbackSnapshot,
      flushAttempts: message.delivery.flushAttempts,
      nextFlushAttemptAt: message.delivery.nextFlushAttemptAt,
      lastFlushError: message.delivery.lastFlushError,
      deliveryDisposition: message.delivery.disposition,
    };
  }
  const legacy = LegacyPendingSessionMessageSchema.safeParse(raw);
  return legacy.success ? decodeLegacyPendingMessage(legacy.data, defaults) : undefined;
}
async function listPendingMessageEntries(
  storage: SessionQueueStorage,
  defaults?: PendingSessionExecutionDefaults
): Promise<PendingMessageEntry[]> {
  const entries = await storage.list<unknown>({ prefix: PENDING_MESSAGE_PREFIX });
  return Array.from(entries.entries()).flatMap(([key, value]) => {
    const message = decodePendingMessage(value, defaults);
    if (!message) {
      logger.withFields({ key }).warn('Skipping invalid pending-message entry');
      return [];
    }
    return [{ key, message }];
  });
}

/** Build a legacy flat fixture/read record; production current writes use the intent constructor below. */
export function createPendingSessionMessage(params: {
  messageId: string;
  clientRequestId?: string;
  role: 'user';
  content: string;
  turn?: z.infer<typeof LegacyPendingSessionMessageTurnSchema>;
  createdAt: number;
  callbackUrl?: string;
  callbackMetadata?: unknown;
  callbackSnapshot?: z.infer<typeof PendingSessionMessageCallbackSnapshotSchema>;
  executionOptions?: PendingSessionMessageExecutionOptions;
  flushAttempts?: number;
  nextFlushAttemptAt?: number;
  lastFlushError?: string;
  deliveryDisposition?: 'terminalization-pending';
}): PendingSessionMessage {
  const legacy = LegacyPendingSessionMessageSchema.parse(params);
  return decodeLegacyPendingMessage(legacy);
}
export function createPendingSessionMessageFromIntent(
  intent: SessionMessageIntent,
  createdAt = Date.now(),
  callbackSnapshot?: z.infer<typeof PendingSessionMessageCallbackSnapshotSchema>
): PendingSessionMessage {
  return {
    version: 2,
    messageId: intent.turn.messageId,
    content: renderExecutionTurnContent(intent.turn),
    createdAt,
    intent,
    callbackSnapshot,
  };
}
export function resolvePendingSessionMessageExecutionOptions(
  message: PendingSessionMessage,
  defaults: PendingSessionExecutionDefaults
) {
  const legacy = message.legacy?.executionOptions;
  return {
    mode: message.intent?.agent.mode ?? legacy?.mode ?? defaults.mode,
    model: message.intent?.agent.model ?? legacy?.model ?? defaults.model,
    variant: message.intent?.agent.variant ?? legacy?.variant ?? defaults.variant,
    autoCommit:
      message.intent?.finalization?.autoCommit ?? legacy?.autoCommit ?? defaults.autoCommit,
    condenseOnComplete:
      message.intent?.finalization?.condenseOnComplete ??
      legacy?.condenseOnComplete ??
      defaults.condenseOnComplete,
  };
}
export function resolvePendingSessionMessageIntent(
  message: PendingSessionMessage,
  defaults: PendingSessionExecutionDefaults
): SessionMessageIntent | undefined {
  return (
    message.intent ??
    (message.legacy ? decodeLegacyPendingMessage(message.legacy, defaults).intent : undefined)
  );
}
function serializePendingSessionMessage(
  message: PendingSessionMessage | LegacyPendingSessionMessage
): PendingSessionMessageV2 | LegacyPendingSessionMessage {
  const normalized =
    'role' in message
      ? decodeLegacyPendingMessage(LegacyPendingSessionMessageSchema.parse(message))
      : message;
  return normalized.intent && !normalized.legacy
    ? PendingSessionMessageV2Schema.parse({
        version: 2,
        intent: normalized.intent,
        delivery: {
          queuedAt: normalized.createdAt,
          flushAttempts: normalized.flushAttempts,
          nextFlushAttemptAt: normalized.nextFlushAttemptAt,
          lastFlushError: normalized.lastFlushError,
          disposition: normalized.deliveryDisposition,
        },
        callbackSnapshot: normalized.callbackSnapshot,
      })
    : LegacyPendingSessionMessageSchema.parse({
        ...normalized.legacy,
        messageId: normalized.messageId,
        role: 'user',
        content: normalized.content,
        createdAt: normalized.createdAt,
        callbackSnapshot: normalized.callbackSnapshot,
        clientRequestId: normalized.clientRequestId,
        flushAttempts: normalized.flushAttempts,
        nextFlushAttemptAt: normalized.nextFlushAttemptAt,
        lastFlushError: normalized.lastFlushError,
        deliveryDisposition: normalized.deliveryDisposition,
      });
}
export async function storePendingSessionMessage(
  storage: SessionQueueStorage,
  message: PendingSessionMessage | LegacyPendingSessionMessage
): Promise<void> {
  const normalized =
    'role' in message
      ? decodeLegacyPendingMessage(LegacyPendingSessionMessageSchema.parse(message))
      : message;
  await storage.put(pendingMessageKey(normalized), serializePendingSessionMessage(normalized));
}
export async function listPendingSessionMessages(
  storage: SessionQueueStorage,
  defaults?: PendingSessionExecutionDefaults
): Promise<PendingSessionMessage[]> {
  return (await listPendingMessageEntries(storage, defaults)).map(entry => entry.message);
}
export async function countPendingSessionMessages(storage: SessionQueueStorage): Promise<number> {
  return (await listPendingMessageEntries(storage)).length;
}
export async function clearPendingSessionMessages(
  storage: SessionQueueStorage
): Promise<PendingSessionMessage[]> {
  const entries = await listPendingMessageEntries(storage);
  if (entries.length === 0) return [];
  await storage.delete(entries.map(entry => entry.key));
  return entries.map(entry => entry.message);
}
export async function checkPendingSessionMessageCapacity(
  storage: SessionQueueStorage
): Promise<PendingSessionMessageCapacity> {
  const count = await countPendingSessionMessages(storage);
  const available = count < PENDING_SESSION_MESSAGE_LIMIT;
  return {
    available,
    count,
    limit: PENDING_SESSION_MESSAGE_LIMIT,
    message: available
      ? undefined
      : `Pending message queue is full (${PENDING_SESSION_MESSAGE_LIMIT})`,
  };
}
export function shouldSkipPendingFlush(message: PendingSessionMessage, now: number): boolean {
  return message.nextFlushAttemptAt !== undefined && message.nextFlushAttemptAt > now;
}
export async function recordPendingFlushFailure(
  storage: SessionQueueStorage,
  message: PendingSessionMessage,
  error: string,
  now: number,
  options: {
    policy: PendingFlushPolicy;
    code?: RetryableResultCode | 'NOT_FOUND' | 'BAD_REQUEST' | 'INTERNAL' | 'PENDING_QUEUE_FULL';
  }
): Promise<PendingFlushFailureResult> {
  if (options.code === undefined) {
    logger
      .withFields({
        messageId: message.messageId,
        attempts: (message.flushAttempts ?? 0) + 1,
        error,
      })
      .warn('Pending flush failure with unknown error code; treating as retryable');
  }
  const attempts = (message.flushAttempts ?? 0) + 1;
  const retryDelays =
    options.policy === 'cold-init' ? COLD_INIT_RETRY_DELAYS_MS : WARM_FOLLOWUP_RETRY_DELAYS_MS;
  const retryable = isRetryableFlushCode(options.code);
  const exhausted = !retryable || attempts > retryDelays.length;
  const nextFlushAttemptAt = exhausted ? undefined : now + retryDelays[attempts - 1];
  const updated: PendingSessionMessage = {
    ...message,
    flushAttempts: attempts,
    nextFlushAttemptAt,
    lastFlushError: error,
    deliveryDisposition: exhausted ? 'terminalization-pending' : undefined,
  };
  const entries = (await listPendingMessageEntries(storage)).filter(
    candidate => candidate.message.messageId === message.messageId
  );
  const matchingEntry = entries.find(candidate => candidate.key === pendingMessageKey(message));
  const targetKey = matchingEntry?.key ?? entries[0]?.key ?? pendingMessageKey(message);
  await storage.put(targetKey, serializePendingSessionMessage(updated));
  const duplicateKeys = entries.map(candidate => candidate.key).filter(key => key !== targetKey);
  if (duplicateKeys.length > 0) {
    try {
      await storage.delete(duplicateKeys);
    } catch {
      logger
        .withFields({ messageId: message.messageId, duplicateCount: duplicateKeys.length })
        .warn('Failed to clean duplicate pending-message rows after retry update');
    }
  }
  return { message: updated, attempts, exhausted, nextFlushAttemptAt };
}
function isRetryableFlushCode(
  code:
    | RetryableResultCode
    | 'NOT_FOUND'
    | 'BAD_REQUEST'
    | 'INTERNAL'
    | 'PENDING_QUEUE_FULL'
    | undefined
): code is RetryableResultCode {
  return (
    code === undefined ||
    code === 'SANDBOX_CONNECT_FAILED' ||
    code === 'WORKSPACE_SETUP_FAILED' ||
    code === 'KILO_SERVER_FAILED' ||
    code === 'WRAPPER_START_FAILED'
  );
}
export async function deletePendingSessionMessageByMessageId(
  storage: SessionQueueStorage,
  messageId: string
): Promise<boolean> {
  const matchingEntries = (await listPendingMessageEntries(storage)).filter(
    candidate => candidate.message.messageId === messageId
  );
  if (matchingEntries.length === 0) return false;
  await storage.delete(matchingEntries.map(entry => entry.key));
  return true;
}
export async function findPendingSessionMessageByMessageId(
  storage: SessionQueueStorage,
  messageId: string,
  defaults?: PendingSessionExecutionDefaults
): Promise<PendingSessionMessage | undefined> {
  return (await listPendingMessageEntries(storage, defaults)).find(
    entry => entry.message.messageId === messageId
  )?.message;
}
export async function findPendingSessionMessageByClientRequestId(
  storage: SessionQueueStorage,
  clientRequestId: string
): Promise<PendingSessionMessage | undefined> {
  return (await listPendingMessageEntries(storage)).find(
    entry => entry.message.clientRequestId === clientRequestId
  )?.message;
}
