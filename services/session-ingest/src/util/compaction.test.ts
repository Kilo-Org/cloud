import { describe, it, expect } from 'vitest';
import type { SessionDataItem } from '../types/session-sync';
import {
  getItemIdentity,
  getPartItemIdentityRange,
  getPartItemIdentityRanges,
  getPreviousPartItemIdentity,
  getPreviousPartItemIdentityRange,
  parsePartItemIdentity,
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
    });
  });

  it('splits an id stored under the previous layout', () => {
    expect(parsePartItemIdentity('msg_42/prt_1')).toEqual({ messageId: 'msg_42', partId: 'prt_1' });
  });

  it('splits a previous-layout id whose message id is "part"', () => {
    expect(parsePartItemIdentity('part/prt_1')).toEqual({ messageId: 'part', partId: 'prt_1' });
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
