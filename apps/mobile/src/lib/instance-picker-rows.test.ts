import { describe, expect, it } from 'vitest';

import { type InstancePickerInstance } from '@/lib/picker-bridge';

import { dedupeInstanceLabels, resolveInstancePickerViewState } from './instance-picker-rows';

function instance(overrides: Partial<InstancePickerInstance>): InstancePickerInstance {
  return {
    connectionId: overrides.connectionId ?? 'conn-1',
    name: overrides.name ?? 'laptop',
    projectName: overrides.projectName ?? 'kilo',
    version: overrides.version,
  };
}

describe('dedupeInstanceLabels', () => {
  it('returns an empty list for no instances', () => {
    expect(dedupeInstanceLabels([])).toEqual([]);
  });

  it('does not stamp a suffix when every (name, projectName) pair is unique', () => {
    const result = dedupeInstanceLabels([
      instance({ connectionId: 'a', name: 'laptop', projectName: 'kilo' }),
      instance({ connectionId: 'b', name: 'desktop', projectName: 'kilo' }),
      instance({ connectionId: 'c', name: 'laptop', projectName: 'cloud' }),
    ]);
    expect(result.map(row => row.dedupSuffix)).toEqual([null, null, null]);
    expect(result.map(row => row.connectionId)).toEqual(['a', 'b', 'c']);
  });

  it('stamps both rows of a single duplicate pair with stable, distinct suffixes', () => {
    const result = dedupeInstanceLabels([
      instance({ connectionId: 'conn-aaa', name: 'laptop', projectName: 'kilo' }),
      instance({ connectionId: 'conn-bbb', name: 'laptop', projectName: 'kilo' }),
    ]);
    const suffixes = result.map(row => row.dedupSuffix);
    expect(suffixes).not.toEqual([null, null]);
    expect(new Set(suffixes).size).toBe(2);
    // Stability: running it again must produce the same suffixes.
    const again = dedupeInstanceLabels([
      instance({ connectionId: 'conn-aaa', name: 'laptop', projectName: 'kilo' }),
      instance({ connectionId: 'conn-bbb', name: 'laptop', projectName: 'kilo' }),
    ]);
    expect(again.map(row => row.dedupSuffix)).toEqual(suffixes);
  });

  it('stamps every row of a 3+ way duplicate cluster', () => {
    const result = dedupeInstanceLabels([
      instance({ connectionId: 'c-1', name: 'laptop', projectName: 'kilo' }),
      instance({ connectionId: 'c-2', name: 'laptop', projectName: 'kilo' }),
      instance({ connectionId: 'c-3', name: 'laptop', projectName: 'kilo' }),
      instance({ connectionId: 'c-4', name: 'laptop', projectName: 'kilo' }),
    ]);
    const suffixes = result.map(row => row.dedupSuffix);
    expect(suffixes.every(suffix => suffix !== null)).toBe(true);
    // All four connectionIds produce distinct 6-char hex suffixes in
    // practice; even one collision across four random strings would be
    // extremely unlikely, so asserting full uniqueness guards against a
    // regression that reuses a single hash.
    expect(new Set(suffixes).size).toBe(4);
  });

  it('mixes stamped and unstamped rows correctly when some pairs duplicate and others do not', () => {
    const result = dedupeInstanceLabels([
      instance({ connectionId: 'solo-1', name: 'desktop', projectName: 'kilo' }),
      instance({ connectionId: 'dup-a', name: 'laptop', projectName: 'kilo' }),
      instance({ connectionId: 'dup-b', name: 'laptop', projectName: 'kilo' }),
      instance({ connectionId: 'solo-2', name: 'laptop', projectName: 'cloud' }),
    ]);
    const byConn = new Map(result.map(row => [row.connectionId, row.dedupSuffix]));
    expect(byConn.get('solo-1')).toBeNull();
    expect(byConn.get('solo-2')).toBeNull();
    expect(byConn.get('dup-a')).not.toBeNull();
    expect(byConn.get('dup-b')).not.toBeNull();
  });

  it('preserves input order', () => {
    const input = [
      instance({ connectionId: 'a' }),
      instance({ connectionId: 'b' }),
      instance({ connectionId: 'c' }),
    ];
    expect(dedupeInstanceLabels(input).map(row => row.connectionId)).toEqual(['a', 'b', 'c']);
  });
});

describe('resolveInstancePickerViewState', () => {
  it('is "loading" whenever the query has never produced data, regardless of isError', () => {
    expect(
      resolveInstancePickerViewState({ isLoading: true, isError: false, instances: [] })
    ).toEqual({
      kind: 'loading',
    });
    // isLoading takes priority — a query cannot be simultaneously "never
    // produced data" and "produced an error response" in TanStack Query's
    // own state machine, but the classifier's precedence must still favor
    // loading defensively.
    expect(
      resolveInstancePickerViewState({ isLoading: true, isError: true, instances: [] })
    ).toEqual({
      kind: 'loading',
    });
  });

  it('is "error" — distinct from a successful empty response — when the query failed', () => {
    const errorState = resolveInstancePickerViewState({
      isLoading: false,
      isError: true,
      instances: [],
    });
    const emptyState = resolveInstancePickerViewState({
      isLoading: false,
      isError: false,
      instances: [],
    });
    expect(errorState).toEqual({ kind: 'error' });
    expect(errorState.kind).not.toBe(emptyState.kind);
  });

  it('is "ready" with an empty instances array for a successful zero-instance response (the Empty state)', () => {
    expect(
      resolveInstancePickerViewState({ isLoading: false, isError: false, instances: [] })
    ).toEqual({
      kind: 'ready',
      instances: [],
    });
  });

  it('is "ready" with the full instances array for a successful populated response (the Happy state)', () => {
    const instances = [instance({ connectionId: 'a' }), instance({ connectionId: 'b' })];
    expect(resolveInstancePickerViewState({ isLoading: false, isError: false, instances })).toEqual(
      {
        kind: 'ready',
        instances,
      }
    );
  });
});
