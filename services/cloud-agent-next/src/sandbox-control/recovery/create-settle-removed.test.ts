import { describe, expect, it } from 'vitest';
import {
  DEADLINE_IDS,
  DEADLINE_MS,
  dueDeadlines,
  earliestDeadline,
  type DeadlineTable,
} from '../deadlines.js';

describe('create-settle', () => {
  it('is gone from the deadline table and leftover coded keys are ignored', () => {
    expect(DEADLINE_IDS).not.toContain('D1');
    expect('D1' in DEADLINE_MS).toBe(false);
    expect(DEADLINE_IDS).not.toContain('D2');

    const leftover: DeadlineTable & { D1?: number; D2?: number } = {
      D1: 10,
      D2: 20,
      heartbeatExpiry: 30,
    };
    expect(earliestDeadline(leftover)).toEqual({ id: 'heartbeatExpiry', at: 30 });
    expect(dueDeadlines(leftover, 30)).toEqual(['heartbeatExpiry']);
  });
});
