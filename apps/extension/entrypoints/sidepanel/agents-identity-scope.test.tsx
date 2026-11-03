/* eslint-disable id-length, jest/no-untyped-mock-factory, vitest/prefer-import-in-mock -- module-state mocks mirror the provider's per-identity remount */
// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, waitFor } from '@testing-library/react';
import { createElement as h } from 'react';
import type { JSX } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoredAuth } from '@/src/shared/auth';
import { AgentsNewSession } from './agents-new-session';
import { AgentsSessionList } from './agents-session-list';

interface Scope {
  organizationId: string | null;
  token: string;
}

interface Handlers {
  activeSessions: () => Promise<unknown>;
  history: () => Promise<unknown>;
  instances: () => Promise<unknown>;
  repositories: () => Promise<unknown>;
}

let scope: Scope = { organizationId: null, token: 'token-a' };
let storedAuth: StoredAuth = { token: 'token-a', userEmail: 'first@example.test' };
let handlers: Handlers = {
  activeSessions: () => resolved({ sessions: [] }),
  history: () => resolved({ cliSessions: [] }),
  instances: () => resolved({ instances: [] }),
  repositories: () => resolved({ integrationInstalled: true, repositories: [] }),
};

function resolved<Value>(value: Value): Promise<Value> {
  return Promise.resolve(value);
}

function resolvedVoid(): Promise<void> {
  return Promise.resolve();
}

function rejected(message: string): Promise<never> {
  return Promise.reject(new Error(message));
}

vi.mock('@/src/shared/auth', () => ({
  getKiloApiBaseUrl: () => 'https://app.kilo.test',
  loadStoredAuth: () => resolved(storedAuth),
}));

vi.mock('@/src/shared/model-preferences-client', () => ({
  fetchModelPreferences: () => resolved({ favorites: [], lastSelected: null }),
}));

vi.mock('./use-gateway-models', () => ({
  useGatewayModels: () => ({
    isLoading: false,
    modelLoadError: undefined,
    modelOptions: [],
    refetchModels: resolvedVoid,
  }),
}));

vi.mock('./use-model-preferences', () => ({
  useModelPreferences: () => ({
    favorites: new Set<string>(),
    refetch: resolvedVoid,
    status: 'ready',
    toggleError: false,
    toggleFavorite: () => {},
  }),
}));

vi.mock('./agents-provider', () => ({
  useExtensionAgents: () => ({
    manager: {},
    organizationId: scope.organizationId,
    store: {},
    token: scope.token,
    trpcClient: {
      activeSessions: {
        list: { query: () => handlers.activeSessions() },
        listInstances: { query: () => handlers.instances() },
      },
      cliSessionsV2: {
        list: { query: () => handlers.history() },
        search: { query: () => handlers.history() },
      },
      cloudAgentNext: {
        listGitHubRepositories: { query: () => handlers.repositories() },
      },
      organizations: {
        cloudAgentNext: {
          listGitHubRepositories: { query: () => handlers.repositories() },
        },
      },
    },
    userWebConnection: {
      isConnected: () => true,
      onConnectionChange: () => () => {},
      onSessionEvent: () => () => {},
    },
  }),
}));

const noop = (): void => {};

/* The real provider remounts its subtree per identity; the probe key models that. */
const Probe = (): JSX.Element => {
  const identity = `${scope.token}:${String(scope.organizationId)}`;
  return h(
    'div',
    null,
    h(AgentsSessionList, {
      key: `list:${identity}`,
      onNewSession: noop,
      onOpenSession: noop,
    }),
    h(AgentsNewSession, {
      key: `new:${identity}`,
      onCancel: noop,
      onCreated: noop,
    })
  );
};

const alphaHandlers: Handlers = {
  activeSessions: () =>
    resolved({
      sessions: [
        {
          connectionId: 'cloud-agent',
          gitBranch: 'a-branch',
          gitUrl: 'https://github.com/a-org/a-private-repo',
          id: 'a-session-1',
          status: 'running',
          title: 'Alpha session',
        },
      ],
    }),
  history: () =>
    resolved({
      cliSessions: [
        { session_id: 'a-history-1', title: 'Alpha history', updated_at: '2026-10-20' },
      ],
    }),
  instances: () =>
    resolved({
      instances: [
        {
          connectionId: 'cli-a',
          gitBranch: null,
          kind: 'cli',
          name: 'Alpha device',
          projectName: 'alpha-project',
          startedAt: '2026-10-20T00:00:00.000Z',
        },
      ],
    }),
  repositories: () =>
    resolved({
      integrationInstalled: true,
      repositories: [
        { fullName: 'a-org/a-private-repo', id: 1, name: 'a-private-repo', private: true },
      ],
    }),
};

const switchIdentity = (queryClient: QueryClient): void => {
  scope = { organizationId: null, token: 'token-b' };
  storedAuth = { token: 'token-b', userEmail: 'second@example.test' };
  queryClient.setQueryData(['side-panel', 'stored-auth'], storedAuth);
};

const renderProbe = (queryClient: QueryClient) =>
  render(h(QueryClientProvider, { client: queryClient }, h(Probe)));

describe('agents views render the signed-in identity data', () => {
  // eslint-disable-next-line jest/no-hooks -- each test starts from a fresh identity
  beforeEach(() => {
    scope = { organizationId: null, token: 'token-a' };
    storedAuth = { token: 'token-a', userEmail: 'first@example.test' };
    handlers = alphaHandlers;
  });

  it('renders sessions, history and repositories for the signed-in identity', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { gcTime: Infinity, retry: false } },
    });
    const { container, rerender } = renderProbe(queryClient);

    await waitFor(() => {
      expect(container.textContent).toContain('Alpha session');
    });
    expect(container.textContent).toContain('Alpha history');
    expect(container.textContent).toContain('a-org/a-private-repo');
    await waitFor(() => {
      expect(container.textContent).toContain('Alpha device · alpha-project');
    });

    const pending = Promise.withResolvers<unknown>();
    handlers = {
      activeSessions: () => pending.promise,
      history: () => pending.promise,
      instances: () => pending.promise,
      repositories: () => pending.promise,
    };
    switchIdentity(queryClient);
    rerender(h(QueryClientProvider, { client: queryClient }, h(Probe)));

    await waitFor(() => {
      expect(container.textContent).not.toContain('Alpha session');
    });
    expect(container.textContent).not.toContain('Alpha history');
    expect(container.textContent).not.toContain('a-org/a-private-repo');
    expect(container.textContent).not.toContain('Alpha device');

    pending.resolve({
      cliSessions: [],
      instances: [],
      integrationInstalled: true,
      repositories: [],
      sessions: [],
    });
    await waitFor(() => {
      expect(container.textContent).not.toContain('Alpha session');
    });
  });

  it('renders query errors for the signed-in identity', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { gcTime: Infinity, retry: false } },
    });
    const { container, rerender } = renderProbe(queryClient);

    await waitFor(() => {
      expect(container.textContent).toContain('Alpha session');
    });

    handlers = {
      activeSessions: () => rejected('Network unavailable'),
      history: () => rejected('Network unavailable'),
      instances: () => rejected('Network unavailable'),
      repositories: () => rejected('Network unavailable'),
    };
    switchIdentity(queryClient);
    rerender(h(QueryClientProvider, { client: queryClient }, h(Probe)));

    await waitFor(() => {
      expect(container.textContent).toContain('Failed to load active sessions');
    });
    expect(container.textContent).toContain('Failed to load sessions');
    expect(container.textContent).not.toContain('Alpha session');
    expect(container.textContent).not.toContain('Alpha history');
    expect(container.textContent).not.toContain('a-org/a-private-repo');
    expect(container.textContent).not.toContain('Alpha device');
  });
});
