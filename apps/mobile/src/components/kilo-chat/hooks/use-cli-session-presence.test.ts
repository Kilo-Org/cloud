import { describe, expect, it, vi } from 'vitest';

import { resolveLoadedCliSessionPresenceId } from './use-cli-session-presence';

// Mock the transitive react-native import (Flow source trips rolldown's
// SSR transform) and the bare minimum of useAppActiveAndFocused's other
// dependency. We only exercise resolveLoadedCliSessionPresenceId here.
vi.mock('react-native', () => ({
  AppState: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
}));

vi.mock('expo-router', () => ({
  useFocusEffect: vi.fn(),
}));

describe('resolveLoadedCliSessionPresenceId', () => {
  it('returns the route ID only after matching session data loads', () => {
    expect(resolveLoadedCliSessionPresenceId('route-1', 'route-1')).toBe('route-1');
  });

  it.each([undefined, null, 'other-session'])(
    'does not claim presence for loaded ID %s',
    loadedSessionId => {
      expect(resolveLoadedCliSessionPresenceId('route-1', loadedSessionId)).toBeUndefined();
    }
  );
});
