// The Android entry point is a single shared launcher shortcut, so it belongs
// to the session the user is looking at: the advertiser publishes on route
// focus and clears on blur. A covered session stays mounted, so it must
// neither republish over the session the user moved to nor clear that
// session's shortcut when it loses focus. iOS re-registers its NSUserActivity
// when focus returns, so both platforms name the same session.

import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionHandoffAdvertiser } from './session-handoff.android';

const nativeModule = vi.hoisted(() => ({
  publishSession: vi.fn(),
  clearSession: vi.fn(),
}));

// Captures the focus-effect callback (and the cleanup it returns) so a test can
// simulate the route gaining and losing focus.
const focus = vi.hoisted(() => ({
  effect: undefined as (() => (() => void) | undefined) | undefined,
}));

vi.mock('expo', () => ({
  requireOptionalNativeModule: () => nativeModule,
}));

vi.mock('expo-router', () => ({
  useFocusEffect: (effect: () => (() => void) | undefined) => {
    focus.effect = effect;
  },
}));

const SESSION_TITLE = 'Fix the flaky test';
const SESSION_URL = 'https://app.kilo.ai/cloud/sessions/ses_1?at=msg_42';

type AdvertiserProps = {
  sessionId?: string;
  anchorMessageId?: string | null;
  title?: string;
};

function renderAdvertiser({
  sessionId = 'ses_1',
  anchorMessageId = 'msg_42',
  title = SESSION_TITLE,
}: AdvertiserProps = {}): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(
      createElement(SessionHandoffAdvertiser, { sessionId, anchorMessageId, title })
    );
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

/** Simulates the route gaining focus; returns the cleanup that blur runs. */
function focusRoute(): () => void {
  const focusEffect = focus.effect;
  let cleanup: (() => void) | undefined = undefined;
  act(() => {
    cleanup = focusEffect?.();
  });
  return () => {
    cleanup?.();
  };
}

describe('SessionHandoffAdvertiser', () => {
  beforeEach(() => {
    focus.effect = undefined;
    nativeModule.publishSession.mockClear();
    nativeModule.clearSession.mockClear();
  });

  it('publishes nothing while the session is mounted but not the visible one', () => {
    renderAdvertiser();

    expect(nativeModule.publishSession).not.toHaveBeenCalled();
  });

  it('publishes the session link and its position when the route is focused', () => {
    renderAdvertiser();

    focusRoute();

    expect(nativeModule.publishSession).toHaveBeenCalledWith(SESSION_URL, SESSION_TITLE, 'msg_42');
  });

  it('clears the entry point when the route loses focus', () => {
    renderAdvertiser();
    const blur = focusRoute();
    nativeModule.clearSession.mockClear();

    blur();

    expect(nativeModule.clearSession).toHaveBeenCalledTimes(1);
  });

  it('advertises nothing for a session with no id, focused or not', () => {
    renderAdvertiser({ sessionId: '' });

    expect(nativeModule.publishSession).not.toHaveBeenCalled();

    focusRoute();

    expect(nativeModule.publishSession).not.toHaveBeenCalled();
    expect(nativeModule.clearSession).toHaveBeenCalled();
  });
});
