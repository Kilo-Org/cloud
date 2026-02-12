/**
 * Store Module Tests
 *
 * Tests for the state management store.
 */

import { createProjectStore, createInitialState } from '../store';
import type { ProjectState } from '../types';
import type { CloudMessage } from '@/components/cloud-agent/types';

/**
 * Helper to flush pending notifications.
 * In Jest, requestAnimationFrame falls back to setTimeout(0).
 * We use a macrotask delay to ensure the scheduled callback runs.
 */
function flushNotifications(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

describe('createInitialState', () => {
  it('creates state with provided messages', () => {
    const messages: CloudMessage[] = [{ ts: 1000, type: 'user', text: 'Hello', partial: false }];

    const state = createInitialState(messages, null, null, null);

    expect(state.messages).toEqual(messages);
    expect(state.isStreaming).toBe(false);
    expect(state.previewUrl).toBeNull();
    expect(state.previewStatus).toBe('idle');
    expect(state.deploymentId).toBeNull();
    expect(state.model).toBe('anthropic/claude-sonnet-4');
    expect(state.gitRepoFullName).toBeNull();
  });

  it('uses provided deployment ID', () => {
    const state = createInitialState([], 'deploy-123', null, null);

    expect(state.deploymentId).toBe('deploy-123');
  });

  it('uses provided model ID', () => {
    const state = createInitialState([], null, 'openai/gpt-4o', null);

    expect(state.model).toBe('openai/gpt-4o');
  });

  it('uses provided git repo full name', () => {
    const state = createInitialState([], null, null, 'owner/my-repo');

    expect(state.gitRepoFullName).toBe('owner/my-repo');
  });
});

describe('createProjectStore', () => {
  const initialState: ProjectState = {
    messages: [],
    isStreaming: false,
    isInterrupting: false,
    previewUrl: null,
    previewStatus: 'idle',
    deploymentId: null,
    model: 'anthropic/claude-sonnet-4',
    currentIframeUrl: null,
    gitRepoFullName: null,
  };

  describe('getState', () => {
    it('returns the current state', () => {
      const store = createProjectStore(initialState);

      expect(store.getState()).toEqual(initialState);
    });
  });

  describe('setState', () => {
    it('merges partial state', () => {
      const store = createProjectStore(initialState);

      store.setState({ isStreaming: true });

      expect(store.getState().isStreaming).toBe(true);
      expect(store.getState().messages).toEqual([]);
    });

    it('notifies subscribers on state change', async () => {
      const store = createProjectStore(initialState);
      const listener = jest.fn();

      store.subscribe(listener);
      store.setState({ isStreaming: true });

      // Notification is batched via microtask
      expect(listener).not.toHaveBeenCalled();
      await flushNotifications();
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('allows multiple partial updates', () => {
      const store = createProjectStore(initialState);

      store.setState({ isStreaming: true });
      store.setState({ previewStatus: 'building' });
      store.setState({ previewUrl: 'http://preview.example.com' });

      const state = store.getState();
      expect(state.isStreaming).toBe(true);
      expect(state.previewStatus).toBe('building');
      expect(state.previewUrl).toBe('http://preview.example.com');
    });

    it('batches multiple rapid state changes into single notification', async () => {
      const store = createProjectStore(initialState);
      const listener = jest.fn();

      store.subscribe(listener);

      // Simulate rapid WebSocket messages arriving
      store.setState({ isStreaming: true });
      store.setState({ previewStatus: 'building' });
      store.setState({
        messages: [{ ts: 1, type: 'user', text: 'msg1', partial: false }],
      });
      store.setState({
        messages: [
          { ts: 1, type: 'user', text: 'msg1', partial: false },
          { ts: 2, type: 'assistant', text: 'msg2', partial: false },
        ],
      });
      store.setState({
        messages: [
          { ts: 1, type: 'user', text: 'msg1', partial: false },
          { ts: 2, type: 'assistant', text: 'msg2', partial: false },
          { ts: 3, type: 'assistant', text: 'msg3', partial: false },
        ],
      });

      // No notifications yet (batched)
      expect(listener).not.toHaveBeenCalled();

      // All state changes should be reflected immediately
      const state = store.getState();
      expect(state.isStreaming).toBe(true);
      expect(state.previewStatus).toBe('building');
      expect(state.messages).toHaveLength(3);

      // After microtask, single notification
      await flushNotifications();
      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

  describe('subscribe', () => {
    it('returns unsubscribe function', () => {
      const store = createProjectStore(initialState);
      const listener = jest.fn();

      const unsubscribe = store.subscribe(listener);

      expect(typeof unsubscribe).toBe('function');
    });

    it('removes listener when unsubscribe is called', async () => {
      const store = createProjectStore(initialState);
      const listener = jest.fn();

      const unsubscribe = store.subscribe(listener);
      unsubscribe();
      store.setState({ isStreaming: true });

      await flushNotifications();
      expect(listener).not.toHaveBeenCalled();
    });

    it('supports multiple subscribers', async () => {
      const store = createProjectStore(initialState);
      const listener1 = jest.fn();
      const listener2 = jest.fn();

      store.subscribe(listener1);
      store.subscribe(listener2);
      store.setState({ isStreaming: true });

      await flushNotifications();
      expect(listener1).toHaveBeenCalledTimes(1);
      expect(listener2).toHaveBeenCalledTimes(1);
    });

    it('only removes the specific unsubscribed listener', async () => {
      const store = createProjectStore(initialState);
      const listener1 = jest.fn();
      const listener2 = jest.fn();

      const unsubscribe1 = store.subscribe(listener1);
      store.subscribe(listener2);
      unsubscribe1();
      store.setState({ isStreaming: true });

      await flushNotifications();
      expect(listener1).not.toHaveBeenCalled();
      expect(listener2).toHaveBeenCalledTimes(1);
    });
  });

  describe('updateMessages', () => {
    it('updates messages using updater function', () => {
      const store = createProjectStore(initialState);
      const newMessage: CloudMessage = {
        ts: 1000,
        type: 'user',
        text: 'Hello',
        partial: false,
      };

      store.updateMessages(messages => [...messages, newMessage]);

      expect(store.getState().messages).toEqual([newMessage]);
    });

    it('notifies subscribers when messages are updated', async () => {
      const store = createProjectStore(initialState);
      const listener = jest.fn();

      store.subscribe(listener);
      store.updateMessages(messages => [
        ...messages,
        { ts: 1000, type: 'user', text: 'Hi', partial: false },
      ]);

      await flushNotifications();
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('allows transforming existing messages', () => {
      const existingMessages: CloudMessage[] = [
        { ts: 1000, type: 'assistant', text: 'Hello', partial: true },
      ];
      const store = createProjectStore({ ...initialState, messages: existingMessages });

      store.updateMessages(messages =>
        messages.map(msg =>
          msg.ts === 1000 ? { ...msg, text: 'Hello World', partial: false } : msg
        )
      );

      const updatedMessages = store.getState().messages;
      expect(updatedMessages[0].text).toBe('Hello World');
      expect(updatedMessages[0].partial).toBe(false);
    });
  });
});
