import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useRootNavigationReady } from './navigation-ready';

const isReadyMock = vi.hoisted(() => vi.fn((): boolean => false));
const listeners = vi.hoisted(() => ({
  state: undefined as (() => void) | undefined,
}));

function addListenerMock(event: 'state', listener: () => void): () => void {
  listeners[event] = listener;
  const remove = (): void => {
    listeners[event] = undefined;
  };
  return remove;
}

vi.mock('expo-router', () => ({
  useNavigationContainerRef: () => ({
    isReady: isReadyMock,
    addListener: addListenerMock,
  }),
}));

let latestReady: boolean | undefined = undefined;

function Harness() {
  latestReady = useRootNavigationReady();
  return null;
}

function mount() {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(createElement(Harness));
  });
  if (!ref.current) {
    throw new Error('harness did not render');
  }
  return ref.current;
}

describe('useRootNavigationReady', () => {
  beforeEach(() => {
    isReadyMock.mockClear();
    isReadyMock.mockReturnValue(false);
    listeners.state = undefined;
    latestReady = undefined;
  });

  it('is false while the container reports not ready', () => {
    isReadyMock.mockReturnValue(false);
    mount();
    expect(latestReady).toBe(false);
  });

  it('is true once the container reports ready', () => {
    isReadyMock.mockReturnValue(true);
    mount();
    expect(latestReady).toBe(true);
  });

  it('re-reads on the state event, matching the screen-tracking subscription pattern', () => {
    mount();
    isReadyMock.mockReturnValue(true);
    act(() => {
      listeners.state?.();
    });
    expect(latestReady).toBe(true);
  });

  it('unsubscribes the state listener on unmount', () => {
    const renderer = mount();
    renderer.unmount();
    expect(listeners.state).toBeUndefined();
  });
});
