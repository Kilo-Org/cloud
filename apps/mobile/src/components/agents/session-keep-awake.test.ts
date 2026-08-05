import { describe, expect, it } from 'vitest';

import { shouldKeepSessionAwake } from '@/components/agents/session-keep-awake';

function awakeState(
  overrides: Readonly<Partial<Parameters<typeof shouldKeepSessionAwake>[0]>> = {}
): Parameters<typeof shouldKeepSessionAwake>[0] {
  return {
    keepScreenOn: true,
    preferenceLoaded: true,
    isFocused: true,
    isDisconnected: false,
    isStreaming: false,
    pendingMessageCount: 0,
    ...overrides,
  };
}

describe('shouldKeepSessionAwake', () => {
  it('keeps the screen awake while on, focused, connected, and streaming', () => {
    expect(shouldKeepSessionAwake(awakeState({ isStreaming: true }))).toBe(true);
  });

  it('never keeps the screen awake when the preference is off, even while streaming', () => {
    expect(shouldKeepSessionAwake(awakeState({ keepScreenOn: false, isStreaming: true }))).toBe(
      false
    );
  });

  it('never keeps the screen awake when off with a pending message', () => {
    expect(
      shouldKeepSessionAwake(awakeState({ keepScreenOn: false, pendingMessageCount: 1 }))
    ).toBe(false);
  });

  it('lets an idle session sleep (not streaming, no pending messages)', () => {
    expect(shouldKeepSessionAwake(awakeState())).toBe(false);
  });

  it('never keeps the screen awake when the screen is not focused', () => {
    expect(shouldKeepSessionAwake(awakeState({ isFocused: false, isStreaming: true }))).toBe(false);
  });

  it('never keeps the screen awake while disconnected', () => {
    expect(shouldKeepSessionAwake(awakeState({ isDisconnected: true, isStreaming: true }))).toBe(
      false
    );
  });

  it('keeps the screen awake for a pending message without streaming', () => {
    expect(shouldKeepSessionAwake(awakeState({ pendingMessageCount: 1 }))).toBe(true);
  });

  it('treats an unloaded preference as off, so the read window never holds the lock', () => {
    expect(shouldKeepSessionAwake(awakeState({ preferenceLoaded: false, isStreaming: true }))).toBe(
      false
    );
  });
});
