import type { V2SessionState } from '../sessions/types';
import type { V2StreamingConfig } from '../sessions/v2/streaming';

const mockConnect = jest.fn();

jest.mock('@/lib/cloud-agent-next/websocket-manager', () => ({
  createWebSocketManager: jest.fn(() => ({
    connect: mockConnect,
    disconnect: jest.fn(),
  })),
}));
jest.mock('@/lib/cloud-agent-next/processor', () => ({
  createEventProcessor: jest.fn(() => ({
    processEvent: jest.fn(),
    forceCompleteAll: jest.fn(),
    clear: jest.fn(),
  })),
}));
jest.mock('@/lib/constants', () => ({
  CLOUD_AGENT_NEXT_WS_URL: 'https://cloud-agent.example.com',
}));

import { createV2StreamingCoordinator } from '../sessions/v2/streaming';

function makeStore() {
  let state: V2SessionState = {
    messages: [],
    isStreaming: false,
    questionRequestIds: new Map(),
    childSessionMessages: new Map(),
  };
  const updates: Array<Partial<V2SessionState>> = [];

  return {
    updates,
    getState: () => state,
    setState: jest.fn((partial: Partial<V2SessionState>) => {
      updates.push(partial);
      state = { ...state, ...partial };
    }),
    subscribe: jest.fn(() => () => {}),
    updateMessages: jest.fn(),
    setQuestionRequestId: jest.fn(),
    updateChildSessionMessages: jest.fn(),
    getChildSessionMessages: jest.fn(() => []),
  };
}

function makeTrpcClient() {
  return {
    appBuilder: {
      startSession: {
        mutate: jest.fn(async () => ({ cloudAgentSessionId: 'canonical-session' })),
      },
      sendMessage: {
        mutate: jest.fn(async () => ({
          cloudAgentSessionId: 'canonical-session',
          workerVersion: 'v2' as const,
        })),
      },
    },
  };
}

describe('V2 reconnect streaming state', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(global, 'fetch').mockImplementation(async () =>
      Promise.resolve(
        new Response(JSON.stringify({ ticket: 'stream-ticket' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function makeCoordinator() {
    const store = makeStore();
    const coordinator = createV2StreamingCoordinator({
      projectId: 'project-1',
      organizationId: null,
      trpcClient: makeTrpcClient() as unknown as V2StreamingConfig['trpcClient'],
      store,
      cloudAgentSessionId: 'canonical-session',
    });
    return { coordinator, store };
  }

  it('does not optimistically mark a reconnect as streaming', async () => {
    const { coordinator, store } = makeCoordinator();

    coordinator.connectToExistingSession('canonical-session');
    await new Promise(resolve => setImmediate(resolve));

    expect(store.updates).not.toContainEqual({ isStreaming: true });
    expect(mockConnect).toHaveBeenCalled();
  });

  it('keeps optimistic streaming state for sends and starts', () => {
    const send = makeCoordinator();
    const start = makeCoordinator();

    send.coordinator.sendMessage('Build it');
    start.coordinator.startInitialStreaming();

    expect(send.store.updates).toContainEqual({ isStreaming: true });
    expect(start.store.updates).toContainEqual({ isStreaming: true });
  });
});
