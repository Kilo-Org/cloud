import { describe, expect, it } from 'vitest';

import {
  crockfordTime,
  importedPartId,
  importedTurnId,
  isServerSessionId,
  mintServerSessionId,
  msgIdForTurn,
  ulidTimeMs,
} from './sync-ids';

describe('mintServerSessionId', () => {
  it('mints the CLI-canonical shape', () => {
    let byte = 0;
    const id = mintServerSessionId(1_700_000_000_000, () => (byte += 7));
    expect(isServerSessionId(id)).toBe(true);
    expect(id).toHaveLength(4 + 12 + 14);
  });

  it('sorts a later mint before an earlier one (descending time)', () => {
    const random = () => 3;
    const later = mintServerSessionId(1_700_000_100_000, random);
    const earlier = mintServerSessionId(1_700_000_000_000, random);
    expect(later < earlier).toBe(true);
  });
});

describe('msgIdForTurn', () => {
  it('is stable and msg_-prefixed', () => {
    expect(msgIdForTurn('trn_01JABCDEFGHJKMNPQRSTVWXYZ0')).toBe('msg_01JABCDEFGHJKMNPQRSTVWXYZ0');
    expect(msgIdForTurn('trn_01JABCDEFGHJKMNPQRSTVWXYZ0')).toBe(
      msgIdForTurn('trn_01JABCDEFGHJKMNPQRSTVWXYZ0')
    );
  });
});

describe('ulid time', () => {
  it('round-trips through the Crockford encoding', () => {
    const time = 1_700_000_000_123;
    expect(ulidTimeMs(`trn_${crockfordTime(time)}AAAAAAAAAAAAAAAA`)).toBe(time);
  });

  it('answers null for an id with no time in it', () => {
    expect(ulidTimeMs('ses_short')).toBeNull();
    expect(ulidTimeMs('trn_!!!!!!!!!!AAAAAAAA')).toBeNull();
  });
});

describe('imported ids', () => {
  it('order by time then seq, parts after their turn', () => {
    const first = importedTurnId(1000, 1);
    const second = importedTurnId(1000, 2);
    const later = importedTurnId(2000, 1);
    expect(first < second).toBe(true);
    expect(second < later).toBe(true);
    expect(importedPartId(1000, 1, 0) < importedPartId(1000, 1, 1)).toBe(true);
  });
});
