import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { EventServiceProvider, usePresenceSubscription } from './event-service-provider';

const mocks = vi.hoisted(() => ({
  active: true,
  acquire: vi.fn(),
  release: vi.fn(),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  clearToken: vi.fn(),
  options: { current: undefined as { onUnauthorized: () => string } | undefined },
}));

vi.mock('@kilocode/event-service', () => ({
  presenceContextForPlatform: (platform: string) => `platform:${platform}`,
  EventServiceClient: class {
    acquire = mocks.acquire;
    release = mocks.release;
    subscribe = mocks.subscribe;
    unsubscribe = mocks.unsubscribe;
    constructor(options: { onUnauthorized: () => string }) {
      mocks.options.current = options;
    }
  },
}));
vi.mock('@/lib/config', () => ({ EVENT_SERVICE_URL: 'ws://localhost:8809' }));
vi.mock('@/lib/hooks/use-app-state-active', () => ({ useAppStateActive: () => mocks.active }));
vi.mock('@/lib/hooks/use-event-service-token', () => ({
  clearEventServiceTokenCache: mocks.clearToken,
  useEventServiceTokenGetter: () => vi.fn(),
}));

function SessionPresence({ context }: { context: string | null }) {
  usePresenceSubscription(context, mocks.active);
  return null;
}

function tree(context: string | null = 'session:one') {
  return createElement(EventServiceProvider, null, createElement(SessionPresence, { context }));
}

describe('generic mobile presence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.active = true;
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  });

  it('holds app and Cloud Agent session presence only while foregrounded', () => {
    const mounted: { renderer?: TestRenderer.ReactTestRenderer } = {};
    act(() => {
      mounted.renderer = TestRenderer.create(tree());
    });
    expect(mocks.acquire).toHaveBeenCalledTimes(1);
    expect(mocks.subscribe).toHaveBeenCalledWith(['platform:app']);
    expect(mocks.subscribe).toHaveBeenCalledWith(['session:one']);

    mocks.active = false;
    act(() => {
      mounted.renderer?.update(tree());
    });
    expect(mocks.release).toHaveBeenCalledTimes(1);
    expect(mocks.unsubscribe).toHaveBeenCalledWith(['platform:app']);
    expect(mocks.unsubscribe).toHaveBeenCalledWith(['session:one']);

    mocks.active = true;
    act(() => {
      mounted.renderer?.update(tree(null));
    });
    expect(mocks.acquire).toHaveBeenCalledTimes(2);
    expect(mocks.subscribe).not.toHaveBeenCalledWith([null]);
    act(() => {
      mounted.renderer?.unmount();
    });
    expect(mocks.release).toHaveBeenCalledTimes(2);
  });

  it('refreshes rejected event tokens before reconnecting', () => {
    const mounted: { renderer?: TestRenderer.ReactTestRenderer } = {};
    act(() => {
      mounted.renderer = TestRenderer.create(tree(null));
    });
    expect(mocks.options.current?.onUnauthorized()).toBe('retry');
    expect(mocks.clearToken).toHaveBeenCalledTimes(1);
    act(() => {
      mounted.renderer?.unmount();
    });
  });
});
