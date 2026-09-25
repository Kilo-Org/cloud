import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

// The instance list is the only input the hook reads from the query layer; the
// mock holds it in one place so a test can move it from pending to resolved.
const instances = vi.hoisted(() => ({ data: undefined as { id: string }[] | undefined }));
const secureStore = vi.hoisted(() => ({
  getItem: vi.fn<(key: string) => string | null>(),
  setItem: vi.fn<(key: string, value: string) => void>(),
}));

vi.mock('@/lib/hooks/use-instance-context', () => ({
  useAllKiloClawInstances: () => ({ data: instances.data }),
}));
vi.mock('expo-secure-store', () => ({
  getItem: secureStore.getItem,
  setItem: secureStore.setItem,
}));

type UseKiloClawTabVisible = () => boolean;

// The ownership module caches its answer in a module variable, so every test
// reloads the hook after `vi.resetModules()` to start from a cold read.
async function loadHook(): Promise<UseKiloClawTabVisible> {
  const { useKiloClawTabVisible } = await import('./use-kiloclaw-tab-visible');
  return useKiloClawTabVisible;
}

function Probe({ useVisible }: { useVisible: UseKiloClawTabVisible }) {
  return createElement('ProbeText', null, String(useVisible()));
}

function textOf(renderer: TestRenderer.ReactTestRenderer): string | null {
  const json = renderer.toJSON();
  if (!json || Array.isArray(json)) {
    return null;
  }
  const child = json.children[0];
  return typeof child === 'string' ? child : null;
}

function mount(useVisible: UseKiloClawTabVisible): {
  visible: () => string | null;
  setInstances: (data: { id: string }[] | undefined) => void;
} {
  const ref: { renderer: TestRenderer.ReactTestRenderer | undefined } = { renderer: undefined };
  act(() => {
    ref.renderer = TestRenderer.create(createElement(Probe, { useVisible }));
  });
  const renderer = ref.renderer;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  onTestFinished(() => {
    act(() => {
      renderer.unmount();
    });
  });
  return {
    visible: () => textOf(renderer),
    setInstances: data => {
      instances.data = data;
      act(() => {
        renderer.update(createElement(Probe, { useVisible }));
      });
    },
  };
}

beforeEach(() => {
  vi.resetModules();
  instances.data = undefined;
  secureStore.getItem.mockReset();
  secureStore.getItem.mockReturnValue(null);
  secureStore.setItem.mockReset();
});

describe('useKiloClawTabVisible session stability', () => {
  it('keeps the tab after a stale persisted "1" is contradicted by an empty list', async () => {
    secureStore.getItem.mockReturnValue('1');
    const useVisible = await loadHook();
    const probe = mount(useVisible);

    expect(probe.visible()).toBe('true');

    probe.setInstances([]);

    expect(probe.visible()).toBe('true');
  });

  it('keeps the tab hidden for a persisted "0" and an empty list', async () => {
    secureStore.getItem.mockReturnValue('0');
    const useVisible = await loadHook();
    const probe = mount(useVisible);

    expect(probe.visible()).toBe('false');

    probe.setInstances([]);

    expect(probe.visible()).toBe('false');
  });

  it('shows the tab when the list confirms an instance', async () => {
    secureStore.getItem.mockReturnValue('0');
    const useVisible = await loadHook();
    const probe = mount(useVisible);

    expect(probe.visible()).toBe('false');

    probe.setInstances([{ id: 'instance-1' }]);

    expect(probe.visible()).toBe('true');
  });

  it('persists the fetched empty-list answer for the next launch', async () => {
    secureStore.getItem.mockReturnValue('1');
    const useVisible = await loadHook();
    const probe = mount(useVisible);

    probe.setInstances([]);

    expect(probe.visible()).toBe('true');
    expect(secureStore.setItem).toHaveBeenCalledWith('kiloclaw-owned', '0');
  });
});
