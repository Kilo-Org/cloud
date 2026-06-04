import { describe, expect, it } from 'vitest';
import { QUEUE_BACKLOG_THRESHOLDS } from '../src/alerting/queue-backlog';
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
  it('alerts once at each tier while the backlog increases', () => {
    const ticket = transitionQueueBacklogState(inactiveState(), QUEUE_BACKLOG_THRESHOLDS.ticket);
    expect(ticket.severityToNotify).toBe('ticket');
    expect(ticket.state.ticket.active).toBe(true);
    expect(ticket.state.page.active).toBe(false);

    const repeatedTicket = transitionQueueBacklogState(
      ticket.state,
      QUEUE_BACKLOG_THRESHOLDS.ticket
    );
    expect(repeatedTicket.severityToNotify).toBeNull();
    expect(repeatedTicket.stateChanged).toBe(false);

    const page = transitionQueueBacklogState(ticket.state, QUEUE_BACKLOG_THRESHOLDS.page);
    expect(page.severityToNotify).toBe('page');
    expect(page.state.ticket.active).toBe(true);
    expect(page.state.page.active).toBe(true);

    const repeatedPage = transitionQueueBacklogState(page.state, QUEUE_BACKLOG_THRESHOLDS.page);
    expect(repeatedPage.severityToNotify).toBeNull();
    expect(repeatedPage.stateChanged).toBe(false);
  });

  it('sends only the page alert on a direct jump and does not alert on a downgrade', () => {
    let transition = transitionQueueBacklogState(inactiveState(), QUEUE_BACKLOG_THRESHOLDS.page);
    expect(transition.severityToNotify).toBe('page');
    expect(transition.state.ticket.active).toBe(true);
    expect(transition.state.page.active).toBe(true);

    for (let check = 0; check < 3; check += 1) {
      transition = transitionQueueBacklogState(transition.state, QUEUE_BACKLOG_THRESHOLDS.page - 1);
      expect(transition.severityToNotify).toBeNull();
    }

    expect(transition.state.page.active).toBe(false);
    expect(transition.state.ticket.active).toBe(true);
  });

  it('resolves after three consecutive below-threshold checks', () => {
    let transition = transitionQueueBacklogState(inactiveState(), QUEUE_BACKLOG_THRESHOLDS.ticket);

    for (let check = 1; check <= 3; check += 1) {
      transition = transitionQueueBacklogState(
        transition.state,
        QUEUE_BACKLOG_THRESHOLDS.ticket - 1
      );
      expect(transition.severityToNotify).toBeNull();
      expect(transition.state.ticket.active).toBe(check < 3);
    }

    transition = transitionQueueBacklogState(transition.state, QUEUE_BACKLOG_THRESHOLDS.ticket);
    expect(transition.severityToNotify).toBe('ticket');
  });

  it('resets the recovery count when the backlog rises above the threshold again', () => {
    let transition = transitionQueueBacklogState(inactiveState(), QUEUE_BACKLOG_THRESHOLDS.ticket);

    transition = transitionQueueBacklogState(transition.state, QUEUE_BACKLOG_THRESHOLDS.ticket - 1);
    transition = transitionQueueBacklogState(transition.state, QUEUE_BACKLOG_THRESHOLDS.ticket - 1);
    expect(transition.state.ticket.consecutiveBelowCount).toBe(2);

    transition = transitionQueueBacklogState(transition.state, QUEUE_BACKLOG_THRESHOLDS.ticket);
    expect(transition.severityToNotify).toBeNull();
    expect(transition.state.ticket).toEqual({ active: true, consecutiveBelowCount: 0 });
  });

  it('resolves both tiers independently after three checks below both thresholds', () => {
    let transition = transitionQueueBacklogState(inactiveState(), QUEUE_BACKLOG_THRESHOLDS.page);

    for (let check = 0; check < 3; check += 1) {
      transition = transitionQueueBacklogState(
        transition.state,
        QUEUE_BACKLOG_THRESHOLDS.ticket - 1
      );
    }

    expect(transition.state).toEqual(inactiveState());
  });
});
