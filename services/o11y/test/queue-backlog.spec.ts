import { describe, expect, it } from 'vitest';
import {
  QUEUE_BACKLOG_PAGE_INTERVAL,
  QUEUE_BACKLOG_THRESHOLDS,
} from '../src/alerting/queue-backlog';
import {
  type QueueBacklogState,
  transitionQueueBacklogState,
} from '../src/alerting/queue-backlog-state';

function inactiveState(): QueueBacklogState {
  return {
    ticket: { active: false, consecutiveBelowCount: 0 },
    page: { active: false, consecutiveBelowCount: 0 },
  };
}

describe('transitionQueueBacklogState', () => {
  it('alerts once when the backlog first crosses the ticket threshold', () => {
    const ticket = transitionQueueBacklogState(inactiveState(), QUEUE_BACKLOG_THRESHOLDS.ticket);
    expect(ticket.alert).toEqual({
      severity: 'ticket',
      thresholdCount: QUEUE_BACKLOG_THRESHOLDS.ticket,
    });

    const repeatedTicket = transitionQueueBacklogState(
      ticket.state,
      QUEUE_BACKLOG_THRESHOLDS.ticket
    );
    expect(repeatedTicket.alert).toBeNull();
    expect(repeatedTicket.stateChanged).toBe(false);
  });

  it('pages at the initial threshold and each 100k escalation interval', () => {
    let transition = transitionQueueBacklogState(inactiveState(), QUEUE_BACKLOG_THRESHOLDS.page);
    expect(transition.alert).toEqual({
      severity: 'page',
      thresholdCount: QUEUE_BACKLOG_THRESHOLDS.page,
    });

    transition = transitionQueueBacklogState(
      transition.state,
      QUEUE_BACKLOG_THRESHOLDS.page + QUEUE_BACKLOG_PAGE_INTERVAL - 1
    );
    expect(transition.alert).toBeNull();

    transition = transitionQueueBacklogState(
      transition.state,
      QUEUE_BACKLOG_THRESHOLDS.page + QUEUE_BACKLOG_PAGE_INTERVAL
    );
    expect(transition.alert).toEqual({
      severity: 'page',
      thresholdCount: QUEUE_BACKLOG_THRESHOLDS.page + QUEUE_BACKLOG_PAGE_INTERVAL,
    });

    transition = transitionQueueBacklogState(
      transition.state,
      QUEUE_BACKLOG_THRESHOLDS.page + 2 * QUEUE_BACKLOG_PAGE_INTERVAL
    );
    expect(transition.alert).toEqual({
      severity: 'page',
      thresholdCount: QUEUE_BACKLOG_THRESHOLDS.page + 2 * QUEUE_BACKLOG_PAGE_INTERVAL,
    });
  });

  it('sends one page for a direct jump and advances beyond every crossed interval', () => {
    const backlogCount = QUEUE_BACKLOG_THRESHOLDS.page + 2 * QUEUE_BACKLOG_PAGE_INTERVAL + 10_000;
    const transition = transitionQueueBacklogState(inactiveState(), backlogCount);

    expect(transition.alert).toEqual({
      severity: 'page',
      thresholdCount: QUEUE_BACKLOG_THRESHOLDS.page + 2 * QUEUE_BACKLOG_PAGE_INTERVAL,
    });
    expect(transition.state.ticket.active).toBe(true);
    expect(transition.state.page).toEqual({
      active: true,
      consecutiveBelowCount: 0,
      nextThresholdCount: QUEUE_BACKLOG_THRESHOLDS.page + 3 * QUEUE_BACKLOG_PAGE_INTERVAL,
    });
    expect(transitionQueueBacklogState(transition.state, backlogCount).alert).toBeNull();
  });

  it('advances every crossed interval during an active page incident', () => {
    let transition = transitionQueueBacklogState(inactiveState(), QUEUE_BACKLOG_THRESHOLDS.page);
    const backlogCount = QUEUE_BACKLOG_THRESHOLDS.page + 3 * QUEUE_BACKLOG_PAGE_INTERVAL + 10_000;

    transition = transitionQueueBacklogState(transition.state, backlogCount);
    expect(transition.alert).toEqual({ severity: 'page', thresholdCount: 350_000 });
    expect(transition.state.page).toMatchObject({ nextThresholdCount: 450_000 });
    expect(transitionQueueBacklogState(transition.state, backlogCount).alert).toBeNull();
  });

  it('does not repeat an escalation interval after the backlog drops', () => {
    let transition = transitionQueueBacklogState(inactiveState(), QUEUE_BACKLOG_THRESHOLDS.page);
    transition = transitionQueueBacklogState(
      transition.state,
      QUEUE_BACKLOG_THRESHOLDS.page + QUEUE_BACKLOG_PAGE_INTERVAL
    );
    expect(transition.alert?.thresholdCount).toBe(150_000);

    transition = transitionQueueBacklogState(transition.state, QUEUE_BACKLOG_THRESHOLDS.page - 1);
    transition = transitionQueueBacklogState(
      transition.state,
      QUEUE_BACKLOG_THRESHOLDS.page + QUEUE_BACKLOG_PAGE_INTERVAL
    );

    expect(transition.alert).toBeNull();
  });

  it('re-arms the initial page only after three consecutive checks below 50k', () => {
    let transition = transitionQueueBacklogState(inactiveState(), QUEUE_BACKLOG_THRESHOLDS.page);

    for (let check = 0; check < 2; check += 1) {
      transition = transitionQueueBacklogState(transition.state, QUEUE_BACKLOG_THRESHOLDS.page - 1);
    }

    transition = transitionQueueBacklogState(transition.state, QUEUE_BACKLOG_THRESHOLDS.page);
    expect(transition.alert).toBeNull();

    for (let check = 0; check < 3; check += 1) {
      transition = transitionQueueBacklogState(transition.state, QUEUE_BACKLOG_THRESHOLDS.page - 1);
    }

    transition = transitionQueueBacklogState(transition.state, QUEUE_BACKLOG_THRESHOLDS.page);
    expect(transition.alert).toEqual({
      severity: 'page',
      thresholdCount: QUEUE_BACKLOG_THRESHOLDS.page,
    });
  });

  it('resolves ticket and page independently after three below-threshold checks', () => {
    let transition = transitionQueueBacklogState(inactiveState(), QUEUE_BACKLOG_THRESHOLDS.page);

    for (let check = 0; check < 3; check += 1) {
      transition = transitionQueueBacklogState(transition.state, QUEUE_BACKLOG_THRESHOLDS.page - 1);
    }

    expect(transition.state.page.active).toBe(false);
    expect(transition.state.ticket.active).toBe(true);

    for (let check = 0; check < 3; check += 1) {
      transition = transitionQueueBacklogState(
        transition.state,
        QUEUE_BACKLOG_THRESHOLDS.ticket - 1
      );
    }

    expect(transition.state).toEqual(inactiveState());
  });

  it('re-arms ticket only after three consecutive checks below 25k', () => {
    let transition = transitionQueueBacklogState(inactiveState(), QUEUE_BACKLOG_THRESHOLDS.ticket);

    transition = transitionQueueBacklogState(transition.state, QUEUE_BACKLOG_THRESHOLDS.ticket - 1);
    transition = transitionQueueBacklogState(transition.state, QUEUE_BACKLOG_THRESHOLDS.ticket - 1);
    transition = transitionQueueBacklogState(transition.state, QUEUE_BACKLOG_THRESHOLDS.ticket);
    expect(transition.alert).toBeNull();

    for (let check = 0; check < 3; check += 1) {
      transition = transitionQueueBacklogState(
        transition.state,
        QUEUE_BACKLOG_THRESHOLDS.ticket - 1
      );
    }

    transition = transitionQueueBacklogState(transition.state, QUEUE_BACKLOG_THRESHOLDS.ticket);
    expect(transition.alert).toEqual({
      severity: 'ticket',
      thresholdCount: QUEUE_BACKLOG_THRESHOLDS.ticket,
    });
  });
});
