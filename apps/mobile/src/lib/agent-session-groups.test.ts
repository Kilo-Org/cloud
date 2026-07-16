import { describe, expect, it } from 'vitest';

import { groupAgentSessionsByDate } from './agent-session-groups';

type FakeSession = {
  session_id: string;
  created_at: string;
  updated_at: string;
};

const NOW = new Date('2024-06-10T12:00:00.000Z');

function iso(daysAgo: number, hour = 12): string {
  const d = new Date(NOW);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
}

describe('groupAgentSessionsByDate', () => {
  it('does not mutate the input array', () => {
    const input: FakeSession[] = [
      { session_id: 'b', created_at: iso(5), updated_at: iso(0) },
      { session_id: 'a', created_at: iso(0), updated_at: iso(5) },
    ];
    const original = [...input];
    groupAgentSessionsByDate(input, 'updated_at', NOW);
    expect(input).toEqual(original);
  });

  it('sorts by updated_at descending by default (matches legacy behavior)', () => {
    const input: FakeSession[] = [
      { session_id: 'old', created_at: iso(20), updated_at: iso(20) },
      { session_id: 'fresh', created_at: iso(2), updated_at: iso(0) },
      { session_id: 'mid', created_at: iso(10), updated_at: iso(5) },
    ];
    const groups = groupAgentSessionsByDate(input, 'updated_at', NOW);
    const flat = groups.flatMap(g => g.sessions);
    expect(flat.map(s => s.session_id)).toEqual(['fresh', 'mid', 'old']);
  });

  it('sorts by created_at descending when requested', () => {
    const input: FakeSession[] = [
      { session_id: 'old', created_at: iso(20), updated_at: iso(0) },
      { session_id: 'fresh', created_at: iso(2), updated_at: iso(20) },
      { session_id: 'mid', created_at: iso(10), updated_at: iso(5) },
    ];
    const groups = groupAgentSessionsByDate(input, 'created_at', NOW);
    const flat = groups.flatMap(g => g.sessions);
    expect(flat.map(s => s.session_id)).toEqual(['fresh', 'mid', 'old']);
  });

  it('buckets sessions into Today / Yesterday / weekday / Older', () => {
    const input: FakeSession[] = [
      { session_id: 'today', created_at: iso(0, 8), updated_at: iso(0, 8) },
      { session_id: 'yesterday', created_at: iso(1, 8), updated_at: iso(1, 8) },
      { session_id: 'this-week', created_at: iso(3, 8), updated_at: iso(3, 8) },
      { session_id: 'ancient', created_at: iso(30, 8), updated_at: iso(30, 8) },
    ];
    const groups = groupAgentSessionsByDate(input, 'updated_at', NOW);
    const labels = groups.map(g => g.label);
    expect(labels).toContain('Today');
    expect(labels).toContain('Yesterday');
    expect(labels).toContain('Older');
    // The 3-days-ago bucket label is the weekday of that date in en-US.
    const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'long' }).format(
      new Date(iso(3, 8))
    );
    expect(labels).toContain(weekday);
  });

  it('places Today before Yesterday before weekday before Older', () => {
    const input: FakeSession[] = [
      { session_id: 'ancient', created_at: iso(30), updated_at: iso(30) },
      { session_id: 'this-week', created_at: iso(3), updated_at: iso(3) },
      { session_id: 'yesterday', created_at: iso(1), updated_at: iso(1) },
      { session_id: 'today', created_at: iso(0), updated_at: iso(0) },
    ];
    const groups = groupAgentSessionsByDate(input, 'updated_at', NOW);
    expect(groups.map(g => g.label)).toEqual(['Today', 'Yesterday', expect.any(String), 'Older']);
  });

  it('places weekend-stale created_at in the correct weekday bucket under created_at sort', () => {
    // updated_at is "today" but created_at is ancient — by created_at sort it
    // belongs in Older, not Today.
    const input: FakeSession[] = [
      { session_id: 'ancient-created', created_at: iso(60), updated_at: iso(0) },
    ];
    const groups = groupAgentSessionsByDate(input, 'created_at', NOW);
    expect(groups.map(g => g.label)).toEqual(['Older']);
  });

  it('keeps a weekday bucket in selected-timestamp descending order when multiple sessions land on the same day', () => {
    // 4 days ago = the only day-of-week in this test that lands in the weekday
    // bucket (not Today, not Yesterday, not Older). All three sessions share
    // that day but with different hours.
    const input: FakeSession[] = [
      { session_id: 'late', created_at: iso(4, 20), updated_at: iso(4, 20) },
      { session_id: 'early', created_at: iso(4, 8), updated_at: iso(4, 8) },
      { session_id: 'mid', created_at: iso(4, 14), updated_at: iso(4, 14) },
    ];
    const groups = groupAgentSessionsByDate(input, 'updated_at', NOW);
    const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'long' }).format(new Date(iso(4)));
    const weekdayGroup = groups.find(g => g.label === weekday);
    expect(weekdayGroup?.sessions.map(s => s.session_id)).toEqual(['late', 'mid', 'early']);
  });

  it('keeps Older bucket in selected-timestamp descending order', () => {
    const input: FakeSession[] = [
      { session_id: '60d', created_at: iso(60), updated_at: iso(60) },
      { session_id: '20d', created_at: iso(20), updated_at: iso(20) },
      { session_id: '90d', created_at: iso(90), updated_at: iso(90) },
    ];
    const groups = groupAgentSessionsByDate(input, 'updated_at', NOW);
    const older = groups.find(g => g.label === 'Older');
    expect(older?.sessions.map(s => s.session_id)).toEqual(['20d', '60d', '90d']);
  });
});
