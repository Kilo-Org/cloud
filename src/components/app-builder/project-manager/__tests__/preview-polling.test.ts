/**
 * Preview Polling Module Tests
 *
 * Tests for preview status polling and automatic build triggers.
 */

import { startPreviewPolling, POLLING_CONFIG } from '../preview-polling';
import type { PreviewPollingConfig, ProjectStore, ProjectState } from '../types';

// Helper to create a mock store for testing
function createMockStore(): ProjectStore & { stateUpdates: Array<Record<string, unknown>> } {
  const stateUpdates: Array<Record<string, unknown>> = [];
  let currentState: ProjectState = {
    messages: [],
    isStreaming: false,
    isInterrupting: false,
    previewUrl: null,
    previewStatus: 'idle',
    deploymentId: null,
    model: 'anthropic/claude-sonnet-4',
    currentIframeUrl: null,
  };

  return {
    stateUpdates,
    getState: () => currentState,
    setState: jest.fn(partial => {
      stateUpdates.push(partial);
      currentState = { ...currentState, ...partial };
    }),
    subscribe: jest.fn(() => () => {}),
    updateMessages: jest.fn(),
  };
}

// Helper to create a mock TRPC client
function createMockTrpcClient(responses: Array<{ status: string; previewUrl?: string }>) {
  let callIndex = 0;

  return {
    appBuilder: {
      getPreviewUrl: {
        query: jest.fn(async () => {
          const response = responses[callIndex] ?? responses[responses.length - 1];
          callIndex++;
          return response;
        }),
      },
      triggerBuild: {
        mutate: jest.fn(async () => ({ success: true })),
      },
    },
    organizations: {
      appBuilder: {
        getPreviewUrl: {
          query: jest.fn(async () => {
            const response = responses[callIndex] ?? responses[responses.length - 1];
            callIndex++;
            return response;
          }),
        },
        triggerBuild: {
          mutate: jest.fn(async () => ({ success: true })),
        },
      },
    },
  };
}

describe('POLLING_CONFIG', () => {
  it('exports expected configuration values', () => {
    expect(POLLING_CONFIG.maxAttempts).toBe(30);
    expect(POLLING_CONFIG.baseDelay).toBe(2000);
    expect(POLLING_CONFIG.maxDelay).toBe(10000);
    expect(POLLING_CONFIG.idleThresholdForBuild).toBe(2);
  });
});

describe('startPreviewPolling', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns polling state with stop function', () => {
    const store = createMockStore();
    const trpcClient = createMockTrpcClient([
      { status: 'running', previewUrl: 'http://preview.test' },
    ]);

    const pollingState = startPreviewPolling({
      projectId: 'project-1',
      organizationId: null,
      trpcClient: trpcClient as unknown as PreviewPollingConfig['trpcClient'],
      store,
      isDestroyed: () => false,
    });

    expect(pollingState).toHaveProperty('isPolling');
    expect(pollingState).toHaveProperty('stop');
    expect(typeof pollingState.stop).toBe('function');
  });

  it('sets previewStatus to building when starting', async () => {
    const store = createMockStore();
    const trpcClient = createMockTrpcClient([
      { status: 'building' },
      { status: 'running', previewUrl: 'http://preview.test' },
    ]);

    startPreviewPolling({
      projectId: 'project-1',
      organizationId: null,
      trpcClient: trpcClient as unknown as PreviewPollingConfig['trpcClient'],
      store,
      isDestroyed: () => false,
    });

    // Initial state should be set to building
    expect(store.stateUpdates).toContainEqual({ previewStatus: 'building' });
  });

  it('sets previewUrl and status to running when preview is ready', async () => {
    const store = createMockStore();
    const trpcClient = createMockTrpcClient([
      { status: 'running', previewUrl: 'http://preview.test' },
    ]);

    startPreviewPolling({
      projectId: 'project-1',
      organizationId: null,
      trpcClient: trpcClient as unknown as PreviewPollingConfig['trpcClient'],
      store,
      isDestroyed: () => false,
    });

    // Let the polling complete
    await jest.runAllTimersAsync();

    expect(store.stateUpdates).toContainEqual({
      previewUrl: 'http://preview.test',
      previewStatus: 'running',
    });
  });

  it('sets previewStatus to error on error response', async () => {
    const store = createMockStore();
    const trpcClient = createMockTrpcClient([{ status: 'error' }]);

    startPreviewPolling({
      projectId: 'project-1',
      organizationId: null,
      trpcClient: trpcClient as unknown as PreviewPollingConfig['trpcClient'],
      store,
      isDestroyed: () => false,
    });

    await jest.runAllTimersAsync();

    expect(store.stateUpdates).toContainEqual({ previewStatus: 'error' });
  });

  it('stops polling when destroyed', async () => {
    const store = createMockStore();
    let destroyed = false;
    const trpcClient = createMockTrpcClient([
      { status: 'building' },
      { status: 'building' },
      { status: 'running', previewUrl: 'http://preview.test' },
    ]);

    startPreviewPolling({
      projectId: 'project-1',
      organizationId: null,
      trpcClient: trpcClient as unknown as PreviewPollingConfig['trpcClient'],
      store,
      isDestroyed: () => destroyed,
    });

    // Let first poll complete
    await jest.advanceTimersByTimeAsync(100);

    // Mark as destroyed
    destroyed = true;

    // Let remaining polls try to run
    await jest.runAllTimersAsync();

    // Should not reach running status since we destroyed
    const hasRunningStatus = store.stateUpdates.some(update => update.previewStatus === 'running');
    expect(hasRunningStatus).toBe(false);
  });

  it('stops polling when stop() is called', async () => {
    const store = createMockStore();
    const trpcClient = createMockTrpcClient([
      { status: 'building' },
      { status: 'building' },
      { status: 'running', previewUrl: 'http://preview.test' },
    ]);

    const pollingState = startPreviewPolling({
      projectId: 'project-1',
      organizationId: null,
      trpcClient: trpcClient as unknown as PreviewPollingConfig['trpcClient'],
      store,
      isDestroyed: () => false,
    });

    // Let first poll complete
    await jest.advanceTimersByTimeAsync(100);

    // Stop polling
    pollingState.stop();

    // Let remaining timers try to run
    await jest.runAllTimersAsync();

    // isPolling should be false after stop
    expect(pollingState.isPolling).toBe(false);
  });

  it('triggers build after consecutive idle responses', async () => {
    const store = createMockStore();
    const trpcClient = createMockTrpcClient([
      { status: 'idle' },
      { status: 'idle' },
      { status: 'building' },
      { status: 'running', previewUrl: 'http://preview.test' },
    ]);

    startPreviewPolling({
      projectId: 'project-1',
      organizationId: null,
      trpcClient: trpcClient as unknown as PreviewPollingConfig['trpcClient'],
      store,
      isDestroyed: () => false,
    });

    await jest.runAllTimersAsync();

    // Should have called triggerBuild after 2 consecutive idle responses
    expect(trpcClient.appBuilder.triggerBuild.mutate).toHaveBeenCalledWith({
      projectId: 'project-1',
    });
  });

  it('uses organization path for organization projects', async () => {
    const store = createMockStore();
    const trpcClient = createMockTrpcClient([
      { status: 'running', previewUrl: 'http://preview.test' },
    ]);

    startPreviewPolling({
      projectId: 'project-1',
      organizationId: 'org-123',
      trpcClient: trpcClient as unknown as PreviewPollingConfig['trpcClient'],
      store,
      isDestroyed: () => false,
    });

    await jest.runAllTimersAsync();

    expect(trpcClient.organizations.appBuilder.getPreviewUrl.query).toHaveBeenCalledWith({
      projectId: 'project-1',
      organizationId: 'org-123',
    });
  });

  it('does not set building status if already running', async () => {
    const store = createMockStore();
    // Set initial status to running
    store.setState({ previewStatus: 'running' });
    store.stateUpdates.length = 0; // Clear the setState we just did

    const trpcClient = createMockTrpcClient([
      { status: 'running', previewUrl: 'http://preview.test' },
    ]);

    startPreviewPolling({
      projectId: 'project-1',
      organizationId: null,
      trpcClient: trpcClient as unknown as PreviewPollingConfig['trpcClient'],
      store,
      isDestroyed: () => false,
    });

    await jest.runAllTimersAsync();

    // Should not have set previewStatus to 'building' since it was already 'running'
    const hasBuildingStatus = store.stateUpdates.some(
      update => update.previewStatus === 'building'
    );
    expect(hasBuildingStatus).toBe(false);
  });

  it('sets error status after max attempts reached', async () => {
    const store = createMockStore();
    // Create many building responses to exhaust max attempts
    const responses = Array(35).fill({ status: 'building' });
    const trpcClient = createMockTrpcClient(responses);

    startPreviewPolling({
      projectId: 'project-1',
      organizationId: null,
      trpcClient: trpcClient as unknown as PreviewPollingConfig['trpcClient'],
      store,
      isDestroyed: () => false,
    });

    await jest.runAllTimersAsync();

    // Should eventually set error status after max attempts
    const hasErrorStatus = store.stateUpdates.some(update => update.previewStatus === 'error');
    expect(hasErrorStatus).toBe(true);
  });

  it('resets idle count when non-idle status received', async () => {
    const store = createMockStore();
    const trpcClient = createMockTrpcClient([
      { status: 'idle' },
      { status: 'building' }, // This breaks the idle streak
      { status: 'idle' },
      { status: 'running', previewUrl: 'http://preview.test' },
    ]);

    startPreviewPolling({
      projectId: 'project-1',
      organizationId: null,
      trpcClient: trpcClient as unknown as PreviewPollingConfig['trpcClient'],
      store,
      isDestroyed: () => false,
    });

    await jest.runAllTimersAsync();

    // triggerBuild should NOT be called because "building" broke the idle streak
    // before reaching threshold of 2 consecutive idle responses
    expect(trpcClient.appBuilder.triggerBuild.mutate).not.toHaveBeenCalled();
  });
});
