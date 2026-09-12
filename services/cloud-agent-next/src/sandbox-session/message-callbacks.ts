import {
  fitCallbackJobToQueueLimit,
  type CallbackJobQueueFitResult,
} from '../callbacks/queue-payload.js';
import type { CallbackJob, CallbackTarget } from '../callbacks/types.js';
import { logger } from '../logger.js';
import type { SessionMetadata } from '../persistence/session-metadata.js';
import { projectTerminalClientError } from '../session/terminal-error-projector.js';
import type { LatestAssistantMessage } from '../session/types.js';
import { safeErrorFromQueueReason } from './control-dispatch.js';
import type { SessionMessageRecord } from './session-message-queue.js';

export const CALLBACK_OUTBOX_PREFIX = 'callback_outbox:';
export const CALLBACK_ENQUEUE_MAX_ATTEMPTS = 5;
export const CALLBACK_ENQUEUE_RETRY_MS = 30_000;

type CallbackQueue = Pick<Queue<CallbackJob>, 'send'>;
type CallbackStorage = Pick<DurableObjectStorage, 'kv'>;

export type PendingCallbackJob = {
  job: CallbackJob;
  attempts: number;
  dueAt: number;
};

export type MessageCallbacksDependencies = {
  storage: CallbackStorage;
  getMetadata: () => SessionMetadata | null;
  getCallbackQueue: () => CallbackQueue | undefined;
  getAssistantMessageForUserMessage: (
    sessionId: string,
    kiloSessionId: string,
    parentMessageId: string
  ) => LatestAssistantMessage | null;
};

export type MessageCallbacks = {
  persistTerminalCallback(
    message: SessionMessageRecord,
    metadata?: SessionMetadata | null
  ): boolean;
  pendingCallbackCount(): number;
  nextCallbackDueAt(): number | undefined;
  repair(now?: number): Promise<void>;
};

const callbackTargetSchema = {
  url: (value: unknown): value is string => typeof value === 'string' && value.length > 0,
  headers: (value: unknown): value is Record<string, string> => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    return Object.entries(value).every(
      ([key, entry]) => key.length > 0 && typeof entry === 'string'
    );
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCallbackTarget(value: unknown): value is CallbackTarget {
  if (!isRecord(value) || !callbackTargetSchema.url(value.url)) return false;
  try {
    new URL(value.url);
  } catch {
    return false;
  }
  return value.headers === undefined || callbackTargetSchema.headers(value.headers);
}

function isCallbackJob(value: unknown): value is CallbackJob {
  if (!isRecord(value) || !isCallbackTarget(value.target) || !isRecord(value.payload)) {
    return false;
  }
  const payload = value.payload;
  return (
    typeof payload.sessionId === 'string' &&
    typeof payload.cloudAgentSessionId === 'string' &&
    (payload.executionId === undefined || typeof payload.executionId === 'string') &&
    (payload.messageId === undefined || typeof payload.messageId === 'string') &&
    (payload.status === 'completed' ||
      payload.status === 'failed' ||
      payload.status === 'interrupted')
  );
}

function parsePendingCallbackJob(value: unknown): PendingCallbackJob | undefined {
  if (!isRecord(value)) return undefined;
  const attempts = value.attempts;
  const dueAt = value.dueAt;
  if (
    !isCallbackJob(value.job) ||
    typeof attempts !== 'number' ||
    !Number.isInteger(attempts) ||
    typeof dueAt !== 'number' ||
    !Number.isFinite(dueAt) ||
    attempts < 0 ||
    attempts > CALLBACK_ENQUEUE_MAX_ATTEMPTS
  ) {
    return undefined;
  }
  return {
    job: value.job,
    attempts,
    dueAt,
  };
}

function callbackKey(messageId: string): string {
  return `${CALLBACK_OUTBOX_PREFIX}${messageId}`;
}

function extractAssistantText(message: LatestAssistantMessage): string | undefined {
  const pieces: string[] = [];
  for (const part of message.parts) {
    if (part.type !== 'text' || typeof part.text !== 'string' || part.text.length === 0) continue;
    pieces.push(part.text);
  }
  const text = pieces.join('').trim();
  return text || undefined;
}

function callbackStatus(
  message: SessionMessageRecord
): CallbackJob['payload']['status'] | undefined {
  if (message.state === 'completed') return 'completed';
  if (message.state === 'failed') return 'failed';
  if (message.state === 'cancelled') return 'interrupted';
  return undefined;
}

function redactCallbackTargetUrl(callbackUrl: string): string {
  try {
    const url = new URL(callbackUrl);
    return url.origin;
  } catch {
    return 'invalid-url';
  }
}

export function createMessageCallbacks(
  dependencies: MessageCallbacksDependencies
): MessageCallbacks {
  const { storage, getMetadata, getCallbackQueue, getAssistantMessageForUserMessage } =
    dependencies;
  let repairInFlight: Promise<void> | undefined;

  function buildJob(
    message: SessionMessageRecord,
    metadata: SessionMetadata,
    target: CallbackTarget
  ): CallbackJob | undefined {
    const status = callbackStatus(message);
    if (!status) return undefined;

    const sessionId = metadata.identity.sessionId;
    const kiloSessionId = metadata.auth.kiloSessionId;
    let lastAssistantMessageText: string | undefined;
    if (status === 'completed' && kiloSessionId) {
      try {
        const assistantMessage = getAssistantMessageForUserMessage(
          sessionId,
          kiloSessionId,
          message.messageId
        );
        lastAssistantMessageText = assistantMessage
          ? extractAssistantText(assistantMessage)
          : undefined;
      } catch {
        lastAssistantMessageText = undefined;
        logger
          .withFields({ sessionId, messageId: message.messageId })
          .warn('Unable to include the assistant answer in the callback snapshot');
      }
    }
    const errorMessage =
      status === 'completed'
        ? undefined
        : status === 'interrupted'
          ? 'The message was interrupted'
          : (message.failedDetail ??
            safeErrorFromQueueReason(message.failedReason ?? 'environment_failed'));

    return {
      target: structuredClone(target),
      payload: {
        sessionId,
        cloudAgentSessionId: sessionId,
        executionId: message.messageId,
        messageId: message.messageId,
        status,
        ...(errorMessage ? { errorMessage } : {}),
        ...(status === 'completed'
          ? {}
          : {
              clientError: projectTerminalClientError({ status, error: errorMessage }),
            }),
        lastSeenBranch: metadata.repository?.upstreamBranch ?? metadata.workspace?.branchName,
        kiloSessionId,
        lastAssistantMessageText,
        idempotencyKey: message.messageId,
      },
    };
  }

  function persistTerminalCallback(
    message: SessionMessageRecord,
    metadata = getMetadata()
  ): boolean {
    const target = metadata?.callback?.target;
    if (!target || callbackStatus(message) === undefined) return false;

    const key = callbackKey(message.messageId);
    if (storage.kv.get<unknown>(key) !== undefined) return false;

    let fittedJob: CallbackJobQueueFitResult;
    try {
      const job = buildJob(message, metadata, target);
      if (!job) return false;
      fittedJob = fitCallbackJobToQueueLimit(job);
      if (fittedJob.status === 'too-large') {
        logger
          .withFields({
            sessionId: metadata.identity.sessionId,
            messageId: message.messageId,
            serializedByteLength: fittedJob.serializedByteLength,
            maximumByteLength: fittedJob.maximumByteLength,
          })
          .error('Abandoned callback job that cannot fit queue size limit');
        return false;
      }
    } catch {
      logger
        .withFields({ sessionId: metadata.identity.sessionId, messageId: message.messageId })
        .error('Abandoned callback job that could not be prepared');
      return false;
    }
    if (fittedJob.status !== 'ready') return false;
    storage.kv.put<PendingCallbackJob>(key, {
      job: structuredClone(fittedJob.job),
      attempts: 0,
      dueAt: Date.now(),
    });
    return true;
  }

  function pendingEntries(): Array<[string, PendingCallbackJob | undefined]> {
    return Array.from(storage.kv.list<unknown>({ prefix: CALLBACK_OUTBOX_PREFIX })).map(
      ([key, value]) => [key, parsePendingCallbackJob(value)]
    );
  }

  function pendingCallbackCount(): number {
    return pendingEntries().length;
  }

  function nextCallbackDueAt(): number | undefined {
    const entries = pendingEntries();
    let next: number | undefined;
    for (const [, pending] of entries) {
      if (!pending || pending.attempts >= CALLBACK_ENQUEUE_MAX_ATTEMPTS) {
        next = Math.min(next ?? Date.now(), Date.now());
        continue;
      }
      next = Math.min(next ?? pending.dueAt, pending.dueAt);
    }
    return next;
  }

  function logEnqueueFailure(job: CallbackJob, attempts: number, abandoned: boolean): void {
    logger
      .withFields({
        sessionId: job.payload.sessionId,
        messageId: job.payload.messageId,
        status: job.payload.status,
        attempts,
        callbackTarget: redactCallbackTargetUrl(job.target.url),
      })
      .error(abandoned ? 'Callback enqueue abandoned' : 'Callback enqueue failed; retry scheduled');
  }

  async function runRepair(now: number): Promise<void> {
    for (const [key, parsed] of pendingEntries()) {
      if (!parsed) {
        logger
          .withFields({ keyPrefix: CALLBACK_OUTBOX_PREFIX })
          .error('Invalid callback outbox job');
        storage.kv.delete(key);
        continue;
      }
      if (parsed.attempts >= CALLBACK_ENQUEUE_MAX_ATTEMPTS) {
        logEnqueueFailure(parsed.job, parsed.attempts, true);
        storage.kv.delete(key);
        continue;
      }
      if (parsed.dueAt > now) continue;

      const attempts = parsed.attempts + 1;
      const reserved: PendingCallbackJob = {
        ...parsed,
        attempts,
        dueAt: now + CALLBACK_ENQUEUE_RETRY_MS,
      };
      storage.kv.put(key, reserved);

      const queue = getCallbackQueue();
      if (!queue) {
        if (attempts >= CALLBACK_ENQUEUE_MAX_ATTEMPTS) {
          logEnqueueFailure(parsed.job, attempts, true);
          storage.kv.delete(key);
        } else {
          logEnqueueFailure(parsed.job, attempts, false);
        }
        continue;
      }

      try {
        await queue.send(parsed.job);
        storage.kv.delete(key);
      } catch {
        if (attempts >= CALLBACK_ENQUEUE_MAX_ATTEMPTS) {
          logEnqueueFailure(parsed.job, attempts, true);
          storage.kv.delete(key);
        } else {
          logEnqueueFailure(parsed.job, attempts, false);
        }
      }
    }
  }

  function repair(now = Date.now()): Promise<void> {
    if (repairInFlight) return repairInFlight;
    const pending = runRepair(now).finally(() => {
      repairInFlight = undefined;
    });
    repairInFlight = pending;
    return pending;
  }

  return {
    persistTerminalCallback,
    pendingCallbackCount,
    nextCallbackDueAt,
    repair,
  };
}

export function parseCallbackOutboxValue(value: unknown): PendingCallbackJob | undefined {
  return parsePendingCallbackJob(value);
}

export function callbackOutboxKey(messageId: string): string {
  return callbackKey(messageId);
}
