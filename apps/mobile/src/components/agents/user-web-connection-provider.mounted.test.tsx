/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as src/test/render-with-providers.tsx) */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { UserWebConnectionProvider } from './user-web-connection-provider';

type AuthConfig = { getAuthToken: () => Promise<string> };

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  query: vi.fn(() => ({ token: 'ticket-1', expiresAt: 1_700_000_060 })),
  createUserWebConnection: vi.fn(),
  capturedConfig: null as AuthConfig | null,
}));

vi.mock('@kilocode/cloud-agent-sdk/user-web-connection', () => ({
  createUserWebConnection: (config: AuthConfig) => {
    mocks.capturedConfig = config;
    mocks.createUserWebConnection(config);
    return {
      retain: vi.fn(() => vi.fn()),
      connect: vi.fn(),
      disconnect: vi.fn(),
      destroy: vi.fn(),
      isConnected: vi.fn(() => false),
      onConnectionChange: vi.fn(() => vi.fn()),
      subscribeToCliSession: vi.fn(() => vi.fn()),
      sendCommand: vi.fn(),
      sendCommandToConnection: vi.fn(),
      onCliEvent: vi.fn(() => vi.fn()),
      onSystemEvent: vi.fn(() => vi.fn()),
      onReconnect: vi.fn(() => vi.fn()),
      onSessionEvent: vi.fn(() => vi.fn()),
    };
  },
}));

vi.mock('@/lib/config', () => ({
  SESSION_INGEST_WS_URL: 'wss://ingest.example.com',
}));

vi.mock('@/lib/user-web-connection-lifecycle', () => ({
  createNativeUserWebConnectionLifecycleHooks: () => ({}),
}));

vi.mock('@/lib/trpc', () => ({
  trpcClient: {
    activeSessions: {
      getToken: {
        mutate: mocks.mutate,
        query: mocks.query,
      },
    },
  },
}));

describe('UserWebConnectionProvider', () => {
  beforeEach(() => {
    mocks.capturedConfig = null;
    mocks.mutate.mockClear();
    mocks.query.mockClear();
    mocks.createUserWebConnection.mockClear();
  });

  it('mints the ingest ticket via the getToken query', async () => {
    const holder: { renderer?: TestRenderer.ReactTestRenderer } = {};
    await act(() => {
      holder.renderer = TestRenderer.create(createElement(UserWebConnectionProvider, null));
    });

    expect(mocks.createUserWebConnection).toHaveBeenCalledTimes(1);
    const config = mocks.capturedConfig;
    if (!config) {
      throw new Error('user web connection config not captured');
    }

    const token = await config.getAuthToken();

    expect(token).toBe('ticket-1');
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(mocks.mutate).not.toHaveBeenCalled();

    await act(() => {
      holder.renderer?.unmount();
    });
  });
});
