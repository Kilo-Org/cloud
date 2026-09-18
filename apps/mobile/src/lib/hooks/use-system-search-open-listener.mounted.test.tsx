import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/* eslint-disable import/first -- the mock factory must be registered before the hook import */
const mocks = vi.hoisted(() => ({
  register: vi.fn<() => { remove: () => void }>(),
  remove: vi.fn<() => void>(),
  consumeOnce: vi.fn<() => void>(),
}));

// The wake-up bridge is the only thing this hook owns; stubbing it keeps the
// mounted tree out of the native module, SecureStore and deep-link graph.
vi.mock('@/lib/system-search-route', () => ({
  registerSystemSearchOpenListener: mocks.register,
  consumeSystemSearchRouteOnce: mocks.consumeOnce,
}));

import { useSystemSearchOpenListener } from './use-system-search-open-listener';
/* eslint-enable import/first */

function Harness() {
  useSystemSearchOpenListener();
  return null;
}

function mount(): TestRenderer.ReactTestRenderer {
  const mounted: { renderer: TestRenderer.ReactTestRenderer | undefined } = {
    renderer: undefined,
  };
  act(() => {
    mounted.renderer = TestRenderer.create(createElement(Harness));
  });
  if (!mounted.renderer) {
    throw new Error('renderer was not created');
  }
  return mounted.renderer;
}

describe('useSystemSearchOpenListener', () => {
  beforeEach(() => {
    mocks.register.mockClear();
    mocks.remove.mockClear();
    mocks.consumeOnce.mockClear();
    mocks.register.mockReturnValue({ remove: mocks.remove });
  });

  it('holds the wake-up subscription while mounted and releases it on unmount', () => {
    const renderer = mount();

    expect(mocks.register).toHaveBeenCalledOnce();
    expect(mocks.remove).not.toHaveBeenCalled();

    act(() => {
      renderer.unmount();
    });

    expect(mocks.remove).toHaveBeenCalledOnce();
  });

  it('re-reads the launch slot once on mount, not on rerenders', () => {
    const renderer = mount();
    expect(mocks.consumeOnce).toHaveBeenCalledOnce();

    act(() => {
      renderer.update(createElement(Harness));
    });
    expect(mocks.consumeOnce).toHaveBeenCalledOnce();

    act(() => {
      renderer.unmount();
    });
  });

  it('keeps one subscription across rerenders', () => {
    const renderer = mount();

    act(() => {
      renderer.update(createElement(Harness));
    });

    expect(mocks.register).toHaveBeenCalledOnce();
    expect(mocks.remove).not.toHaveBeenCalled();

    act(() => {
      renderer.unmount();
    });
    expect(mocks.remove).toHaveBeenCalledOnce();
  });
});
