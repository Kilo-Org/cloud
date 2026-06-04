/**
 * Stateful alert tracking for the queue backlog monitor.
 *
 * Each alert tier (page / ticket) has an independent state machine:
 *
 *   - Fires ONCE when the backlog first crosses the tier threshold.
 *   - Resolves (resets) only after CONSECUTIVE_BELOW_TO_RESOLVE consecutive
 *     calls where the backlog is below the tier threshold.
 *   - While the page tier is active, the ticket tier state is frozen — the
 *     page alert already covers the elevated backlog.
 *
 * State is persisted in the O11Y_ALERT_STATE KV namespace so it survives
 * across cron invocations (runs every minute).
 */

import type { AlertSeverity } from './slo-config';
import { QUEUE_BACKLOG_THRESHOLDS } from './queue-backlog';

// Number of consecutive below-threshold observations required before an
// active alert is considered resolved and can fire again.
export const CONSECUTIVE_BELOW_TO_RESOLVE = 3;

type TierState = {
  active: boolean;
  consecutiveBelowCount: number;
};

function stateKey(severity: AlertSeverity): string {
  return `o11y:qb:state:${severity}`;
}

async function readTierState(kv: KVNamespace, severity: AlertSeverity): Promise<TierState> {
  const raw = await kv.get(stateKey(severity));
  if (!raw) return { active: false, consecutiveBelowCount: 0 };
  try {
    // KV stores trusted internal JSON we wrote ourselves.
    return JSON.parse(raw) as TierState;
  } catch {
    return { active: false, consecutiveBelowCount: 0 };
  }
}

function writeTierState(kv: KVNamespace, severity: AlertSeverity, state: TierState): Promise<void> {
  return kv.put(stateKey(severity), JSON.stringify(state));
}

/**
 * Pure state-transition function for a single alert tier.
 * Returns whether the alert should fire and the new state to persist.
 */
function evaluateTier(
  state: TierState,
  isAboveThreshold: boolean,
): { shouldFire: boolean; newState: TierState } {
  if (isAboveThreshold) {
    if (state.active) {
      // Already alerted — suppress. Reset any accumulated below-count so a
      // brief dip that doesn't sustain won't erode the resolve counter.
      return { shouldFire: false, newState: { active: true, consecutiveBelowCount: 0 } };
    }
    // First crossing — fire.
    return { shouldFire: true, newState: { active: true, consecutiveBelowCount: 0 } };
  }

  // Below threshold.
  if (!state.active) {
    return { shouldFire: false, newState: { active: false, consecutiveBelowCount: 0 } };
  }

  const newCount = state.consecutiveBelowCount + 1;
  if (newCount >= CONSECUTIVE_BELOW_TO_RESOLVE) {
    // Sustained recovery — clear the alert so it can fire again next time.
    return { shouldFire: false, newState: { active: false, consecutiveBelowCount: 0 } };
  }
  return { shouldFire: false, newState: { active: true, consecutiveBelowCount: newCount } };
}

/**
 * Evaluates both alert tiers against the current backlog count,
 * persists updated state, and returns the severity that should fire (or null).
 *
 * Resolution rules:
 *   - Page tier (≥ 250,000 messages) is evaluated first.
 *   - Ticket tier (≥ 100,000 messages) is only updated when page is not
 *     active — the page alert already signals the elevated backlog.
 *   - When page is active, ticket state is frozen until page resolves.
 */
export async function evaluateAndUpdateQueueBacklogState(
  kv: KVNamespace,
  backlogCount: number,
): Promise<AlertSeverity | null> {
  const [pageState, ticketState] = await Promise.all([
    readTierState(kv, 'page'),
    readTierState(kv, 'ticket'),
  ]);

  const abovePage = backlogCount >= QUEUE_BACKLOG_THRESHOLDS.page;
  const aboveTicket = backlogCount >= QUEUE_BACKLOG_THRESHOLDS.ticket;

  const { shouldFire: pageFire, newState: newPageState } = evaluateTier(pageState, abovePage);
  const pageNowActive = newPageState.active;

  let ticketFire = false;
  let newTicketState = ticketState; // frozen by default when page is active

  if (!pageNowActive) {
    const result = evaluateTier(ticketState, aboveTicket);
    ticketFire = result.shouldFire;
    newTicketState = result.newState;
  }

  const writes: Promise<void>[] = [writeTierState(kv, 'page', newPageState)];
  if (!pageNowActive) {
    writes.push(writeTierState(kv, 'ticket', newTicketState));
  }
  await Promise.all(writes);

  if (pageFire) return 'page';
  if (ticketFire) return 'ticket';
  return null;
}
