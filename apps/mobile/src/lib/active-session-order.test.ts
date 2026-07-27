import { describe, expect, it } from 'vitest';

import { sortActiveSessionsByCreatedAt } from '@/lib/active-session-order';
import { type ActiveSession } from '@/lib/hooks/use-agent-sessions';

function session(over: Partial<ActiveSession> & Pick<ActiveSession, 'id'>): ActiveSession {
  return {
    status: 'running',
    title: 'test',
    connectionId: 'c1',
    ...over,
  };
}

function ids(rows: ActiveSession[]): string[] {
  return rows.map(r => r.id);
}

describe('sortActiveSessionsByCreatedAt', () => {
  // A6: identical createdAt → id asc; reverse input yields byte-identical output
  it('A6: ties on createdAt break by id; reversed input is identical', () => {
    const a = session({ id: 'a', createdAt: '2026-07-01T12:00:00.000Z' });
    const b = session({ id: 'b', createdAt: '2026-07-01T12:00:00.000Z' });
    const forward = sortActiveSessionsByCreatedAt([b, a]);
    const reversed = sortActiveSessionsByCreatedAt([a, b]);
    expect(ids(forward)).toEqual(['a', 'b']);
    expect(ids(reversed)).toEqual(['a', 'b']);
    expect(forward).toEqual(reversed);
  });

  // A7: missing createdAt sorts before all enriched; among themselves by id
  it('A7: undefined createdAt sorts before enriched rows, by id among themselves', () => {
    const unenrichedZ = session({ id: 'z' });
    const unenrichedA = session({ id: 'a' });
    const enriched = session({ id: 'm', createdAt: '2026-07-01T12:00:00.000Z' });
    const result = sortActiveSessionsByCreatedAt([enriched, unenrichedZ, unenrichedA]);
    expect(ids(result)).toEqual(['a', 'z', 'm']);
  });

  // A8: unparseable createdAt is missing, not epoch 0
  it('A8: unparseable createdAt is treated as missing, not epoch 0', () => {
    const unparseable = session({ id: 'u', createdAt: 'not-a-date' });
    // Epoch 0 would sort last (oldest). An old enriched row would beat epoch 0.
    const oldEnriched = session({ id: 'old', createdAt: '2020-01-01T00:00:00.000Z' });
    const recent = session({ id: 'new', createdAt: '2026-07-01T12:00:00.000Z' });
    const result = sortActiveSessionsByCreatedAt([oldEnriched, unparseable, recent]);
    // Unparseable in bucket 1 (first); then recent, then old.
    expect(ids(result)).toEqual(['u', 'new', 'old']);
  });

  // A9: input array is not mutated
  it('A9: does not mutate the input array', () => {
    const a = session({ id: 'a', createdAt: '2026-07-01T10:00:00.000Z' });
    const b = session({ id: 'b', createdAt: '2026-07-01T12:00:00.000Z' });
    const input = [a, b];
    const snapshot = [...input];
    sortActiveSessionsByCreatedAt(input);
    expect(input).toEqual(snapshot);
    expect(input[0]).toBe(a);
    expect(input[1]).toBe(b);
  });

  // A10: createdOnPlatform alone does not count as enriched for sort
  it('A10: createdOnPlatform without createdAt is unenriched bucket (not isEnriched)', () => {
    const platformOnly = session({
      id: 'p',
      createdOnPlatform: 'cli',
    });
    const enriched = session({ id: 'e', createdAt: '2026-07-01T12:00:00.000Z' });
    const result = sortActiveSessionsByCreatedAt([enriched, platformOnly]);
    expect(ids(result)).toEqual(['p', 'e']);
  });

  // A11: permanently unenriched pins above enriched; stable across reverse/repeat
  it('A11: permanently unenriched row pins above enriched; stable across reverse and repeat', () => {
    const pin = session({ id: 'pin' });
    const e1 = session({ id: 'e1', createdAt: '2026-07-01T12:00:00.000Z' });
    const e2 = session({ id: 'e2', createdAt: '2026-07-02T12:00:00.000Z' });
    const once = sortActiveSessionsByCreatedAt([e1, pin, e2]);
    const twice = sortActiveSessionsByCreatedAt(once);
    const reversed = sortActiveSessionsByCreatedAt([e2, e1, pin]);
    expect(ids(once)).toEqual(['pin', 'e2', 'e1']);
    expect(ids(twice)).toEqual(['pin', 'e2', 'e1']);
    expect(ids(reversed)).toEqual(['pin', 'e2', 'e1']);
  });

  // A12: two unenriched by id; after enrichment with createdAt order ≠ id order, one-time swap
  it('A12: two unenriched sort by id; after createdAt lands, sort by createdAt (permitted one-time swap)', () => {
    const olderId = session({ id: 'a' });
    const newerId = session({ id: 'b' });
    const before = sortActiveSessionsByCreatedAt([newerId, olderId]);
    expect(ids(before)).toEqual(['a', 'b']);

    // createdAt order contradicts id order: b is newer than a
    const after = sortActiveSessionsByCreatedAt([
      session({ id: 'a', createdAt: '2026-07-01T10:00:00.000Z' }),
      session({ id: 'b', createdAt: '2026-07-01T12:00:00.000Z' }),
    ]);
    // Documents the permitted one-time swap: a was first by id, then b leads by createdAt.
    expect(ids(after)).toEqual(['b', 'a']);
  });

  // A13: old session arriving unenriched tops provisionally; moves down once createdAt present
  it('A13: old createdAt arriving unenriched tops first, then drops to true position (permitted downward move)', () => {
    const recent = session({ id: 'recent', createdAt: '2026-07-20T12:00:00.000Z' });
    const mid = session({ id: 'mid', createdAt: '2026-07-10T12:00:00.000Z' });
    // Reactivated / late-enriched session with an old true createdAt
    const reactivatedUnenriched = session({ id: 'old' });
    const provisional = sortActiveSessionsByCreatedAt([recent, mid, reactivatedUnenriched]);
    expect(ids(provisional)).toEqual(['old', 'recent', 'mid']);

    const settled = sortActiveSessionsByCreatedAt([
      recent,
      mid,
      session({ id: 'old', createdAt: '2026-01-01T00:00:00.000Z' }),
    ]);
    // Documents the permitted one-time downward move once enrichment lands.
    expect(ids(settled)).toEqual(['recent', 'mid', 'old']);
  });
});
