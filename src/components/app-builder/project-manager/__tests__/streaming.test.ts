/**
 * Streaming Module Tests
 *
 * Tests for the WebSocket-based streaming coordinator.
 */

import { createStreamingCoordinator, formatStreamError } from '../streaming';
import type { StreamingConfig, ProjectStore, ProjectState } from '../types';
import type { CloudMessage } from '@/components/cloud-agent/types';
import type { StreamingCoordinatorConfig } from '../streaming';
import { TRPCClientError } from '@trpc/client';

// Mock the websocket-streaming module
jest.mock('../websocket-streaming', () => ({
  createWebSocketStreamingCoordinator: jest.fn(() => ({
    connectToStream: jest.fn().mockResolvedValue(undefined),
    interrupt: jest.fn(),
    destroy: jest.fn(),
    getConnectionState: jest.fn(() => ({ status: 'disconnected' })),
  })),
}));

// Mock fetch for stream ticket
const mockFetch = jest.fn();
global.fetch = mockFetch;

// Helper to create a mock store for testing
function createMockStore(): ProjectStore & { stateUpdates: Array<Record<string, unknown>> } {
  const stateUpdates: Array<Record<string, unknown>> = [];
  let messages: CloudMessage[] = [];
  let currentState: Omit<ProjectState, 'messages'> = {
    isStreaming: false,
    isInterrupting: false,
    previewUrl: null,
    previewStatus: 'idle',
    deploymentId: null,
    model: 'anthropic/claude-sonnet-4',
    currentIframeUrl: null,
    gitRepoFullName: null,
  };

  return {
    stateUpdates,
    getState: (): ProjectState => ({ ...currentState, messages }),
    setState: jest.fn((partial: Partial<ProjectState>) => {
      stateUpdates.push(partial);
      currentState = { ...currentState, ...partial };
      if (partial.messages) {
        messages = partial.messages;
      }
    }),
    subscribe: jest.fn(() => () => {}),
    updateMessages: jest.fn(updater => {
      messages = updater(messages);
    }),
  };
}

// Helper to create a mock TRPC client
function createMockTrpcClient() {
  return {
    appBuilder: {
      startSession: {
        mutate: jest.fn(async () => ({ cloudAgentSessionId: 'session-123' })),
      },
      sendMessage: {
        mutate: jest.fn(async () => ({ cloudAgentSessionId: 'session-123' })),
      },
      interruptSession: {
        mutate: jest.fn(async () => ({ success: true })),
      },
    },
    organizations: {
      appBuilder: {
        startSession: {
          mutate: jest.fn(async () => ({ cloudAgentSessionId: 'session-456' })),
        },
        sendMessage: {
          mutate: jest.fn(async () => ({ cloudAgentSessionId: 'session-456' })),
        },
        interruptSession: {
          mutate: jest.fn(async () => ({ success: true })),
        },
      },
    },
  };
}

describe('createStreamingCoordinator (WebSocket)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockReset();
  });

  describe('Configuration', () => {
    it('requires cloudAgentSessionId in config', () => {
      const config: StreamingCoordinatorConfig = {
        projectId: 'project-1',
        organizationId: null,
        trpcClient: createMockTrpcClient() as unknown as StreamingConfig['trpcClient'],
        store: createMockStore(),
        cloudAgentSessionId: 'session-123',
        sessionPrepared: true,
      };

      expect(config.cloudAgentSessionId).toBe('session-123');
    });

    it('accepts null cloudAgentSessionId for new projects', () => {
      const config: StreamingCoordinatorConfig = {
        projectId: 'project-1',
        organizationId: null,
        trpcClient: createMockTrpcClient() as unknown as StreamingConfig['trpcClient'],
        store: createMockStore(),
        cloudAgentSessionId: null,
        sessionPrepared: null,
      };

      expect(config.cloudAgentSessionId).toBeNull();
    });
  });

  describe('sendMessage', () => {
    it('calls sendMessage mutation for user projects', async () => {
      const store = createMockStore();
      const trpcClient = createMockTrpcClient();

      const coordinator = createStreamingCoordinator({
        projectId: 'project-1',
        organizationId: null,
        trpcClient: trpcClient as unknown as StreamingConfig['trpcClient'],
        store,
        cloudAgentSessionId: null,
        sessionPrepared: true,
      });

      coordinator.sendMessage('Hello, AI!');

      // Allow async operation to complete
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(trpcClient.appBuilder.sendMessage.mutate).toHaveBeenCalledWith({
        projectId: 'project-1',
        message: 'Hello, AI!',
        images: undefined,
        model: undefined,
      });
    });

    it('calls organization sendMessage for org projects', async () => {
      const store = createMockStore();
      const trpcClient = createMockTrpcClient();

      const coordinator = createStreamingCoordinator({
        projectId: 'project-1',
        organizationId: 'org-123',
        trpcClient: trpcClient as unknown as StreamingConfig['trpcClient'],
        store,
        cloudAgentSessionId: null,
        sessionPrepared: true,
      });

      coordinator.sendMessage('Hello from org!');

      await new Promise(resolve => setTimeout(resolve, 10));

      expect(trpcClient.organizations.appBuilder.sendMessage.mutate).toHaveBeenCalledWith({
        projectId: 'project-1',
        organizationId: 'org-123',
        message: 'Hello from org!',
        images: undefined,
        model: undefined,
      });
    });

    it('adds user message to store immediately', () => {
      const store = createMockStore();
      const trpcClient = createMockTrpcClient();

      const coordinator = createStreamingCoordinator({
        projectId: 'project-1',
        organizationId: null,
        trpcClient: trpcClient as unknown as StreamingConfig['trpcClient'],
        store,
        cloudAgentSessionId: null,
        sessionPrepared: true,
      });

      coordinator.sendMessage('Hello!');

      // Check that setState was called with messages containing user message
      expect(store.setState).toHaveBeenCalled();
      const messages = store.getState().messages;
      expect(messages.length).toBe(1);
      expect(messages[0].type).toBe('user');
      expect(messages[0].text).toBe('Hello!');
    });

    it('sets isStreaming to true when sending', () => {
      const store = createMockStore();
      const trpcClient = createMockTrpcClient();

      const coordinator = createStreamingCoordinator({
        projectId: 'project-1',
        organizationId: null,
        trpcClient: trpcClient as unknown as StreamingConfig['trpcClient'],
        store,
        cloudAgentSessionId: null,
        sessionPrepared: true,
      });

      coordinator.sendMessage('Hello!');

      expect(store.stateUpdates).toContainEqual({ isStreaming: true });
    });

    it('updates model when provided', () => {
      const store = createMockStore();
      const trpcClient = createMockTrpcClient();

      const coordinator = createStreamingCoordinator({
        projectId: 'project-1',
        organizationId: null,
        trpcClient: trpcClient as unknown as StreamingConfig['trpcClient'],
        store,
        cloudAgentSessionId: null,
        sessionPrepared: true,
      });

      coordinator.sendMessage('Hello!', undefined, 'openai/gpt-4o');

      expect(store.stateUpdates).toContainEqual({ isStreaming: true, model: 'openai/gpt-4o' });
    });

    it('does not send when destroyed', () => {
      const store = createMockStore();
      const trpcClient = createMockTrpcClient();

      const coordinator = createStreamingCoordinator({
        projectId: 'project-1',
        organizationId: null,
        trpcClient: trpcClient as unknown as StreamingConfig['trpcClient'],
        store,
        cloudAgentSessionId: null,
        sessionPrepared: true,
      });

      coordinator.destroy();
      coordinator.sendMessage('Hello!');

      expect(trpcClient.appBuilder.sendMessage.mutate).not.toHaveBeenCalled();
    });

    it('includes images when provided', async () => {
      const store = createMockStore();
      const trpcClient = createMockTrpcClient();
      const images = { path: 'app-builder/msg-123', files: ['image1.png'] };

      const coordinator = createStreamingCoordinator({
        projectId: 'project-1',
        organizationId: null,
        trpcClient: trpcClient as unknown as StreamingConfig['trpcClient'],
        store,
        cloudAgentSessionId: null,
        sessionPrepared: true,
      });

      coordinator.sendMessage('Check this image', images);

      await new Promise(resolve => setTimeout(resolve, 10));

      expect(trpcClient.appBuilder.sendMessage.mutate).toHaveBeenCalledWith({
        projectId: 'project-1',
        message: 'Check this image',
        images,
        model: undefined,
      });
    });
  });

  describe('startInitialStreaming', () => {
    it('calls startSession mutation for user projects', async () => {
      const store = createMockStore();
      const trpcClient = createMockTrpcClient();

      const coordinator = createStreamingCoordinator({
        projectId: 'project-1',
        organizationId: null,
        trpcClient: trpcClient as unknown as StreamingConfig['trpcClient'],
        store,
        cloudAgentSessionId: null,
        sessionPrepared: true,
      });

      coordinator.startInitialStreaming();

      await new Promise(resolve => setTimeout(resolve, 10));

      expect(trpcClient.appBuilder.startSession.mutate).toHaveBeenCalledWith({
        projectId: 'project-1',
      });
    });

    it('calls organization startSession for org projects', async () => {
      const store = createMockStore();
      const trpcClient = createMockTrpcClient();

      const coordinator = createStreamingCoordinator({
        projectId: 'project-1',
        organizationId: 'org-123',
        trpcClient: trpcClient as unknown as StreamingConfig['trpcClient'],
        store,
        cloudAgentSessionId: null,
        sessionPrepared: true,
      });

      coordinator.startInitialStreaming();

      await new Promise(resolve => setTimeout(resolve, 10));

      expect(trpcClient.organizations.appBuilder.startSession.mutate).toHaveBeenCalledWith({
        projectId: 'project-1',
        organizationId: 'org-123',
      });
    });

    it('sets isStreaming to true', () => {
      const store = createMockStore();
      const trpcClient = createMockTrpcClient();

      const coordinator = createStreamingCoordinator({
        projectId: 'project-1',
        organizationId: null,
        trpcClient: trpcClient as unknown as StreamingConfig['trpcClient'],
        store,
        cloudAgentSessionId: null,
        sessionPrepared: true,
      });

      coordinator.startInitialStreaming();

      expect(store.stateUpdates).toContainEqual({ isStreaming: true });
    });

    it('does not start when destroyed', () => {
      const store = createMockStore();
      const trpcClient = createMockTrpcClient();

      const coordinator = createStreamingCoordinator({
        projectId: 'project-1',
        organizationId: null,
        trpcClient: trpcClient as unknown as StreamingConfig['trpcClient'],
        store,
        cloudAgentSessionId: null,
        sessionPrepared: true,
      });

      coordinator.destroy();
      coordinator.startInitialStreaming();

      expect(trpcClient.appBuilder.startSession.mutate).not.toHaveBeenCalled();
    });
  });

  describe('interrupt', () => {
    it('calls interruptSession mutation for user projects', async () => {
      const store = createMockStore();
      const trpcClient = createMockTrpcClient();

      const coordinator = createStreamingCoordinator({
        projectId: 'project-1',
        organizationId: null,
        trpcClient: trpcClient as unknown as StreamingConfig['trpcClient'],
        store,
        cloudAgentSessionId: null,
        sessionPrepared: true,
      });

      coordinator.interrupt();

      await new Promise(resolve => setTimeout(resolve, 10));

      expect(trpcClient.appBuilder.interruptSession.mutate).toHaveBeenCalledWith({
        projectId: 'project-1',
      });
    });

    it('calls organization interruptSession for org projects', async () => {
      const store = createMockStore();
      const trpcClient = createMockTrpcClient();

      const coordinator = createStreamingCoordinator({
        projectId: 'project-1',
        organizationId: 'org-123',
        trpcClient: trpcClient as unknown as StreamingConfig['trpcClient'],
        store,
        cloudAgentSessionId: null,
        sessionPrepared: true,
      });

      coordinator.interrupt();

      await new Promise(resolve => setTimeout(resolve, 10));

      expect(trpcClient.organizations.appBuilder.interruptSession.mutate).toHaveBeenCalledWith({
        projectId: 'project-1',
        organizationId: 'org-123',
      });
    });

    it('sets isStreaming to false and isInterrupting to true', () => {
      const store = createMockStore();
      const trpcClient = createMockTrpcClient();

      const coordinator = createStreamingCoordinator({
        projectId: 'project-1',
        organizationId: null,
        trpcClient: trpcClient as unknown as StreamingConfig['trpcClient'],
        store,
        cloudAgentSessionId: null,
        sessionPrepared: true,
      });

      coordinator.interrupt();

      expect(store.stateUpdates).toContainEqual({ isStreaming: false, isInterrupting: true });
    });

    it('does not interrupt when destroyed', () => {
      const store = createMockStore();
      const trpcClient = createMockTrpcClient();

      const coordinator = createStreamingCoordinator({
        projectId: 'project-1',
        organizationId: null,
        trpcClient: trpcClient as unknown as StreamingConfig['trpcClient'],
        store,
        cloudAgentSessionId: null,
        sessionPrepared: true,
      });

      coordinator.destroy();
      coordinator.interrupt();

      expect(trpcClient.appBuilder.interruptSession.mutate).not.toHaveBeenCalled();
    });
  });

  describe('connectToExistingSession', () => {
    it('sets isStreaming to true', async () => {
      const store = createMockStore();
      const trpcClient = createMockTrpcClient();

      const coordinator = createStreamingCoordinator({
        projectId: 'project-1',
        organizationId: null,
        trpcClient: trpcClient as unknown as StreamingConfig['trpcClient'],
        store,
        cloudAgentSessionId: null,
        sessionPrepared: true,
      });

      // connectToExistingSession will try to connect to WebSocket
      await coordinator.connectToExistingSession('session-123');

      expect(store.stateUpdates).toContainEqual({ isStreaming: true });
    });

    it('does not connect when destroyed', async () => {
      const store = createMockStore();
      const trpcClient = createMockTrpcClient();

      const coordinator = createStreamingCoordinator({
        projectId: 'project-1',
        organizationId: null,
        trpcClient: trpcClient as unknown as StreamingConfig['trpcClient'],
        store,
        cloudAgentSessionId: null,
        sessionPrepared: true,
      });

      coordinator.destroy();
      await coordinator.connectToExistingSession('session-123');

      // Should not set isStreaming when destroyed
      const streamingUpdates = store.stateUpdates.filter(u => 'isStreaming' in u);
      expect(streamingUpdates).toHaveLength(0);
    });
  });

  describe('destroy', () => {
    it('prevents further operations after destroy', async () => {
      const store = createMockStore();
      const trpcClient = createMockTrpcClient();

      const coordinator = createStreamingCoordinator({
        projectId: 'project-1',
        organizationId: null,
        trpcClient: trpcClient as unknown as StreamingConfig['trpcClient'],
        store,
        cloudAgentSessionId: null,
        sessionPrepared: true,
      });

      coordinator.destroy();

      // All operations should be no-ops after destroy
      coordinator.sendMessage('Hello!');
      coordinator.startInitialStreaming();
      coordinator.interrupt();

      expect(trpcClient.appBuilder.sendMessage.mutate).not.toHaveBeenCalled();
      expect(trpcClient.appBuilder.startSession.mutate).not.toHaveBeenCalled();
      expect(trpcClient.appBuilder.interruptSession.mutate).not.toHaveBeenCalled();
    });

    it('can be called multiple times safely', () => {
      const store = createMockStore();
      const trpcClient = createMockTrpcClient();

      const coordinator = createStreamingCoordinator({
        projectId: 'project-1',
        organizationId: null,
        trpcClient: trpcClient as unknown as StreamingConfig['trpcClient'],
        store,
        cloudAgentSessionId: null,
        sessionPrepared: true,
      });

      // Should not throw when called multiple times
      expect(() => {
        coordinator.destroy();
        coordinator.destroy();
        coordinator.destroy();
      }).not.toThrow();
    });
  });
});

describe('formatStreamError', () => {
  it('formats PAYMENT_REQUIRED error', () => {
    const error = new TRPCClientError('Error', {
      result: {
        error: {
          code: -32000,
          message: 'Payment required',
          data: { code: 'PAYMENT_REQUIRED', httpStatus: 402 },
        },
      },
    });

    const message = formatStreamError(error);

    expect(message).toBe(
      'Insufficient credits. Please add at least $1 to continue using App Builder.'
    );
  });

  it('formats 402 httpStatus error', () => {
    const error = new TRPCClientError('Error', {
      result: {
        error: {
          code: -32000,
          message: 'Payment required',
          data: { httpStatus: 402 },
        },
      },
    });

    const message = formatStreamError(error);

    expect(message).toBe(
      'Insufficient credits. Please add at least $1 to continue using App Builder.'
    );
  });

  it('formats UNAUTHORIZED error', () => {
    const error = new TRPCClientError('Error', {
      result: {
        error: {
          code: -32000,
          message: 'Unauthorized',
          data: { code: 'UNAUTHORIZED' },
        },
      },
    });

    const message = formatStreamError(error);

    expect(message).toBe('You are not authorized to use the App Builder.');
  });

  it('formats FORBIDDEN error', () => {
    const error = new TRPCClientError('Error', {
      result: {
        error: {
          code: -32000,
          message: 'Forbidden',
          data: { code: 'FORBIDDEN' },
        },
      },
    });

    const message = formatStreamError(error);

    expect(message).toBe('You are not authorized to use the App Builder.');
  });

  it('formats NOT_FOUND error', () => {
    const error = new TRPCClientError('Error', {
      result: {
        error: {
          code: -32000,
          message: 'Not found',
          data: { code: 'NOT_FOUND' },
        },
      },
    });

    const message = formatStreamError(error);

    expect(message).toBe('App Builder service is unavailable right now. Please try again.');
  });

  it('formats generic TRPCClientError', () => {
    const error = new TRPCClientError('Error', {
      result: {
        error: {
          code: -32000,
          message: 'Some error',
          data: { code: 'INTERNAL_SERVER_ERROR' },
        },
      },
    });

    const message = formatStreamError(error);

    expect(message).toBe('App Builder encountered an error. Please retry in a moment.');
  });

  it('formats ECONNREFUSED error', () => {
    const error = new Error('connect ECONNREFUSED 127.0.0.1:3000');

    const message = formatStreamError(error);

    expect(message).toBe('Lost connection to App Builder. Please retry in a moment.');
  });

  it('formats fetch failed error', () => {
    const error = new Error('fetch failed');

    const message = formatStreamError(error);

    expect(message).toBe('Lost connection to App Builder. Please retry in a moment.');
  });

  it('formats generic Error', () => {
    const error = new Error('Some random error');

    const message = formatStreamError(error);

    expect(message).toBe('App Builder connection failed. Please retry in a moment.');
  });

  it('formats unknown error types', () => {
    const error = 'Just a string error';

    const message = formatStreamError(error);

    expect(message).toBe('App Builder error. Please retry in a moment.');
  });
});
