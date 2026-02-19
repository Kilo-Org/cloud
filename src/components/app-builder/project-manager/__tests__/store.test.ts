/**
 * Store Module Tests
 *
 * Tests for the state management store.
 */

import { createProjectStore, createInitialState } from '../store';
import type { ProjectState } from '../types';

/**
 * Helper to flush pending notifications.
 * In Jest, requestAnimationFrame falls back to setTimeout(0).
 * We use a macrotask delay to ensure the scheduled callback runs.
 */
function flushNotifications(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

describe('createInitialState', () => {
  it('creates state with default values', () => {
    const state = createInitialState(null, null, null);

    expect(state.isStreaming).toBe(false);
    expect(state.previewUrl).toBeNull();
    expect(state.previewStatus).toBe('idle');
    expect(state.deploymentId).toBeNull();
    expect(state.model).toBe('anthropic/claude-sonnet-4');
    expect(state.gitRepoFullName).toBeNull();
    expect(state.sessions).toEqual([]);
  });

  it('uses provided deployment ID', () => {
    const state = createInitialState('deploy-123', null, null);

    expect(state.deploymentId).toBe('deploy-123');
  });

  it('uses provided model ID', () => {
    const state = createInitialState(null, 'openai/gpt-4o', null);

    expect(state.model).toBe('openai/gpt-4o');
  });

  it('uses provided git repo full name', () => {
    const state = createInitialState(null, null, 'owner/my-repo');

    expect(state.gitRepoFullName).toBe('owner/my-repo');
  });
});

describe('createProjectStore', () => {
  const initialState: ProjectState = {
    isStreaming: false,
    isInterrupting: false,
    previewUrl: null,
    previewStatus: 'idle',
    deploymentId: null,
    model: 'anthropic/claude-sonnet-4',
    currentIframeUrl: null,
    gitRepoFullName: null,
    sessions: [],
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
      expect(store.getState().previewUrl).toBeNull();
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

      // Simulate rapid state changes
      store.setState({ isStreaming: true });
      store.setState({ previewStatus: 'building' });
      store.setState({ previewUrl: 'http://preview.example.com' });

      // No notifications yet (batched)
      expect(listener).not.toHaveBeenCalled();

      // All state changes should be reflected immediately
      const state = store.getState();
      expect(state.isStreaming).toBe(true);
      expect(state.previewStatus).toBe('building');
      expect(state.previewUrl).toBe('http://preview.example.com');

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
});
