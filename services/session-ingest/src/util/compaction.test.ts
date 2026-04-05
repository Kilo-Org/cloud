import { describe, it, expect } from 'vitest';
import type { SessionDataItem } from '../types/session-sync';
import { getItemIdentity } from './compaction';

function item(type: string, data: Record<string, unknown> = {}): SessionDataItem {
  return { type, data } as SessionDataItem;
}

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

  it('returns messageID/id for part item', () => {
    expect(getItemIdentity(item('part', { id: 'p-1', messageID: 'msg-42' }))).toEqual({
      item_id: 'msg-42/p-1',
      item_type: 'part',
    });
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

  it('throws for unknown item type', () => {
    expect(() => getItemIdentity(item('unknown_type'))).toThrow('Unknown item type: unknown_type');
  });
});
