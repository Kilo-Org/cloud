import { decodeTime, ulid } from 'ulid';
import { z } from 'zod';
import {
  publishCloudAgentSessionStatusSchema,
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
    return raw === undefined ? undefined : storedStatusSchema.parse(raw);
  };

  function record(
    identity: Pick<
      PublishCloudAgentSessionStatusParams,
      'sessionId' | 'kiloUserId' | 'cloudAgentSessionId'
    >,
    status: ListStatus,
    now = Date.now()
  ): void {
    const previous = current();
    if (
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
    input.storage.kv.put(LIST_STATUS_KEY, {
      update: {
        ...identity,
        status,
        occurredAt: new Date(at).toISOString(),
        transitionId: ulid(at),
      },
      dueAt: now,
    } satisfies z.infer<typeof storedStatusSchema>);
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
