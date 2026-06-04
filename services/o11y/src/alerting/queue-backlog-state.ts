import { z } from 'zod';
import type { AlertSeverity } from './slo-config';
import { QUEUE_BACKLOG_PAGE_INTERVAL, QUEUE_BACKLOG_THRESHOLDS } from './queue-backlog';

const CONSECUTIVE_BELOW_TO_RESOLVE = 3;

const InactiveTierStateSchema = z.object({
  active: z.literal(false),
  consecutiveBelowCount: z.literal(0),
});

const ActiveTierStateSchema = z.object({
  active: z.literal(true),
  consecutiveBelowCount: z
    .number()
    .int()
    .min(0)
    .max(CONSECUTIVE_BELOW_TO_RESOLVE - 1),
});

const TierStateSchema = z.discriminatedUnion('active', [
  InactiveTierStateSchema,
  ActiveTierStateSchema,
]);

const PageStateSchema = z.discriminatedUnion('active', [
  InactiveTierStateSchema,
  ActiveTierStateSchema.extend({
    nextThresholdCount: z
      .number()
      .int()
      .min(QUEUE_BACKLOG_THRESHOLDS.page + QUEUE_BACKLOG_PAGE_INTERVAL),
  }),
]);

const QueueBacklogStateSchema = z
  .object({
    ticket: TierStateSchema,
    page: PageStateSchema,
  })
  .refine(state => !state.page.active || state.ticket.active);

type TierState = z.infer<typeof TierStateSchema>;
type PageState = z.infer<typeof PageStateSchema>;
export type QueueBacklogState = z.infer<typeof QueueBacklogStateSchema>;

type QueueBacklogTransition = {
  state: QueueBacklogState;
  alert: { severity: AlertSeverity; thresholdCount: number } | null;
  stateChanged: boolean;
};

function inactiveTierState(): TierState {
  return { active: false, consecutiveBelowCount: 0 };
}

function inactivePageState(): PageState {
  return { active: false, consecutiveBelowCount: 0 };
}

function inactiveQueueBacklogState(): QueueBacklogState {
  return {
    ticket: inactiveTierState(),
    page: inactivePageState(),
  };
}

function transitionTicket(
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

function pageThresholdAtOrBelow(backlogCount: number): number {
  const intervalsAbovePage = Math.floor(
    (backlogCount - QUEUE_BACKLOG_THRESHOLDS.page) / QUEUE_BACKLOG_PAGE_INTERVAL
  );
  return QUEUE_BACKLOG_THRESHOLDS.page + intervalsAbovePage * QUEUE_BACKLOG_PAGE_INTERVAL;
}

function activePageState(backlogCount: number): PageState {
  return {
    active: true,
    consecutiveBelowCount: 0,
    nextThresholdCount: pageThresholdAtOrBelow(backlogCount) + QUEUE_BACKLOG_PAGE_INTERVAL,
  };
}

function transitionPage(
  state: PageState,
  backlogCount: number
): { state: PageState; thresholdCount: number | null } {
  if (backlogCount >= QUEUE_BACKLOG_THRESHOLDS.page) {
    if (!state.active || backlogCount >= state.nextThresholdCount) {
      return {
        state: activePageState(backlogCount),
        thresholdCount: pageThresholdAtOrBelow(backlogCount),
      };
    }

    if (state.consecutiveBelowCount > 0) {
      return {
        state: { ...state, consecutiveBelowCount: 0 },
        thresholdCount: null,
      };
    }

    return { state, thresholdCount: null };
  }

  if (!state.active) return { state, thresholdCount: null };

  const consecutiveBelowCount = state.consecutiveBelowCount + 1;
  if (consecutiveBelowCount >= CONSECUTIVE_BELOW_TO_RESOLVE) {
    return { state: inactivePageState(), thresholdCount: null };
  }

  return {
    state: { ...state, consecutiveBelowCount },
    thresholdCount: null,
  };
}

export function transitionQueueBacklogState(
  state: QueueBacklogState,
  backlogCount: number
): QueueBacklogTransition {
  const ticket = transitionTicket(state.ticket, backlogCount >= QUEUE_BACKLOG_THRESHOLDS.ticket);
  const page = transitionPage(state.page, backlogCount);
  const stateChanged = ticket.state !== state.ticket || page.state !== state.page;
  let alert: QueueBacklogTransition['alert'] = null;

  if (page.thresholdCount !== null) {
    alert = { severity: 'page', thresholdCount: page.thresholdCount };
  } else if (ticket.crossedThreshold) {
    alert = { severity: 'ticket', thresholdCount: QUEUE_BACKLOG_THRESHOLDS.ticket };
  }

  return {
    state: stateChanged ? { ticket: ticket.state, page: page.state } : state,
    alert,
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
