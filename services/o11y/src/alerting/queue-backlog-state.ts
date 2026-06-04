import { z } from 'zod';
import type { AlertSeverity } from './slo-config';
import { QUEUE_BACKLOG_THRESHOLDS } from './queue-backlog';

const CONSECUTIVE_BELOW_TO_RESOLVE = 3;

const TierStateSchema = z.discriminatedUnion('active', [
  z.object({ active: z.literal(false), consecutiveBelowCount: z.literal(0) }),
  z.object({
    active: z.literal(true),
    consecutiveBelowCount: z
      .number()
      .int()
      .min(0)
      .max(CONSECUTIVE_BELOW_TO_RESOLVE - 1),
  }),
]);

const QueueBacklogStateSchema = z
  .object({
    ticket: TierStateSchema,
    page: TierStateSchema,
  })
  .refine(state => !state.page.active || state.ticket.active);

type TierState = z.infer<typeof TierStateSchema>;
export type QueueBacklogState = z.infer<typeof QueueBacklogStateSchema>;

type QueueBacklogTransition = {
  state: QueueBacklogState;
  severityToNotify: AlertSeverity | null;
  stateChanged: boolean;
};

function inactiveTierState(): TierState {
  return { active: false, consecutiveBelowCount: 0 };
}

function inactiveQueueBacklogState(): QueueBacklogState {
  return {
    ticket: inactiveTierState(),
    page: inactiveTierState(),
  };
}

function transitionTier(
  state: TierState,
  aboveThreshold: boolean
): { state: TierState; crossedThreshold: boolean } {
  if (aboveThreshold) {
    if (!state.active) {
      return {
        state: { active: true, consecutiveBelowCount: 0 },
        crossedThreshold: true,
      };
    }

    if (state.consecutiveBelowCount > 0) {
      return {
        state: { active: true, consecutiveBelowCount: 0 },
        crossedThreshold: false,
      };
    }

    return { state, crossedThreshold: false };
  }

  if (!state.active) return { state, crossedThreshold: false };

  const consecutiveBelowCount = state.consecutiveBelowCount + 1;
  if (consecutiveBelowCount >= CONSECUTIVE_BELOW_TO_RESOLVE) {
    return { state: inactiveTierState(), crossedThreshold: false };
  }

  return {
    state: { active: true, consecutiveBelowCount },
    crossedThreshold: false,
  };
}

export function transitionQueueBacklogState(
  state: QueueBacklogState,
  backlogCount: number
): QueueBacklogTransition {
  const ticket = transitionTier(state.ticket, backlogCount >= QUEUE_BACKLOG_THRESHOLDS.ticket);
  const page = transitionTier(state.page, backlogCount >= QUEUE_BACKLOG_THRESHOLDS.page);
  const stateChanged = ticket.state !== state.ticket || page.state !== state.page;

  return {
    state: stateChanged ? { ticket: ticket.state, page: page.state } : state,
    // A page covers a direct jump across both thresholds; latching ticket avoids a downgrade alert.
    severityToNotify: page.crossedThreshold ? 'page' : ticket.crossedThreshold ? 'ticket' : null,
    stateChanged,
  };
}

function stateKey(queueId: string): string {
  return `o11y:queue_backlog:${queueId}`;
}

export async function readQueueBacklogState(
  kv: KVNamespace,
  queueId: string
): Promise<QueueBacklogState> {
  const raw = await kv.get(stateKey(queueId));
  if (raw === null) return inactiveQueueBacklogState();

  try {
    const parsed = QueueBacklogStateSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : inactiveQueueBacklogState();
  } catch {
    return inactiveQueueBacklogState();
  }
}

export async function writeQueueBacklogState(
  kv: KVNamespace,
  queueId: string,
  state: QueueBacklogState
): Promise<void> {
  await kv.put(stateKey(queueId), JSON.stringify(state));
}
