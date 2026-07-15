import { vi } from 'vitest';

import { type LocalRuntimeFence } from './local-runtime-catalog-types';

export type AppStateStatus = 'active' | 'background' | 'inactive';

type SystemListener = (event: { event: string; data: unknown }) => void;
type ReconnectListener = () => void;

type ConnectionHandle = {
  retain?: ReturnType<typeof vi.fn<() => () => void>>;
  release: ReturnType<typeof vi.fn<() => void>>;
  onSystemEvent: ReturnType<typeof vi.fn<(listener: SystemListener) => () => void>>;
  offSystemEvent: () => void;
  onReconnect: ReturnType<typeof vi.fn<(listener: ReconnectListener) => () => void>>;
  offReconnect: () => void;
};

type ListenerHandles = Pick<
  ConnectionHandle,
  'onSystemEvent' | 'offSystemEvent' | 'onReconnect' | 'offReconnect'
>;

export type QueryShape = {
  data: unknown;
  error: unknown;
  isLoading: boolean;
  refetch: () => void;
};

type TestState = {
  appStateListeners: ((state: AppStateStatus) => void)[];
  cleanups: (() => void)[];
  connection: ConnectionHandle | null;
  fence: LocalRuntimeFence | null;
  invalidatedKeys: unknown[];
  queryData: unknown;
  queryError: unknown;
  queryIsLoading: boolean;
  refetchCount: number;
  systemListeners: SystemListener[];
  reconnectListeners: ReconnectListener[];
  lastQueryOptions: { queryKey: unknown; enabled?: boolean } | null;
};

export const testState: TestState = {
  appStateListeners: [],
  cleanups: [],
  connection: null,
  fence: null,
  invalidatedKeys: [],
  queryData: undefined,
  queryError: null,
  queryIsLoading: false,
  refetchCount: 0,
  systemListeners: [],
  reconnectListeners: [],
  lastQueryOptions: null,
};

export const mocks = {
  useAppPresence: vi.fn<() => void>(),
  useUserWebConnection: vi.fn<() => ConnectionHandle | null>(),
  useQuery: vi.fn(),
  useQueryClient: vi.fn(),
};

function makeListenerHandles(): ListenerHandles {
  const offSystem = vi.fn<() => void>();
  const offReconnect = vi.fn<() => void>();
  const onSystemEvent = vi.fn((listener: SystemListener) => {
    testState.systemListeners.push(listener);
    return () => {
      offSystem();
      testState.systemListeners = testState.systemListeners.filter(l => l !== listener);
    };
  });
  const onReconnect = vi.fn((listener: ReconnectListener) => {
    testState.reconnectListeners.push(listener);
    return () => {
      offReconnect();
      testState.reconnectListeners = testState.reconnectListeners.filter(l => l !== listener);
    };
  });
  return { onSystemEvent, offSystemEvent: offSystem, onReconnect, offReconnect };
}

function makeConnection(): ConnectionHandle {
  const release = vi.fn<() => void>();
  const retain = vi.fn<() => () => void>(() => release);
  return { ...makeListenerHandles(), retain, release };
}

export function makeConnectionWithoutRetain(): ConnectionHandle {
  return { ...makeListenerHandles(), release: vi.fn<() => void>() };
}

export const FENCE_A: LocalRuntimeFence = {
  runtimeId: '11111111-1111-4111-8111-111111111111',
  connectionId: 'cli-a',
};

export const FENCE_A_RECONNECTED: LocalRuntimeFence = {
  runtimeId: '11111111-1111-4111-8111-111111111111',
  connectionId: 'cli-a-new',
};

export function resetTestState() {
  testState.appStateListeners = [];
  testState.cleanups = [];
  testState.connection = makeConnection();
  testState.fence = null;
  testState.invalidatedKeys = [];
  testState.queryData = undefined;
  testState.queryError = null;
  testState.queryIsLoading = false;
  testState.refetchCount = 0;
  testState.systemListeners = [];
  testState.reconnectListeners = [];
  testState.lastQueryOptions = null;
  vi.clearAllMocks();
  mocks.useAppPresence.mockReset();
  mocks.useUserWebConnection.mockReset();
  mocks.useQuery.mockReset();
  mocks.useQueryClient.mockReset();
  mocks.useUserWebConnection.mockImplementation(() => testState.connection);
}

export function cleanupTestState() {
  for (const cleanup of testState.cleanups) {
    cleanup();
  }
  vi.clearAllMocks();
}

export async function importHook() {
  const module = await import('./use-local-runtime-catalog');
  return module;
}
