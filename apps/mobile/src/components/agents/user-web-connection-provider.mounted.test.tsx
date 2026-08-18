/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as src/test/render-with-providers.tsx) */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { UserWebConnectionProvider } from './user-web-connection-provider';

type AuthConfig = { getAuthToken: () => Promise<string> };

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(async () => ({ token: 'ticket-1', expiresAt: 1_700_000_060 })),
  query: vi.fn(),
  createUserWebConnection: vi.fn(),
  capturedConfig: null as AuthConfig | null,
}));

vi.mock('@kilocode/cloud-agent-sdk/user-web-connection', () => ({
  createUserWebConnection: (config: AuthConfig) => {
    mocks.capturedConfig = config;
    mocks.createUserWebConnection(config);
    return {
      retain: () => () => {},
      connect: () => {},
      disconnect: () => {},
      destroy: () => {},
      isConnected: () => false,
      onConnectionChange: () => () => {},
      subscribeToCliSession: () => () => {},
      sendCommand: async () => ({}),
      sendCommandToConnection: async () => ({}),
      onCliEvent: () => () => {},
      onSystemEvent: () => () => {},
      onReconnect: () => () => {},
      onSessionEvent: () => () => {},
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

  it('mints the ingest ticket via the getToken mutation', async () => {
    let renderer: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      renderer = TestRenderer.create(createElement(UserWebConnectionProvider, { children: null }));
    });

    expect(mocks.createUserWebConnection).toHaveBeenCalledTimes(1);
    expect(mocks.capturedConfig).not.toBeNull();

    const token = await mocks.capturedConfig!.getAuthToken();

    expect(token).toBe('ticket-1');
    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    expect(mocks.query).not.toHaveBeenCalled();

    await act(async () => {
      renderer!.unmount();
    });
  });
});
