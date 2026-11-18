import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type RemoteModelCatalogV1, type RemoteModelState } from '@kilocode/cloud-agent-sdk';

import { useRemoteModelCatalogRetry } from '@/lib/hooks/use-remote-model-catalog-retry';

const appStateListeners = vi.hoisted(() => {
  const listeners = new Set<(state: string) => void>();
  return {
    listeners,
    addEventListener: (_event: string, listener: (state: string) => void) => {
      listeners.add(listener);
      return {
        remove: () => {
          listeners.delete(listener);
        },
      };
    },
    emit: (nextState: string): void => {
      for (const listener of listeners) {
        listener(nextState);
      }
    },
  };
});

// Captures the useFocusEffect callback so a test can simulate a focus regain.
const focusEffect = vi.hoisted(() => ({
  callback: undefined as (() => void) | undefined,
}));

vi.mock('react-native', () => ({
  AppState: { addEventListener: appStateListeners.addEventListener },
}));

vi.mock('expo-router', () => ({
  useFocusEffect: (effect: () => void) => {
    focusEffect.callback = effect;
  },
}));

type RetryInput = Parameters<typeof useRemoteModelCatalogRetry>[0];

function catalog(providerCount: number): RemoteModelCatalogV1 {
  return {
    protocolVersion: 1,
    truncated: false,
    providers:
      providerCount === 0
        ? []
        : [
            {
              id: 'anthropic',
              name: 'Anthropic',
              models: [
                {
                  id: 'claude-sonnet-4',
                  name: 'Claude Sonnet 4',
                  variants: [],
                  capabilities: { attachment: true, reasoning: true },
                  limits: { context: 200_000, output: 8192 },
                },
              ],
            },
          ],
  };
}

function state(overrides: Partial<RemoteModelState> = {}): RemoteModelState {
  return {
    ownerConnectionId: 'owner-1',
    protocol: 'v1',
    refresh: 'idle',
    catalog: catalog(0),
    ...overrides,
  };
}

// A schema-valid catalog with a connected provider whose `models` record is
// empty. It projects to zero picker options and must be treated as empty.
const ZERO_MODEL_CATALOG: RemoteModelCatalogV1 = {
  protocolVersion: 1,
  truncated: false,
  providers: [{ id: 'anthropic', name: 'Anthropic', models: [] }],
};

function Probe(props: RetryInput) {
  useRemoteModelCatalogRetry(props);
  return createElement('ProbeText', null, 'probe');
}

const mountedRenderers: TestRenderer.ReactTestRenderer[] = [];

function mount(input: RetryInput): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(createElement(Probe, input));
  });
  if (!ref.current) {
    throw new Error('renderer was not created');
  }
  mountedRenderers.push(ref.current);
  return ref.current;
}

function update(renderer: TestRenderer.ReactTestRenderer, input: RetryInput): void {
  act(() => {
    renderer.update(createElement(Probe, input));
  });
}

function fireFocus(): void {
  act(() => {
    focusEffect.callback?.();
  });
}

function fireForeground(): void {
  act(() => {
    appStateListeners.emit('background');
    appStateListeners.emit('active');
  });
}

beforeEach(() => {
  appStateListeners.listeners.clear();
  focusEffect.callback = undefined;
});

afterEach(() => {
  for (const renderer of mountedRenderers.splice(0)) {
    act(() => {
      renderer.unmount();
    });
  }
});

describe('useRemoteModelCatalogRetry', () => {
  it('retries once on attach for an empty remote catalog', () => {
    const manager = { retryRemoteModels: vi.fn() };
    mount({ activeSessionType: 'remote', manager, remoteModelState: state() });

    expect(manager.retryRemoteModels).toHaveBeenCalledTimes(1);
  });

  it('retries once on attach for a catalog whose only provider has no models', () => {
    const manager = { retryRemoteModels: vi.fn() };
    mount({
      activeSessionType: 'remote',
      manager,
      remoteModelState: state({ catalog: ZERO_MODEL_CATALOG }),
    });

    expect(manager.retryRemoteModels).toHaveBeenCalledTimes(1);
  });

  it('does not retry on attach while the catalog request is loading', () => {
    const manager = { retryRemoteModels: vi.fn() };
    mount({
      activeSessionType: 'remote',
      manager,
      remoteModelState: state({ refresh: 'loading' }),
    });

    expect(manager.retryRemoteModels).not.toHaveBeenCalled();
  });

  it('does not retry on attach when the catalog is already populated', () => {
    const manager = { retryRemoteModels: vi.fn() };
    mount({
      activeSessionType: 'remote',
      manager,
      remoteModelState: state({ catalog: catalog(1) }),
    });

    expect(manager.retryRemoteModels).not.toHaveBeenCalled();
  });

  it('does not retry a cloud-agent session', () => {
    const manager = { retryRemoteModels: vi.fn() };
    mount({ activeSessionType: 'cloud-agent', manager, remoteModelState: state() });

    expect(manager.retryRemoteModels).not.toHaveBeenCalled();
  });

  it('does not retry a legacy CLI on attach, focus, or foreground', () => {
    const manager = { retryRemoteModels: vi.fn() };
    mount({
      activeSessionType: 'remote',
      manager,
      remoteModelState: state({ protocol: 'legacy', refresh: 'idle' }),
    });
    expect(manager.retryRemoteModels).not.toHaveBeenCalled();

    fireFocus();
    fireForeground();
    expect(manager.retryRemoteModels).not.toHaveBeenCalled();
  });

  it('retries on an app-foreground transition', () => {
    const manager = { retryRemoteModels: vi.fn() };
    const renderer = mount({
      activeSessionType: 'remote',
      manager,
      remoteModelState: state({ catalog: catalog(1) }),
    });
    expect(manager.retryRemoteModels).not.toHaveBeenCalled();

    update(renderer, {
      activeSessionType: 'remote',
      manager,
      remoteModelState: state(),
    });
    fireForeground();

    // The attach effect fires one for the empty catalog the update introduced,
    // and the foreground transition adds the event-driven one.
    expect(manager.retryRemoteModels).toHaveBeenCalledTimes(2);
  });

  it('retries on a focus regain', () => {
    const manager = { retryRemoteModels: vi.fn() };
    const renderer = mount({
      activeSessionType: 'remote',
      manager,
      remoteModelState: state({ catalog: catalog(1) }),
    });

    update(renderer, {
      activeSessionType: 'remote',
      manager,
      remoteModelState: state(),
    });
    manager.retryRemoteModels.mockClear();
    fireFocus();

    expect(manager.retryRemoteModels).toHaveBeenCalledTimes(1);
  });

  it('not an error loop: catalog publishes alone do not retry again', () => {
    const manager = { retryRemoteModels: vi.fn() };
    const renderer = mount({
      activeSessionType: 'remote',
      manager,
      remoteModelState: state(),
    });
    expect(manager.retryRemoteModels).toHaveBeenCalledTimes(1);

    // A failed refresh publishes error state with the catalog still empty. The
    // attach latch must keep this from re-firing on every publish.
    for (const refresh of ['loading', 'error', 'error'] as const) {
      update(renderer, {
        activeSessionType: 'remote',
        manager,
        remoteModelState: state({ refresh }),
      });
    }

    expect(manager.retryRemoteModels).toHaveBeenCalledTimes(1);
  });

  it('retries again for a new owner connection', () => {
    const manager = { retryRemoteModels: vi.fn() };
    const renderer = mount({
      activeSessionType: 'remote',
      manager,
      remoteModelState: state(),
    });
    update(renderer, {
      activeSessionType: 'remote',
      manager,
      remoteModelState: state({ ownerConnectionId: 'owner-2' }),
    });

    expect(manager.retryRemoteModels).toHaveBeenCalledTimes(2);
  });

  it('its triggers are events: repeated identical renders add no retries', () => {
    const manager = { retryRemoteModels: vi.fn() };
    const renderer = mount({
      activeSessionType: 'remote',
      manager,
      remoteModelState: state({ refresh: 'error' }),
    });
    expect(manager.retryRemoteModels).toHaveBeenCalledTimes(1);

    for (let index = 0; index < 4; index += 1) {
      update(renderer, {
        activeSessionType: 'remote',
        manager,
        remoteModelState: state({ refresh: 'error' }),
      });
    }

    expect(manager.retryRemoteModels).toHaveBeenCalledTimes(1);

    fireFocus();
    fireForeground();
    expect(manager.retryRemoteModels).toHaveBeenCalledTimes(3);
  });

  it('removes its AppState listener on unmount', () => {
    const manager = { retryRemoteModels: vi.fn() };
    const renderer = mount({
      activeSessionType: 'remote',
      manager,
      remoteModelState: state({ catalog: catalog(1) }),
    });
    expect(appStateListeners.listeners.size).toBe(1);

    act(() => {
      renderer.unmount();
    });
    expect(appStateListeners.listeners.size).toBe(0);
  });
});
