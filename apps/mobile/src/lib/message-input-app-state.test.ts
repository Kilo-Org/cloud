import { describe, expect, it } from 'vitest';

import { resolveMessageInputAppStateTransition } from './message-input-app-state';

describe('message input app state', () => {
  it('blurs a focused composer before the app backgrounds and restores focus on return', () => {
    const backgroundTransition = resolveMessageInputAppStateTransition({
      nextAppState: 'background',
      restoreFocusOnActive: false,
      wasFocused: true,
    });

    expect(backgroundTransition).toEqual({
      restoreFocusOnActive: true,
      shouldBlur: true,
      shouldFocus: false,
    });

    expect(
      resolveMessageInputAppStateTransition({
        nextAppState: 'active',
        restoreFocusOnActive: backgroundTransition.restoreFocusOnActive,
        wasFocused: false,
      })
    ).toEqual({
      restoreFocusOnActive: false,
      shouldBlur: false,
      shouldFocus: true,
    });
  });

  it('does not focus the composer on return when it was not focused before backgrounding', () => {
    const backgroundTransition = resolveMessageInputAppStateTransition({
      nextAppState: 'background',
      restoreFocusOnActive: false,
      wasFocused: false,
    });

    expect(backgroundTransition).toEqual({
      restoreFocusOnActive: false,
      shouldBlur: false,
      shouldFocus: false,
    });

    expect(
      resolveMessageInputAppStateTransition({
        nextAppState: 'active',
        restoreFocusOnActive: backgroundTransition.restoreFocusOnActive,
        wasFocused: false,
      })
    ).toEqual({
      restoreFocusOnActive: false,
      shouldBlur: false,
      shouldFocus: false,
    });
  });
});
