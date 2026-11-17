import { describe, expect, it } from 'vitest';

import {
  filterSessionsByStatusKind,
  parseStatusFilterKind,
} from '@/components/agents/live-session-status-filter';

describe('parseStatusFilterKind', () => {
  it('accepts each status kind', () => {
    for (const kind of ['needsInput', 'running', 'scheduled', 'idle'] as const) {
      expect(parseStatusFilterKind(kind)).toBe(kind);
    }
  });

  it('takes the first value of a repeated parameter', () => {
    expect(parseStatusFilterKind(['idle', 'running'])).toBe('idle');
  });

  it('rejects an absent, empty, or unknown value', () => {
    expect(parseStatusFilterKind(undefined)).toBeNull();
    expect(parseStatusFilterKind('')).toBeNull();
    expect(parseStatusFilterKind('paused')).toBeNull();
    expect(parseStatusFilterKind(['paused'])).toBeNull();
  });
});

describe('filterSessionsByStatusKind', () => {
  const sessions = [
    { id: 'a', status: 'question' },
    { id: 'b', status: 'busy' },
    { id: 'c', status: 'idle' },
    { id: 'd', status: 'scheduled' },
  ];

  it('keeps only the sessions the kind names', () => {
    expect(filterSessionsByStatusKind(sessions, 'needsInput').map(session => session.id)).toEqual([
      'a',
    ]);
    expect(filterSessionsByStatusKind(sessions, 'running').map(session => session.id)).toEqual([
      'b',
    ]);
    expect(filterSessionsByStatusKind(sessions, 'scheduled').map(session => session.id)).toEqual([
      'd',
    ]);
    expect(filterSessionsByStatusKind(sessions, 'idle').map(session => session.id)).toEqual(['c']);
  });

  it('keeps the same array when no filter applies', () => {
    expect(filterSessionsByStatusKind(sessions, null)).toBe(sessions);
  });
});
