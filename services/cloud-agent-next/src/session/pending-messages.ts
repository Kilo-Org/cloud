import * as z from 'zod';
import type {
  ExecutionMode,
  RetryableResultCode,
  SessionMessageIntent,
} from '../execution/types.js';
import { renderExecutionTurnContent } from '../execution/types.js';
import { logger } from '../logger.js';
import { CallbackTargetSchema, ImagesSchema, type Images } from '../persistence/schemas.js';
import { Limits } from '../schema.js';
import { MESSAGE_ID_FORMAT_DESCRIPTION, MESSAGE_ID_PATTERN } from './message-id.js';

export const PENDING_SESSION_MESSAGE_LIMIT = 10;
export const PENDING_FLUSH_RETRY_BASE_DELAY_MS = 2_000;
const WARM_FOLLOWUP_RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 15_000, 15_000] as const;
const COLD_INIT_RETRY_DELAYS_MS = [
  2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000, 120_000, 120_000,
] as const;

const PENDING_MESSAGE_PREFIX = 'pending_message:';
const CREATED_AT_WIDTH = 16;

const PendingSessionMessageExecutionOptionsSchema = z.object({
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

const PendingSessionMessageTurnSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('prompt') }).strict(),
  z
    .object({
      type: z.literal('command'),
      command: z.string().min(1),
      arguments: z.string(),
    })
    .strict(),
]);

const PendingSessionMessageCallbackSnapshotSchema = z
  .object({
    required: z.boolean(),
    target: CallbackTargetSchema.optional(),
  })
  .strict();

export type PendingSessionMessageExecutionOptions = z.infer<
  typeof PendingSessionMessageExecutionOptionsSchema
>;

export const PendingSessionMessageSchema = z
  .object({
    messageId: z.string().regex(MESSAGE_ID_PATTERN, MESSAGE_ID_FORMAT_DESCRIPTION),
    clientRequestId: z.string().optional(),
    role: z.literal('user'),
    content: z.string(),
    turn: PendingSessionMessageTurnSchema.optional(),
    images: ImagesSchema.optional(),
    createdAt: z.number(),
    callbackUrl: z.string().optional(),
    callbackMetadata: z.unknown().optional(),
    callbackSnapshot: PendingSessionMessageCallbackSnapshotSchema.optional(),
    // executionKind is intentionally absent — kept in .passthrough() to safely
    // deserialize any messages written by an older deployment while a migration
    // window is open, but never read or acted upon.
    executionOptions: PendingSessionMessageExecutionOptionsSchema.optional(),
    flushAttempts: z.number().int().min(0).optional(),
    nextFlushAttemptAt: z.number().optional(),
    lastFlushError: z.string().optional(),
  })
  .passthrough();

export type PendingSessionMessage = z.infer<typeof PendingSessionMessageSchema>;

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

type PendingMessageEntry = {
  key: string;
  message: PendingSessionMessage;
};

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

function hasExecutionOptions(
  executionOptions: PendingSessionMessageExecutionOptions | undefined
): executionOptions is PendingSessionMessageExecutionOptions {
  return Boolean(
    executionOptions &&
    (executionOptions.mode !== undefined ||
      executionOptions.model !== undefined ||
      executionOptions.variant !== undefined ||
      executionOptions.autoCommit !== undefined ||
      executionOptions.condenseOnComplete !== undefined)
  );
}

async function listPendingMessageEntries(
  storage: SessionQueueStorage
): Promise<PendingMessageEntry[]> {
  const entries = await storage.list<unknown>({ prefix: PENDING_MESSAGE_PREFIX });
  return Array.from(entries.entries()).flatMap(([key, value]) => {
    const result = PendingSessionMessageSchema.safeParse(value);
    if (!result.success) {
      // Malformed records are invisible to queue operations but stay in storage,
      // so log the key and issue to aid diagnosis of bad writes or schema drift.
      logger
        .withFields({ key, issues: JSON.stringify(result.error.issues) })
        .warn('Skipping invalid pending-message entry');
      return [];
    }
    return [{ key, message: result.data }];
  });
}

export function createPendingSessionMessage(params: {
  messageId: string;
  clientRequestId?: string;
  role: 'user';
  content: string;
  turn?: z.infer<typeof PendingSessionMessageTurnSchema>;
  images?: Images;
  createdAt: number;
  callbackUrl?: string;
  callbackMetadata?: unknown;
  callbackSnapshot?: z.infer<typeof PendingSessionMessageCallbackSnapshotSchema>;
  executionOptions?: PendingSessionMessageExecutionOptions;
}): PendingSessionMessage {
  const message = {
    ...params,
    executionOptions: hasExecutionOptions(params.executionOptions)
      ? params.executionOptions
      : undefined,
  } satisfies PendingSessionMessage;
  return PendingSessionMessageSchema.parse(message);
}

export function createPendingSessionMessageFromIntent(
  intent: SessionMessageIntent,
  createdAt = Date.now(),
  callbackSnapshot?: z.infer<typeof PendingSessionMessageCallbackSnapshotSchema>
): PendingSessionMessage {
  return createPendingSessionMessage({
    messageId: intent.turn.messageId,
    role: 'user',
    content: renderExecutionTurnContent(intent.turn),
    turn:
      intent.turn.type === 'prompt'
        ? { type: 'prompt' }
        : {
            type: 'command',
            command: intent.turn.command,
            arguments: intent.turn.arguments,
          },
    images: intent.turn.type === 'prompt' ? intent.turn.images : undefined,
    createdAt,
    callbackSnapshot,
    executionOptions: {
      mode: intent.agent.mode,
      model: intent.agent.model,
      variant: intent.agent.variant,
      autoCommit: intent.finalization?.autoCommit,
      condenseOnComplete: intent.finalization?.condenseOnComplete,
    },
  });
}

export function resolvePendingSessionMessageExecutionOptions(
  message: PendingSessionMessage,
  defaults: PendingSessionExecutionDefaults
): {
  mode?: ExecutionMode;
  model?: string;
  variant?: string;
  autoCommit?: boolean;
  condenseOnComplete?: boolean;
} {
  return {
    mode: message.executionOptions?.mode ?? defaults.mode,
    model: message.executionOptions?.model ?? defaults.model,
    variant: message.executionOptions?.variant ?? defaults.variant,
    autoCommit: message.executionOptions?.autoCommit ?? defaults.autoCommit,
    condenseOnComplete: message.executionOptions?.condenseOnComplete ?? defaults.condenseOnComplete,
  };
}

export function resolvePendingSessionMessageIntent(
  message: PendingSessionMessage,
  defaults: PendingSessionExecutionDefaults
): SessionMessageIntent | undefined {
  const executionOptions = resolvePendingSessionMessageExecutionOptions(message, defaults);
  if (!executionOptions.model) return undefined;

  const finalization =
    executionOptions.autoCommit !== undefined || executionOptions.condenseOnComplete !== undefined
      ? {
          autoCommit: executionOptions.autoCommit,
          condenseOnComplete: executionOptions.condenseOnComplete,
        }
      : undefined;
  return {
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
            images: message.images,
          },
    agent: {
      mode: executionOptions.mode ?? 'code',
      model: executionOptions.model,
      variant: executionOptions.variant,
    },
    finalization,
  };
}

export async function storePendingSessionMessage(
  storage: SessionQueueStorage,
  message: PendingSessionMessage
): Promise<void> {
  await storage.put(pendingMessageKey(message), PendingSessionMessageSchema.parse(message));
}

export async function listPendingSessionMessages(
  storage: SessionQueueStorage
): Promise<PendingSessionMessage[]> {
  const entries = await listPendingMessageEntries(storage);
  return entries.map(entry => entry.message);
}

export async function countPendingSessionMessages(storage: SessionQueueStorage): Promise<number> {
  const entries = await listPendingMessageEntries(storage);
  return entries.length;
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
    // Thrown errors without a known code are treated as retryable by default
    // to preserve pre-existing behavior, but logged so unclassified flush
    // failures stay observable and can be reclassified later.
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
  const exhausted = !retryable || attempts >= retryDelays.length;
  const nextFlushAttemptAt = exhausted ? undefined : now + retryDelays[attempts - 1];
  const updated: PendingSessionMessage = {
    ...message,
    flushAttempts: attempts,
    nextFlushAttemptAt,
    lastFlushError: error,
  };

  // Always delete by messageId first — the original entry may be stored under a
  // non-canonical key (e.g. during migration), so a simple put-overwrite would
  // leave the old key behind and create a duplicate.
  await deletePendingSessionMessageByMessageId(storage, message.messageId);
  await storePendingSessionMessage(storage, updated);

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
  // `undefined` (caller couldn't classify the error) is treated as retryable
  // to preserve pre-existing behavior. `recordPendingFlushFailure` logs the
  // undefined case so unclassified failures remain observable.
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
  const entries = await listPendingMessageEntries(storage);
  const matchingEntries = entries.filter(candidate => candidate.message.messageId === messageId);
  if (matchingEntries.length === 0) return false;

  await storage.delete(matchingEntries.map(entry => entry.key));
  return true;
}

export async function findPendingSessionMessageByMessageId(
  storage: SessionQueueStorage,
  messageId: string
): Promise<PendingSessionMessage | undefined> {
  const entries = await listPendingMessageEntries(storage);
  return entries.find(entry => entry.message.messageId === messageId)?.message;
}

export async function findPendingSessionMessageByClientRequestId(
  storage: SessionQueueStorage,
  clientRequestId: string
): Promise<PendingSessionMessage | undefined> {
  const entries = await listPendingMessageEntries(storage);
  return entries.find(entry => entry.message.clientRequestId === clientRequestId)?.message;
}
