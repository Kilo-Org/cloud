/* eslint-disable typescript-eslint/no-deprecated, react/no-children-prop -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as user-web-connection-provider.mounted.test.tsx); `children` must be passed as a prop because this is a .ts file with no JSX */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { UserWebConnectionProvider } from './user-web-connection-provider';

type AuthConfig = { getAuthToken: () => Promise<string> };

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(async () => {
    await Promise.resolve();
    return { token: 'ticket-1', expiresAt: 1_700_000_060 };
  }),
  query: vi.fn(),
  capturedConfig: null as AuthConfig | null,
}));

vi.mock('@kilocode/cloud-agent-sdk/user-web-connection', () => ({
  createUserWebConnection: (config: AuthConfig) => {
    mocks.capturedConfig = config;
    return { retain: () => vi.fn() };
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
  });

  it('mints the ingest ticket via the getToken mutation (not query)', async () => {
    const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
      current: undefined,
    };
    await act(async () => {
      await Promise.resolve();
      rendererRef.current = TestRenderer.create(
        createElement(UserWebConnectionProvider, { children: null })
      );
    });

    const config = mocks.capturedConfig;
    if (!config) {
      throw new Error('createUserWebConnection was not called');
    }

    const token = await config.getAuthToken();

    expect(token).toBe('ticket-1');
    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    expect(mocks.query).not.toHaveBeenCalled();

    const renderer = rendererRef.current;
    if (!renderer) {
      throw new Error('renderer was not created');
    }
    await act(async () => {
      await Promise.resolve();
      renderer.unmount();
    });
  });
});
