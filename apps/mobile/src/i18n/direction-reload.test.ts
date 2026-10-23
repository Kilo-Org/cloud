import { describe, expect, it, vi } from 'vitest';

import { directionAttemptId, resolveDirectionReload } from './direction-reload';

// The attempt marker lives in the keychain; this suite exercises the decision
// and the identifier only, so the native store and its telemetry are stubbed.
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));
vi.mock('@sentry/react-native', () => ({ captureException: vi.fn() }));
vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));

const arabic = directionAttemptId('ar');
const english = directionAttemptId('en');

describe('directionAttemptId', () => {
  it('names the language together with the direction it needs', () => {
    expect(arabic).toBe('ar:rtl');
    expect(english).toBe('en:ltr');
  });
});

describe('resolveDirectionReload', () => {
  it('leaves a launch alone when the native direction already matches', () => {
    expect(
      resolveDirectionReload({
        nativeIsRtl: true,
        targetIsRtl: true,
        attemptId: arabic,
        previousAttempt: null,
      })
    ).toBe('in-sync');
  });

  it('reloads once for a direction the app has not tried yet', () => {
    expect(
      resolveDirectionReload({
        nativeIsRtl: false,
        targetIsRtl: true,
        attemptId: arabic,
        previousAttempt: null,
      })
    ).toBe('reload');
  });

  it('reloads for a different language even when another one already spent its attempt', () => {
    expect(
      resolveDirectionReload({
        nativeIsRtl: true,
        targetIsRtl: false,
        attemptId: english,
        previousAttempt: arabic,
      })
    ).toBe('reload');
  });

  it('gives up instead of repeating the reload the previous launch already made', () => {
    expect(
      resolveDirectionReload({
        nativeIsRtl: false,
        targetIsRtl: true,
        attemptId: arabic,
        previousAttempt: arabic,
      })
    ).toBe('give-up');
  });

  it('reports in-sync after a retry settles the direction, even with a marker left behind', () => {
    expect(
      resolveDirectionReload({
        nativeIsRtl: true,
        targetIsRtl: true,
        attemptId: arabic,
        previousAttempt: arabic,
      })
    ).toBe('in-sync');
  });
});
