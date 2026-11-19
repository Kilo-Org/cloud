import { decodeTime, ulid } from 'ulid';
import { z } from 'zod';
import {
  isDefaultSessionTitle,
  kilo2ConversationSourceSchema,
  publishCloudAgentSessionStatusSchema,
  sessionTitleSchema,
  type PublishCloudAgentSessionStatusParams,
} from '@kilocode/session-ingest-contracts';
import { withTimeout } from '@kilocode/worker-utils';
import { logger } from '../../logger.js';
import type { SessionMessage } from './messages.js';
import type { PendingInteractions } from '../../sandbox-session/sandbox-control-event.js';

const LIST_STATUS_KEY = 'session_list_status';
export const LIST_STATUS_RETRY_MS = 30_000;
export const LIST_STATUS_REFRESH_MS = 60_000;
const PUBLISH_TIMEOUT_MS = 5_000;

type ListStatus = PublishCloudAgentSessionStatusParams['status'];

export function deriveSessionListStatus(input: {
  messages: readonly Pick<SessionMessage, 'state'>[];
  nativeStatus: string | undefined;
  pendingInteractions: PendingInteractions | undefined;
  routeState: string;
}): ListStatus {
  const hasOpenMessage = input.messages.some(
    message => message.state === 'queued' || message.state === 'accepted'
  );
  if (
    !hasOpenMessage &&
    (input.routeState === 'failed' ||
      (input.messages.at(-1)?.state === 'failed' &&
        input.nativeStatus !== 'busy' &&
        input.nativeStatus !== 'retry'))
  )
    return 'failed';
  if (input.pendingInteractions?.permissions.length) return 'permission';
  if (input.pendingInteractions?.questions.length) return 'question';
  if (input.nativeStatus === 'retry' || input.nativeStatus === 'offline') return 'retry';
  if (input.nativeStatus === 'busy' || hasOpenMessage) return 'busy';
  if (input.routeState === 'failed' || input.messages.at(-1)?.state === 'failed') return 'failed';
  return 'idle';
}

/**
 * Events that write the transcript: the evidence session-ingest records as a
 * CLI's `last_activity_at`. Kilo v2 has no ingest client, so the Session DO
 * publishes it with the list status.
 */
export const TRANSCRIPT_EVENT_TYPES: ReadonlySet<string> = new Set([
  'message.updated',
  'message.part.updated',
  'message.part.delta',
  'conversation.message.updated',
  'conversation.event',
]);

/**
 * The name a Kilo v2 `conversation.source` gives its session; undefined for a
 * missing title or a creation placeholder. Kilo v1 never sends this event: its
 * CLI reports its own titles to session-ingest.
 */
export function nativeSessionTitle(source: unknown): string | undefined {
  const parsed = kilo2ConversationSourceSchema.safeParse(source);
  if (!parsed.success || isDefaultSessionTitle(parsed.data.session.title)) return undefined;
  return sessionTitleSchema.safeParse(parsed.data.session.title).data;
}

const storedStatusSchema = z.object({
  update: publishCloudAgentSessionStatusSchema,
  dueAt: z.number().finite().nullable(),
});

export function createSessionListStatusOutbox(input: {
  storage: Pick<DurableObjectStorage, 'kv'>;
  publish: (update: PublishCloudAgentSessionStatusParams) => Promise<void>;
}) {
  let inFlight: Promise<void> | undefined;
  const current = () => {
    const raw = input.storage.kv.get<unknown>(LIST_STATUS_KEY);
    if (raw === undefined) return undefined;
    const parsed = storedStatusSchema.safeParse(raw);
    if (parsed.success) return parsed.data;
    input.storage.kv.delete(LIST_STATUS_KEY);
    logger.warn('Discarded invalid session list status; the current session will rebuild it');
    return undefined;
  };

  /**
   * `activityAt` is the latest transcript activity the Session DO observed; it
   * rides every snapshot and never moves back. `title` is a native rename: it
   * forces a snapshot, and stays in newer ones until a publication delivers it.
   */
  function record(
    identity: Pick<
      PublishCloudAgentSessionStatusParams,
      'sessionId' | 'kiloUserId' | 'cloudAgentSessionId'
    >,
    status: ListStatus,
    now = Date.now(),
    observed: { activityAt?: number; title?: string } = {}
  ): void {
    const previous = current();
    // Refresh on observed activity, not a timer that would keep a silent or
    // disconnected runtime looking fresh indefinitely.
    if (
      observed.title === undefined &&
      previous?.update.status === status &&
      ((status !== 'busy' && status !== 'retry') ||
        now - Date.parse(previous.update.occurredAt) < LIST_STATUS_REFRESH_MS)
    )
      return;
    // The ULID source cursor survives eviction and wall-clock rollback. It uses
    // the existing ingest ordering contract, including same-millisecond changes.
    const at = Math.max(
      now,
      previous === undefined ? 0 : decodeTime(previous.update.transitionId) + 1
    );
    const activityAt = Math.max(
      observed.activityAt ?? -Infinity,
      previous?.update.lastActivityAt === undefined
        ? -Infinity
        : Date.parse(previous.update.lastActivityAt)
    );
    const title = observed.title ?? (previous?.dueAt === null ? undefined : previous?.update.title);
    const snapshot = storedStatusSchema.safeParse({
      update: {
        ...identity,
        status,
        occurredAt: new Date(at).toISOString(),
        transitionId: ulid(at),
        ...(Number.isFinite(activityAt)
          ? { lastActivityAt: new Date(activityAt).toISOString() }
          : {}),
        ...(title === undefined ? {} : { title }),
      },
      dueAt: now,
    });
    if (!snapshot.success) {
      logger
        .withFields({ sessionId: identity.cloudAgentSessionId })
        .warn('Skipped invalid session list status; the turn is unaffected');
      return;
    }
    input.storage.kv.put(LIST_STATUS_KEY, snapshot.data);
  }

  async function deliver(now: number): Promise<void> {
    const pending = current();
    if (pending === undefined || pending.dueAt === null || pending.dueAt > now) return;
    // Reserve a retry before external I/O, so eviction or an ambiguous RPC
    // outcome cannot lose the latest snapshot. Newer statuses replace it.
    input.storage.kv.put(LIST_STATUS_KEY, { ...pending, dueAt: now + LIST_STATUS_RETRY_MS });
    try {
      await withTimeout(
        input.publish(pending.update),
        PUBLISH_TIMEOUT_MS,
        'Session status publish timed out'
      );
      if (current()?.update.transitionId === pending.update.transitionId) {
        input.storage.kv.put(LIST_STATUS_KEY, { ...pending, dueAt: null });
      }
    } catch {
      logger
        .withFields({ sessionId: pending.update.cloudAgentSessionId })
        .warn('Session list status publish failed; retry scheduled');
    }
  }

  function repair(now = Date.now()): Promise<void> {
    if (inFlight !== undefined) return inFlight;
    inFlight = deliver(now).finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  }

  return { record, repair, nextDueAt: () => current()?.dueAt ?? null };
}
