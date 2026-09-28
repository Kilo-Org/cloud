import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ToolSummaryTranslationRetryMount } from './tool-summary-translation-retry-mount';

const { retryMock, connectionMock, linkingMock } = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const urlListeners = new Set<() => void>();
  return {
    retryMock: vi.fn(),
    connectionMock: {
      connected: false,
      listeners,
      isConnected: () => connectionMock.connected,
      onConnectionChange: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    linkingMock: {
      urlListeners,
      addEventListener: (type: string, listener: () => void) => {
        if (type !== 'url') {
          throw new Error(`unexpected linking event type ${type}`);
        }
        urlListeners.add(listener);
        return {
          remove: () => {
            urlListeners.delete(listener);
          },
        };
      },
    },
  };
});

vi.mock('./tool-summary-translation-runtime', () => ({
  retryUnresolvedTranslations: retryMock,
}));
vi.mock('@/components/agents/user-web-connection-provider', () => ({
  useUserWebConnection: () => connectionMock,
}));
vi.mock('react-native', () => ({ Linking: linkingMock }));

/** Flip the fake transport and deliver the change to every live subscriber. */
function setConnected(connected: boolean): void {
  connectionMock.connected = connected;
  act(() => {
    for (const listener of connectionMock.listeners) {
      listener();
    }
  });
}

/** Deliver a deep link while the app stays mounted. */
function deliverUrl(): void {
  act(() => {
    for (const listener of linkingMock.urlListeners) {
      listener();
    }
  });
}

function mount(): () => void {
  let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
  act(() => {
    renderer = TestRenderer.create(createElement(ToolSummaryTranslationRetryMount));
  });
  return () => {
    renderer?.unmount();
  };
}

beforeEach(() => {
  retryMock.mockReset();
  connectionMock.listeners.clear();
  connectionMock.connected = false;
  linkingMock.urlListeners.clear();
});

describe('ToolSummaryTranslationRetryMount', () => {
  it('retries the unresolved summaries on the down-to-up edge', () => {
    const unmount = mount();

    setConnected(true);
    expect(retryMock).toHaveBeenCalledTimes(1);

    setConnected(false);
    setConnected(true);
    expect(retryMock).toHaveBeenCalledTimes(2);
    unmount();
  });

  it('does not retry on the up-to-down edge or while the state holds', () => {
    connectionMock.connected = true;
    const unmount = mount();

    // A steady connected state delivers no change, so nothing re-sends.
    expect(retryMock).not.toHaveBeenCalled();
    setConnected(false);
    expect(retryMock).not.toHaveBeenCalled();
    unmount();
  });

  it('retries when a deep link is delivered to the mounted app', () => {
    const unmount = mount();

    // Re-entry to an already-open transcript navigates nowhere; the delivered
    // link alone must re-queue the summaries that failed while the gateway was
    // unreachable.
    deliverUrl();
    expect(retryMock).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('stops retrying after unmount', () => {
    const unmount = mount();
    unmount();

    setConnected(true);
    deliverUrl();
    expect(retryMock).not.toHaveBeenCalled();
    expect(connectionMock.listeners.size).toBe(0);
    expect(linkingMock.urlListeners.size).toBe(0);
  });
});
