import { describe, it, expect } from 'vitest';
import type { SessionDataItem } from '../types/session-sync';
import {
  getItemIdentity,
  getPartItemIdentityRange,
  getPartItemIdentityRanges,
  getPreviousPartItemIdentity,
  getPreviousPartItemIdentityRange,
  parsePartItemIdentity,
  streamMessagePartRows,
  type PartItemIdentityRange,
} from './compaction';

function item(type: string, data: Record<string, unknown> = {}): SessionDataItem {
  return { type, data } as SessionDataItem;
}

describe('getPartItemIdentityRange', () => {
  it('returns the exact binary prefix range inside the part namespace', () => {
    expect(getPartItemIdentityRange('msg_parent')).toEqual({
      start: 'part/msg_parent/',
      end: 'part/msg_parent0',
    });
  });

  it('returns the exact binary prefix range of the previous layout', () => {
    expect(getPreviousPartItemIdentityRange('msg_parent')).toEqual({
      start: 'msg_parent/',
      end: 'msg_parent0',
    });
  });

  it('lists the current layout first and keeps the two ranges disjoint', () => {
    const [current, previous] = getPartItemIdentityRanges('part');
    expect(current).toEqual({ start: 'part/part/', end: 'part/part0' });
    expect(previous).toEqual({ start: 'part/', end: 'part0' });
    expect(getPartItemIdentityRanges('msg_parent')).toEqual([
      { start: 'part/msg_parent/', end: 'part/msg_parent0' },
      { start: 'msg_parent/', end: 'msg_parent0' },
    ]);
  });
});

describe('parsePartItemIdentity', () => {
  it('splits an id stored under the current layout', () => {
    expect(parsePartItemIdentity('part/msg_42/prt_1')).toEqual({
      messageId: 'msg_42',
      partId: 'prt_1',
      layout: 'current',
    });
  });

  it('splits an id stored under the previous layout', () => {
    expect(parsePartItemIdentity('msg_42/prt_1')).toEqual({
      messageId: 'msg_42',
      partId: 'prt_1',
      layout: 'previous',
    });
  });

  it('splits a previous-layout id whose message id is "part"', () => {
    expect(parsePartItemIdentity('part/prt_1')).toEqual({
      messageId: 'part',
      partId: 'prt_1',
      layout: 'previous',
    });
  });

  it('rejects ids with no part identity', () => {
    expect(parsePartItemIdentity('part')).toBeNull();
    expect(parsePartItemIdentity('msg_42')).toBeNull();
    expect(parsePartItemIdentity('msg_42/nested/prt_1')).toBeNull();
    expect(parsePartItemIdentity('part/msg_42/prt_1/extra')).toBeNull();
    expect(parsePartItemIdentity('')).toBeNull();
  });
});

describe('getItemIdentity', () => {
  it('returns fixed id for session item', () => {
    expect(getItemIdentity(item('session'))).toEqual({
      item_id: 'session',
      item_type: 'session',
    });
  });

  it('returns message/{id} for message item', () => {
    expect(getItemIdentity(item('message', { id: 'msg-42' }))).toEqual({
      item_id: 'message/msg-42',
      item_type: 'message',
    });
  });

  it('returns part/{messageID}/{id} for part item', () => {
    expect(getItemIdentity(item('part', { id: 'p-1', messageID: 'msg-42' }))).toEqual({
      item_id: 'part/msg-42/p-1',
      item_type: 'part',
    });
  });

  it('gives a part its own identity namespace', () => {
    const partIdentity = getItemIdentity(item('part', { id: 'p-1', messageID: 'message' }));
    const messageIdentity = getItemIdentity(item('message', { id: 'p-1' }));
    expect(partIdentity.item_id).not.toBe(messageIdentity.item_id);
    expect(getPreviousPartItemIdentity('message', 'p-1')).toBe(messageIdentity.item_id);
  });

  it('returns fixed id for session_diff item', () => {
    expect(getItemIdentity(item('session_diff'))).toEqual({
      item_id: 'session_diff',
      item_type: 'session_diff',
    });
  });

  it('returns fixed id for model item', () => {
    expect(getItemIdentity(item('model'))).toEqual({
      item_id: 'model',
      item_type: 'model',
    });
  });

  it('returns fixed id for kilo_meta item', () => {
    expect(getItemIdentity(item('kilo_meta'))).toEqual({
      item_id: 'kilo_meta',
      item_type: 'kilo_meta',
    });
  });

  it('returns fixed id for session_open item', () => {
    expect(getItemIdentity(item('session_open'))).toEqual({
      item_id: 'session_open',
      item_type: 'session_open',
    });
  });

  it('returns fixed id for session_close item', () => {
    expect(getItemIdentity(item('session_close'))).toEqual({
      item_id: 'session_close',
      item_type: 'session_close',
    });
  });

  it('returns fixed id for session_pr_link item', () => {
    expect(getItemIdentity(item('session_pr_link'))).toEqual({
      item_id: 'session_pr_link',
      item_type: 'session_pr_link',
    });
  });

  it('throws for unknown item type', () => {
    expect(() => getItemIdentity(item('unknown_type'))).toThrow('Unknown item type: unknown_type');
  });
});

describe('getItemIdentity agent_notification', () => {
  it('returns agent_notification/{id} for a notification item', () => {
    expect(
      getItemIdentity(item('agent_notification', { id: 'note_1', message: 'Build done' }))
    ).toEqual({
      item_id: 'agent_notification/note_1',
      item_type: 'agent_notification',
    });
  });

  it('keeps several distinct notifications in one batch from colliding', () => {
    const items = [
      item('agent_notification', { id: 'a', message: 'one' }),
      item('agent_notification', { id: 'b', message: 'two' }),
      item('agent_notification', { id: 'c', message: 'three' }),
    ];
    const identities = items.map(getItemIdentity);
    expect(identities).toEqual([
      { item_id: 'agent_notification/a', item_type: 'agent_notification' },
      { item_id: 'agent_notification/b', item_type: 'agent_notification' },
      { item_id: 'agent_notification/c', item_type: 'agent_notification' },
    ]);
  });
});

type TestRow = { id: number; ingested_at: number | null; item_id: string };

/**
 * Stands in for the indexed per-layout query: rows inside one identity range, after the cursor,
 * in the requested order, capped at the batch size.
 */
function pageRows(
  rows: TestRow[],
  order: 'row-id' | 'ingest',
  range: PartItemIdentityRange,
  after: TestRow | undefined,
  limit: number
): TestRow[] {
  const inRange = rows.filter(row => row.item_id >= range.start && row.item_id < range.end);
  const ordered = [...inRange].sort((left, right) =>
    order === 'row-id'
      ? left.id - right.id
      : (left.ingested_at ?? -Infinity) - (right.ingested_at ?? -Infinity) || left.id - right.id
  );
  const afterIndex = after === undefined ? 0 : ordered.findIndex(row => row.id === after.id) + 1;
  return ordered.slice(afterIndex, afterIndex + limit);
}

function collectRows(
  messageId: string,
  order: 'row-id' | 'ingest',
  rows: TestRow[],
  batchSize: number
): TestRow[] {
  return [
    ...streamMessagePartRows<TestRow>({
      messageId,
      order,
      batchSize,
      fetchPage: (range, after, limit) => pageRows(rows, order, range, after, limit),
    }),
  ];
}

describe('streamMessagePartRows', () => {
  const previousRows: TestRow[] = Array.from({ length: 12 }, (_unused, index) => ({
    id: index + 1,
    ingested_at: 1000 + index,
    item_id: `msg_a/prt_${String(index).padStart(2, '0')}`,
  }));
  const currentRows: TestRow[] = Array.from({ length: 12 }, (_unused, index) => ({
    id: 100 + index,
    ingested_at: 2000 + index,
    item_id: `part/msg_a/prt_${String(index).padStart(2, '0')}`,
  }));

  it('pages both layouts independently', () => {
    const rows = collectRows('msg_a', 'row-id', [...previousRows, ...currentRows], 4);
    expect(rows.map(row => row.id)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110,
      111,
    ]);
  });

  it('orders rows from both layouts by ingest time', () => {
    const rows = collectRows('msg_a', 'ingest', [...currentRows, ...previousRows], 5);
    expect(rows.map(row => row.ingested_at)).toEqual([
      1000, 1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008, 1009, 1010, 1011, 2000, 2001, 2002,
      2003, 2004, 2005, 2006, 2007, 2008, 2009, 2010, 2011,
    ]);
  });

  it('passes an id with no part identity through to the caller', () => {
    const rows = collectRows(
      'msg_a',
      'row-id',
      [
        { id: 1, ingested_at: 1000, item_id: 'msg_a/child/prt_1' },
        { id: 2, ingested_at: 1001, item_id: 'msg_a/prt_1' },
      ],
      10
    );
    expect(rows.map(row => row.item_id)).toEqual(['msg_a/child/prt_1', 'msg_a/prt_1']);
  });

  it('skips rows of the other layout', () => {
    const rows = collectRows(
      'part',
      'row-id',
      [
        { id: 1, ingested_at: 1000, item_id: 'part/prt_legacy' },
        { id: 2, ingested_at: 2000, item_id: 'part/msg_b/prt_new' },
        { id: 3, ingested_at: 2001, item_id: 'part/msg_c/prt_other' },
      ],
      10
    );
    expect(rows.map(row => row.item_id)).toEqual(['part/prt_legacy']);
  });
});
