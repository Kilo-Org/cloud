import { describe, expect, it } from 'vitest';

import { resolveAppAwareKeyboardPadding } from './app-aware-keyboard-padding-state';

describe('app-aware keyboard padding', () => {
  it('uses the keyboard height while visible', () => {
    expect(
      resolveAppAwareKeyboardPadding({
        currentPadding: 0,
        event: { type: 'keyboard-visible', keyboardHeight: 320 },
      })
    ).toBe(320);
  });

  it('resets stale keyboard padding when the app leaves the foreground', () => {
    expect(
      resolveAppAwareKeyboardPadding({
        currentPadding: 320,
        event: { type: 'app-state-change', appState: 'background' },
      })
    ).toBe(0);
  });

  it('keeps padding reset on foreground until a fresh keyboard event arrives', () => {
    expect(
      resolveAppAwareKeyboardPadding({
        currentPadding: 0,
        event: { type: 'app-state-change', appState: 'active' },
      })
    ).toBe(0);
  });
});
