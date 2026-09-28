import { describe, expect, it } from 'vitest';

import {
  flattenSessionSections,
  SESSION_LIST_SKELETON_COUNT,
  type SessionListRow,
  skeletonSessionRows,
} from './session-list-rows';
import { type SessionSection } from './session-list-helpers';
import { type StoredSession } from '@/lib/hooks/use-agent-sessions';

function session(id: string): StoredSession {
  return { session_id: id } as unknown as StoredSession;
}

function section(title: string, ids: string[]): SessionSection {
  return { title, data: ids.map(id => session(id)) };
}

function titles(rows: readonly SessionListRow[]): string[] {
  const result: string[] = [];
  for (const row of rows) {
    if (row.kind === 'section-header') {
      result.push(row.title);
    }
  }
  return result;
}

function counts(rows: readonly SessionListRow[]): number[] {
  const result: number[] = [];
  for (const row of rows) {
    if (row.kind === 'section-header') {
      result.push(row.count);
    }
  }
  return result;
}

function sessionIds(rows: readonly SessionListRow[]): string[] {
  const result: string[] = [];
  for (const row of rows) {
    if (row.kind === 'session') {
      result.push(row.session.session_id);
    }
  }
  return result;
}

describe('flattenSessionSections', () => {
  it('preserves section order (Today then Older)', () => {
    const rows = flattenSessionSections([section('Today', ['a']), section('Older', ['b'])]);
    expect(titles(rows)).toEqual(['Today', 'Older']);
  });

  it('sets each header count to its section length, including multi-session and empty sections', () => {
    const rows = flattenSessionSections([
      section('Today', ['a', 'b', 'c']),
      section('Yesterday', ['d']),
      section('Older', []),
    ]);
    expect(counts(rows)).toEqual([3, 1, 0]);
  });

  it('keeps session source order within a section and across sections', () => {
    const rows = flattenSessionSections([
      section('Today', ['a', 'b']),
      section('Older', ['c', 'd']),
    ]);
    expect(sessionIds(rows)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('produces unique keys and a stable array across two calls on the same input', () => {
    const sections = [section('Today', ['a', 'b']), section('Older', ['c'])];
    const first = flattenSessionSections(sections);
    const second = flattenSessionSections(sections);
    expect(first).toEqual(second);
    const keys = first.map(row => row.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(['header:Today', 'a', 'b', 'header:Older', 'c']);
  });

  it('keys each session row by its session_id', () => {
    const rows = flattenSessionSections([section('Today', ['a', 'b'])]);
    const keys: string[] = [];
    for (const row of rows) {
      if (row.kind === 'session') {
        expect(row.key).toBe(row.session.session_id);
        keys.push(row.key);
      }
    }
    expect(keys).toEqual(['a', 'b']);
  });

  it('flattens empty input to an empty array', () => {
    expect(flattenSessionSections([])).toEqual([]);
  });

  it('does not mutate the input sections or their sessions', () => {
    const first = section('Today', ['a', 'b']);
    const sections = [first];
    const snapshot = { title: first.title, data: [...first.data] };
    flattenSessionSections(sections);
    expect(sections).toHaveLength(1);
    expect(sections[0]).toBe(first);
    expect(first.title).toBe(snapshot.title);
    expect(first.data).toEqual(snapshot.data);
    expect(first.data[0]).toBe(snapshot.data[0]);
  });

  it('interleaves each header immediately before its section rows', () => {
    const rows = flattenSessionSections([section('Today', ['a']), section('Older', ['b', 'c'])]);
    expect(rows.map(row => row.kind)).toEqual([
      'section-header',
      'session',
      'section-header',
      'session',
      'session',
    ]);
  });
});

describe('skeletonSessionRows', () => {
  it('defaults to the reserved cold-open row count', () => {
    expect(skeletonSessionRows()).toHaveLength(SESSION_LIST_SKELETON_COUNT);
    expect(SESSION_LIST_SKELETON_COUNT).toBe(8);
  });

  it('marks every row as a skeleton kind with a unique key', () => {
    const rows = skeletonSessionRows(8);
    for (const row of rows) {
      expect(row.kind).toBe('skeleton');
    }
    const keys = rows.map(row => row.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('keeps keys stable across calls so the swap to real rows is a plain data update', () => {
    expect(skeletonSessionRows(3)).toEqual(skeletonSessionRows(3));
    expect(skeletonSessionRows(3).map(row => row.key)).toEqual([
      'skeleton:0',
      'skeleton:1',
      'skeleton:2',
    ]);
  });
});
