import { describe, expect, it } from 'vitest';
import {
  DEADLINE_MS,
  armDeadline,
  cancelDeadline,
  dueDeadlines,
  earliestDeadline,
  emptyDeadlines,
  leaseAtLeastMs,
  nextAlarmAt,
} from './deadlines.js';

describe('deadline table', () => {
  it('returns null earliest from an empty table', () => {
    const table = emptyDeadlines();
    expect(earliestDeadline(table)).toBeNull();
    expect(nextAlarmAt(table)).toBeNull();
  });

  it('picks the sooner of two armed deadlines', () => {
    let table = emptyDeadlines();
    table = armDeadline(table, 'idleStop', 200);
    table = armDeadline(table, 'startup', 50);
    expect(earliestDeadline(table)).toEqual({ id: 'startup', at: 50 });
    expect(nextAlarmAt(table)).toBe(50);
  });

  it('lets the remaining deadline win after cancel', () => {
    let table = emptyDeadlines();
    table = armDeadline(table, 'startup', 50);
    table = armDeadline(table, 'idleStop', 200);
    table = cancelDeadline(table, 'startup');
    expect(earliestDeadline(table)).toEqual({ id: 'idleStop', at: 200 });
  });

  it('returns only past-due deadlines, sorted by time', () => {
    let table = emptyDeadlines();
    table = armDeadline(table, 'heartbeatExpiry', 30);
    table = armDeadline(table, 'startup', 10);
    table = armDeadline(table, 'idleStop', 100);
    expect(dueDeadlines(table, 30)).toEqual(['startup', 'heartbeatExpiry']);
  });

  it('breaks equal timestamps stably by id', () => {
    let table = emptyDeadlines();
    table = armDeadline(table, 'stopAttempt', 40);
    table = armDeadline(table, 'startup', 40);
    expect(dueDeadlines(table, 40)).toEqual(['startup', 'stopAttempt']);
    expect(earliestDeadline(table)).toEqual({ id: 'startup', at: 40 });
  });

  it('derives leaseAtLeastMs from idle-stop plus margin', () => {
    expect(leaseAtLeastMs()).toBe(DEADLINE_MS.idleStop + DEADLINE_MS.idleStopLeaseMargin);
  });
});
