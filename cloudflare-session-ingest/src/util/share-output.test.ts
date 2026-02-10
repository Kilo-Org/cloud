import { describe, it, expect } from 'vitest';
import type { SessionDataItem } from '../types/session-sync';
import { buildSharedSessionSnapshot } from './share-output';

function item(type: string, data: unknown): SessionDataItem {
  return { type, data } as SessionDataItem;
}

describe('buildSharedSessionSnapshot', () => {
  it('returns empty snapshot for no items', () => {
    const result = buildSharedSessionSnapshot([]);
    expect(result).toEqual({ info: {}, messages: [] });
  });

  it('sets info from session item', () => {
    const result = buildSharedSessionSnapshot([item('session', { title: 'My Session' })]);
    expect(result.info).toEqual({ title: 'My Session' });
    expect(result.messages).toEqual([]);
  });

  it('last session item wins for info', () => {
    const result = buildSharedSessionSnapshot([
      item('session', { title: 'First' }),
      item('session', { title: 'Second' }),
    ]);
    expect(result.info).toEqual({ title: 'Second' });
  });

  it('adds messages in order', () => {
    const result = buildSharedSessionSnapshot([
      item('message', { id: 'msg-1', role: 'user' }),
      item('message', { id: 'msg-2', role: 'assistant' }),
    ]);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].info).toEqual({ id: 'msg-1', role: 'user' });
    expect(result.messages[1].info).toEqual({ id: 'msg-2', role: 'assistant' });
    expect(result.messages[0].parts).toEqual([]);
    expect(result.messages[1].parts).toEqual([]);
  });

  it('attaches parts to existing message', () => {
    const result = buildSharedSessionSnapshot([
      item('message', { id: 'msg-1' }),
      item('part', { id: 'p-1', messageID: 'msg-1' }),
      item('part', { id: 'p-2', messageID: 'msg-1' }),
    ]);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].parts).toHaveLength(2);
    expect(result.messages[0].parts[0].id).toBe('p-1');
    expect(result.messages[0].parts[1].id).toBe('p-2');
  });

  it('buffers parts arriving before their message', () => {
    const result = buildSharedSessionSnapshot([
      item('part', { id: 'p-1', messageID: 'msg-1' }),
      item('part', { id: 'p-2', messageID: 'msg-1' }),
      item('message', { id: 'msg-1' }),
    ]);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].parts).toHaveLength(2);
    expect(result.messages[0].parts[0].id).toBe('p-1');
    expect(result.messages[0].parts[1].id).toBe('p-2');
  });

  it('handles mixed ordering of messages and parts', () => {
    const result = buildSharedSessionSnapshot([
      item('part', { id: 'p-1', messageID: 'msg-2' }),
      item('message', { id: 'msg-1' }),
      item('part', { id: 'p-2', messageID: 'msg-1' }),
      item('message', { id: 'msg-2' }),
      item('part', { id: 'p-3', messageID: 'msg-2' }),
    ]);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].parts.map(p => p.id)).toEqual(['p-2']);
    expect(result.messages[1].parts.map(p => p.id)).toEqual(['p-1', 'p-3']);
  });

  it('silently ignores kilo_meta, session_diff, model, and other types', () => {
    const result = buildSharedSessionSnapshot([
      item('kilo_meta', { platform: 'vscode' }),
      item('session_diff', [{ op: 'replace' }]),
      item('model', [{ name: 'gpt-4' }]),
      item('session_open', {}),
      item('session_close', { reason: 'completed' }),
      item('message', { id: 'msg-1' }),
    ]);
    expect(result.messages).toHaveLength(1);
    expect(result.info).toEqual({});
  });
});
