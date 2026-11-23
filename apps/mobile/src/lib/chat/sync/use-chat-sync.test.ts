import { describe, expect, it, vi } from 'vitest';

import { selectChatSyncSettingState } from './sync-gate';

/**
 * The setting's own states. Sync runs by default, so only a stored "off"
 * keeps chats local; a read that has not answered yet, or cannot be read,
 * must never be mistaken for that choice.
 */
describe('selectChatSyncSettingState', () => {
  const retry = vi.fn();
  const base = { hasPlace: true, isPending: false, isPaused: false, isError: false, retry };

  it('runs by default when nothing was stored (the read answers on)', () => {
    expect(selectChatSyncSettingState({ ...base, isPending: true, setting: undefined }).kind).toBe(
      'loading'
    );
    expect(selectChatSyncSettingState({ ...base, setting: 'on' })).toEqual({ kind: 'on' });
  });

  it('keeps chats local only on a stored off', () => {
    expect(selectChatSyncSettingState({ ...base, setting: 'off' })).toEqual({ kind: 'off' });
  });

  it('is loading while the read has not answered', () => {
    expect(selectChatSyncSettingState({ ...base, isPending: true, setting: undefined })).toEqual({
      kind: 'loading',
    });
  });

  it('separates a retryable failure (paused/offline) from a terminal one', () => {
    expect(
      selectChatSyncSettingState({ ...base, isError: true, isPaused: true, setting: undefined })
    ).toEqual({ kind: 'failed', retryable: true, retry });
    expect(selectChatSyncSettingState({ ...base, isError: true, setting: undefined })).toEqual({
      kind: 'failed',
      retryable: false,
      retry,
    });
  });

  it('cannot read a setting without an account, and says so instead of guessing on', () => {
    expect(selectChatSyncSettingState({ ...base, hasPlace: false, setting: undefined })).toEqual({
      kind: 'failed',
      retryable: false,
      retry,
    });
  });
});
