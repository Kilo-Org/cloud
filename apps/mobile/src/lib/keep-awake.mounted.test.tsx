import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';
import type * as KeepAwakeModule from '@/lib/keep-awake';

// eslint-disable-next-line init-declarations -- assigned from the per-test module import.
let useKeepAwake: (typeof KeepAwakeModule)['useKeepAwake'];

// Mirrors expo-keep-awake's Android ExpoKeepAwakeManager: both calls reject
// before they touch the tag set when the activity is gone, and the window gets
// the screen-on flag only when the first tag is added.
const native = vi.hoisted(() => {
  const tags = new Set<string>();
  const state = {
    tags,
    screenOn: false,
    activityAvailable: true,
  };
  const activateBehavior = async (tag: string) => {
    await Promise.resolve();
    if (!state.activityAvailable) {
      throw new Error("Call to function 'ExpoKeepAwake.activate' has been rejected.");
    }
    if (state.tags.size === 0) {
      state.screenOn = true;
    }
    state.tags.add(tag);
  };
  const deactivateBehavior = async (tag: string) => {
    await Promise.resolve();
    if (!state.activityAvailable) {
      throw new Error("Call to function 'ExpoKeepAwake.deactivate' has been rejected.");
    }
    if (state.tags.size === 1 && state.tags.has(tag)) {
      state.screenOn = false;
    }
    state.tags.delete(tag);
  };
  return Object.assign(state, {
    activateBehavior,
    deactivateBehavior,
    activate: vi.fn(activateBehavior),
    deactivate: vi.fn(deactivateBehavior),
  });
});

vi.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: native.activate,
  deactivateKeepAwake: native.deactivate,
}));

/** Flushes the native promise chain and the React work it triggers. */
async function flush(): Promise<void> {
  await act(async () => {
    await vi.dynamicImportSettled();
  });
}

function Probe({ tag }: Readonly<{ tag: string }>): null {
  useKeepAwake(tag);
  return null;
}

async function mount(tag: string): Promise<TestRenderer.ReactTestRenderer> {
  let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
  await act(async () => {
    renderer = TestRenderer.create(createElement(Probe, { tag }));
    await vi.dynamicImportSettled();
  });
  // eslint-disable-next-line no-unnecessary-condition -- assigned inside act.
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

async function unmount(renderer: TestRenderer.ReactTestRenderer): Promise<void> {
  await act(async () => {
    renderer.unmount();
    await vi.dynamicImportSettled();
  });
}

const rejections: unknown[] = [];
function recordRejection(reason: unknown): void {
  rejections.push(reason);
}

beforeEach(async () => {
  // The hook remembers tags whose release failed in module state; a fresh
  // module per test keeps one test's rejected release out of the next.
  vi.resetModules();
  ({ useKeepAwake } = await import('@/lib/keep-awake'));
  native.activityAvailable = true;
  native.tags.clear();
  native.screenOn = false;
  native.activate.mockClear();
  native.deactivate.mockClear();
  native.activate.mockImplementation(native.activateBehavior);
  native.deactivate.mockImplementation(native.deactivateBehavior);
  rejections.length = 0;
  process.on('unhandledRejection', recordRejection);
});

afterEach(() => {
  process.off('unhandledRejection', recordRejection);
});

describe('useKeepAwake', () => {
  it('keeps the screen on while mounted and releases the tag on unmount', async () => {
    const renderer = await mount('session-a');
    expect(native.screenOn).toBe(true);
    expect(native.tags).toEqual(new Set(['session-a']));

    await unmount(renderer);

    expect(native.deactivate).toHaveBeenCalledWith('session-a');
    expect(native.screenOn).toBe(false);
    expect(native.tags.size).toBe(0);
  });

  it('does not report a rejected release when the activity is gone at unmount', async () => {
    const renderer = await mount('session-b');
    native.activityAvailable = false;

    await unmount(renderer);

    expect(native.deactivate).toHaveBeenCalledWith('session-b');
    expect(rejections).toEqual([]);
  });

  it('does not release a tag whose activation never happened', async () => {
    native.activityAvailable = false;
    const renderer = await mount('session-c');

    await unmount(renderer);

    expect(native.deactivate).not.toHaveBeenCalled();
    expect(rejections).toEqual([]);
  });

  it('releases a tag that activates after the owner unmounted', async () => {
    const activation = Promise.withResolvers<undefined>();
    native.activate.mockImplementation(async (tag: string) => {
      await activation.promise;
      native.tags.add(tag);
    });
    const renderer = await mount('session-d');

    // The owner leaves while activation is still in flight.
    await unmount(renderer);
    expect(native.deactivate).not.toHaveBeenCalled();

    activation.resolve(undefined);
    await flush();

    expect(native.deactivate).toHaveBeenCalledWith('session-d');
    expect(native.tags.size).toBe(0);
    expect(rejections).toEqual([]);
  });

  it('keeps the tag for a remounted owner when the older activation lands late', async () => {
    const activations: PromiseWithResolvers<undefined>[] = [];
    native.activate.mockImplementation(async (tag: string) => {
      const activation = Promise.withResolvers<undefined>();
      activations.push(activation);
      await activation.promise;
      native.tags.add(tag);
    });
    // Same tag remounts while the first activation is still in flight, as in
    // a StrictMode effect replay or a quick reopen of the same session.
    const first = await mount('session-g');
    await unmount(first);
    const second = await mount('session-g');

    activations[0]?.resolve(undefined);
    activations[1]?.resolve(undefined);
    await flush();

    expect(native.deactivate).not.toHaveBeenCalled();
    expect(native.tags).toEqual(new Set(['session-g']));

    await unmount(second);

    expect(native.deactivate).toHaveBeenCalledWith('session-g');
    expect(native.tags.size).toBe(0);
  });

  it('releases a late older activation when the newer owner never activated', async () => {
    const activation = Promise.withResolvers<undefined>();
    native.activate
      .mockImplementationOnce(async (tag: string) => {
        await activation.promise;
        native.tags.add(tag);
      })
      .mockImplementationOnce(async () => {
        await Promise.resolve();
        throw new Error("Call to function 'ExpoKeepAwake.activate' has been rejected.");
      });
    const first = await mount('session-h');
    await unmount(first);
    const second = await mount('session-h');

    activation.resolve(undefined);
    await flush();
    expect(native.tags).toEqual(new Set(['session-h']));

    await unmount(second);

    expect(native.deactivate).toHaveBeenCalledWith('session-h');
    expect(native.tags.size).toBe(0);
    expect(rejections).toEqual([]);
  });

  it('turns the screen on for a recreated activity after a rejected release', async () => {
    const first = await mount('session-e');
    // The activity goes away with the tag still held, so the release rejects
    // and the native set keeps the tag.
    native.activityAvailable = false;
    await unmount(first);
    expect(native.tags).toEqual(new Set(['session-e']));
    expect(rejections).toEqual([]);

    // The activity is recreated: its window has no screen-on flag, and the
    // native set still believes the stale tag holds the lock.
    native.deactivate.mockClear();
    native.activityAvailable = true;
    native.tags.clear();
    native.screenOn = false;
    const second = await mount('session-f');

    expect(native.deactivate).toHaveBeenCalledWith('session-e');
    expect(native.tags).toEqual(new Set(['session-f']));
    expect(native.screenOn).toBe(true);
    await unmount(second);
  });
});
