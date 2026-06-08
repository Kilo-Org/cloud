import { describe, expect, it } from 'vitest';

import { getSessionKeyboardContainerKind } from '@/components/agents/session-keyboard-container-state';

describe('getSessionKeyboardContainerKind', () => {
  it('uses app-aware padding on Android', () => {
    expect(getSessionKeyboardContainerKind('android')).toBe('app-aware-padding');
  });

  it('keeps keyboard avoiding behavior on iOS', () => {
    expect(getSessionKeyboardContainerKind('ios')).toBe('keyboard-avoiding');
  });
});
