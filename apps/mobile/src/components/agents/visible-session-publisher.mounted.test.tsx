import { type KiloSessionId } from '@kilocode/cloud-agent-sdk';
import { createElement, type EffectCallback } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { VisibleSessionPublisher } from '@/components/agents/visible-session-publisher';

// The route focus hook is a real effect here, so mount and unmount run the
// publisher's cue and its clear in the order the screen produces them.
vi.mock('expo-router', async () => {
  const { useEffect } = await import('react');
  return {
    useFocusEffect: (effect: EffectCallback) => {
      useEffect(effect, [effect]);
    },
  };
});

const unlock = vi.hoisted(() => ({
  status: 'unlocked' as 'locked' | 'preference-loading' | 'unlocked',
  useAppUnlock: () => ({ status: unlock.status }),
}));

vi.mock('@/lib/app-unlock-context', () => ({ useAppUnlock: unlock.useAppUnlock }));

const nativeBridge = vi.hoisted(() => ({
  setNativeVisibleSession: vi.fn<(sessionId: string | null) => Promise<void>>(),
}));

vi.mock('@/lib/app-actions/native-bridge', () => nativeBridge);

const telemetry = vi.hoisted(() => ({ captureTelemetry: vi.fn() }));

vi.mock('@/lib/telemetry/error-sink', () => telemetry);

const SESSION = 'sess-1' as KiloSessionId;

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

beforeEach(() => {
  vi.clearAllMocks();
  unlock.status = 'unlocked';
  nativeBridge.setNativeVisibleSession.mockResolvedValue(undefined);
});

function renderSession(sessionId: KiloSessionId): void {
  act(() => {
    renderer = TestRenderer.create(createElement(VisibleSessionPublisher, { sessionId }));
  });
}

/** Re-renders after the provider published `status`. */
function setStatus(status: 'locked' | 'preference-loading' | 'unlocked'): void {
  unlock.status = status;
  act(() => {
    renderer?.update(createElement(VisibleSessionPublisher, { sessionId: SESSION }));
  });
}

describe('the visible session publisher', () => {
  it('publishes the mounted session and clears it on unmount', () => {
    renderSession(SESSION);

    expect(nativeBridge.setNativeVisibleSession).toHaveBeenCalledExactlyOnceWith(SESSION);

    act(() => {
      renderer?.unmount();
    });
    renderer = undefined;

    expect(nativeBridge.setNativeVisibleSession).toHaveBeenLastCalledWith(null);
  });

  it('moves the cue when the screen opens another session', () => {
    renderSession(SESSION);
    act(() => {
      renderer?.update(
        createElement(VisibleSessionPublisher, { sessionId: 'sess-2' as KiloSessionId })
      );
    });

    const calls = nativeBridge.setNativeVisibleSession.mock.calls.map(([id]) => id);
    // The old session is cleared before the new one is published, so the
    // on-screen entity never names a session the person already left.
    expect(calls).toEqual([SESSION, null, 'sess-2']);
  });

  it('clears the cue when the lock covers the screen, and publishes nothing while it does', () => {
    renderSession(SESSION);

    setStatus('locked');

    const calls = nativeBridge.setNativeVisibleSession.mock.calls.map(([id]) => id);
    // The lock surface keeps this tree mounted behind it, so the cue must be
    // withdrawn rather than left naming a session the person cannot see.
    expect(calls).toEqual([SESSION, null]);

    setStatus('locked');
    expect(nativeBridge.setNativeVisibleSession.mock.calls.map(([id]) => id)).toEqual([
      SESSION,
      null,
    ]);
  });

  it('holds the cue back while the launch is still reading the lock preference', () => {
    unlock.status = 'preference-loading';

    renderSession(SESSION);

    expect(nativeBridge.setNativeVisibleSession).not.toHaveBeenCalled();
  });

  it('publishes again once the lock opens', () => {
    renderSession(SESSION);
    setStatus('locked');
    nativeBridge.setNativeVisibleSession.mockClear();

    setStatus('unlocked');

    // The locked effect's cleanup clears first, then the cue is published again.
    expect(nativeBridge.setNativeVisibleSession).toHaveBeenLastCalledWith(SESSION);
  });

  it('reports a failed publish without breaking the screen', async () => {
    const failure = new Error('no key window');
    nativeBridge.setNativeVisibleSession.mockRejectedValueOnce(failure);

    renderSession(SESSION);

    await vi.waitFor(() => {
      expect(telemetry.captureTelemetry).toHaveBeenCalledWith({
        error: failure,
        level: 'warning',
        tags: { 'error.subsystem': 'app-intent-catalog', 'error.operation': 'visible-session' },
      });
    });
  });
});
