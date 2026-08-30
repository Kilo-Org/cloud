import { describe, expect, it } from 'vitest';

import { appendSpectatorRows, type SpectatorRow } from './review-spectator-rows';

const row = (message: string, key?: string): SpectatorRow => ({
  timestamp: 't',
  message,
  eventType: 'info',
  ...(key === undefined ? {} : { key }),
});

describe('appendSpectatorRows', () => {
  it('replaces a keyed row and appends unkeyed rows', () => {
    const rows = appendSpectatorRows(
      [row('a', 'k1'), row('b')],
      [row('a2', 'k1'), row('c'), row('d', 'k2'), row('d2', 'k2')]
    );
    expect(rows.map(r => r.message)).toEqual(['a2', 'b', 'c', 'd2']);
  });

  it('keeps every unkeyed row in a batch', () => {
    const rows = appendSpectatorRows([], [row('connected'), row('snapshot'), row('queued')]);
    expect(rows).toHaveLength(3);
  });
});
