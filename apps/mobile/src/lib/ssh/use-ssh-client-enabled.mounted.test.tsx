import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';

import { setSshFixtureFlag } from './fixture-flag';
import { useSshClientEnabled } from './use-ssh-client-enabled';

const flag = vi.hoisted(() => ({ value: undefined as boolean | undefined, read: vi.fn() }));
vi.mock('@/lib/analytics/posthog', () => ({
  useFeatureFlag: (key: string, fallback: boolean) => {
    flag.read(key, fallback);
    return flag.value ?? fallback;
  },
}));

function Probe() {
  return createElement('Probe', { testID: 'ssh-gate', enabled: useSshClientEnabled() });
}

function mountGate(): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(createElement(Probe));
  });
  if (!ref.current) {
    throw new Error('renderer was not created');
  }
  return ref.current;
}

afterEach(() => {
  vi.stubGlobal('__DEV__', true);
  setSshFixtureFlag(false);
  vi.unstubAllGlobals();
  flag.value = undefined;
  flag.read.mockClear();
});

describe('SSH feature gate', () => {
  it.each([false, true])('defaults off in development=%s', development => {
    vi.stubGlobal('__DEV__', development);
    const renderer = mountGate();
    expect(renderer.root.findByProps({ testID: 'ssh-gate' }).props.enabled).toBe(false);
    act(() => {
      renderer.unmount();
    });
  });

  it('ignores a fixture override outside development', () => {
    vi.stubGlobal('__DEV__', false);
    setSshFixtureFlag(true);
    const renderer = mountGate();
    expect(renderer.root.findByProps({ testID: 'ssh-gate' }).props.enabled).toBe(false);
    flag.value = true;
    act(() => {
      renderer.update(createElement(Probe));
    });
    expect(renderer.root.findByProps({ testID: 'ssh-gate' }).props.enabled).toBe(true);
    act(() => {
      renderer.unmount();
    });
  });

  it('updates mounted gates when a development fixture toggles the flag', () => {
    vi.stubGlobal('__DEV__', true);
    const renderer = mountGate();
    act(() => {
      setSshFixtureFlag(true);
    });
    expect(renderer.root.findByProps({ testID: 'ssh-gate' }).props.enabled).toBe(true);
    act(() => {
      setSshFixtureFlag(false);
    });
    expect(renderer.root.findByProps({ testID: 'ssh-gate' }).props.enabled).toBe(false);
    act(() => {
      renderer.unmount();
    });
  });
});
