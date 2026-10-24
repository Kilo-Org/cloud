import { describe, expect, it, vi } from 'vitest';

import { isAppLandingSegments, resolvePickerLaunchRestorePath } from './picker-launch-restore';
import { type PickerLaunchContext } from './picker-launch-context';

// The resolver only reads the shared window and the context type from the
// stored-context module; stub its native store so this stays a pure suite.
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));

const NOW = 1_700_000_000_000;

const HOME_SEGMENTS = ['(app)', '(tabs)', '(0_home)'] as const;

function context(overrides: Partial<PickerLaunchContext> = {}): PickerLaunchContext {
  return {
    userId: 'user-1',
    surface: 'agent-new',
    sessionId: null,
    organizationId: null,
    launchedAt: NOW,
    ...overrides,
  };
}

describe('isAppLandingSegments', () => {
  it('matches the route the app opens on and nothing under or above it', () => {
    expect(isAppLandingSegments(HOME_SEGMENTS)).toBe(true);
    // The index route redirects to the opening tab; it is the same start.
    expect(isAppLandingSegments(['(app)'])).toBe(true);
    expect(isAppLandingSegments([...HOME_SEGMENTS, 'agent-chat'])).toBe(false);
    expect(isAppLandingSegments(['(app)', '(tabs)'])).toBe(false);
    expect(isAppLandingSegments(['(app)', '(tabs)', '(2_agents)'])).toBe(false);
  });
});

describe('resolvePickerLaunchRestorePath', () => {
  it('reopens the new-session composer for the account that launched the picker', () => {
    expect(
      resolvePickerLaunchRestorePath({
        context: context(),
        userId: 'user-1',
        now: NOW,
        atLandingRoute: true,
      })
    ).toBe('/(app)/agent-chat/new');
  });

  it('keeps the organization the launch was scoped to', () => {
    expect(
      resolvePickerLaunchRestorePath({
        context: context({ organizationId: 'org_123' }),
        userId: 'user-1',
        now: NOW,
        atLandingRoute: true,
      })
    ).toBe('/(app)/agent-chat/new?organizationId=org_123');
  });

  it('does not restore from a route the app was sent to', () => {
    expect(
      resolvePickerLaunchRestorePath({
        context: context(),
        userId: 'user-1',
        now: NOW,
        atLandingRoute: false,
      })
    ).toBeNull();
  });

  it('waits for the account instead of restoring another account’s launch', () => {
    expect(
      resolvePickerLaunchRestorePath({
        context: context(),
        userId: undefined,
        now: NOW,
        atLandingRoute: true,
      })
    ).toBeNull();
    expect(
      resolvePickerLaunchRestorePath({
        context: context({ userId: 'user-2' }),
        userId: 'user-1',
        now: NOW,
        atLandingRoute: true,
      })
    ).toBeNull();
  });

  it('reopens the session composer the launch belonged to', () => {
    expect(
      resolvePickerLaunchRestorePath({
        context: context({ surface: 'agent-chat', sessionId: 'ses_0123456789abcdef0123456789' }),
        userId: 'user-1',
        now: NOW,
        atLandingRoute: true,
      })
    ).toBe('/(app)/agent-chat/ses_0123456789abcdef0123456789');
  });

  it('keeps the session’s organization and has nothing to restore without a session', () => {
    expect(
      resolvePickerLaunchRestorePath({
        context: context({
          surface: 'agent-chat',
          sessionId: 'ses_0123456789abcdef0123456789',
          organizationId: 'org_123',
        }),
        userId: 'user-1',
        now: NOW,
        atLandingRoute: true,
      })
    ).toBe('/(app)/agent-chat/ses_0123456789abcdef0123456789?organizationId=org_123');
    expect(
      resolvePickerLaunchRestorePath({
        context: context({ surface: 'agent-chat', sessionId: null }),
        userId: 'user-1',
        now: NOW,
        atLandingRoute: true,
      })
    ).toBeNull();
  });

  it('leaves the picture entry alone: it launches from the route it returns to', () => {
    expect(
      resolvePickerLaunchRestorePath({
        context: context({ surface: 'agent-picture' }),
        userId: 'user-1',
        now: NOW,
        atLandingRoute: true,
      })
    ).toBeNull();
  });

  it('ignores a launch older than the recovery window', () => {
    expect(
      resolvePickerLaunchRestorePath({
        context: context({ launchedAt: NOW - 11 * 60 * 1000 }),
        userId: 'user-1',
        now: NOW,
        atLandingRoute: true,
      })
    ).toBeNull();
  });

  it('has nothing to restore without a stored launch', () => {
    expect(
      resolvePickerLaunchRestorePath({
        context: null,
        userId: 'user-1',
        now: NOW,
        atLandingRoute: true,
      })
    ).toBeNull();
  });
});
