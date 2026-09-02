/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as src/components/ui/selectable-text.mounted.test.tsx) */
import { createElement, type ReactNode, useState } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetBlurBarForTests, BlurBar } from './blur-bar';

const accessibilityMock = vi.hoisted(() => ({
  isReduceTransparencyEnabled: vi.fn(),
  addEventListener: vi.fn(),
}));

// Mutated between tests so one suite can prove both platform channels.
const platformMock = vi.hoisted(() => ({ OS: 'ios' as 'ios' | 'android' }));
const useColorSchemeMock = vi.hoisted(() => vi.fn<() => 'dark' | 'light'>(() => 'dark'));

vi.mock('react-native', () => ({
  AccessibilityInfo: accessibilityMock,
  Platform: platformMock,
  useColorScheme: useColorSchemeMock,
  View: 'View',
}));

vi.mock('expo-blur', () => ({
  BlurView: 'BlurView',
}));

type Renderer = TestRenderer.ReactTestRenderer;

let childMounts = 0;

function ChildProbe(): ReactNode {
  const [id] = useState(() => {
    childMounts += 1;
    return childMounts;
  });
  return createElement('Text', null, `child-${id}`);
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  const handlers: {
    resolve: ((value: T) => void) | undefined;
    reject: ((error: unknown) => void) | undefined;
  } = { resolve: undefined, reject: undefined };
  const promise = new Promise<T>((resolve, reject) => {
    handlers.resolve = resolve;
    handlers.reject = reject;
  });
  return {
    promise,
    resolve: (value: T) => {
      handlers.resolve?.(value);
    },
    reject: (error: unknown) => {
      handlers.reject?.(error);
    },
  };
}

async function render(children: ReactNode): Promise<Renderer> {
  const ref: { current: Renderer | undefined } = { current: undefined };
  await act(async () => {
    await Promise.resolve();
    ref.current = TestRenderer.create(createElement(BlurBar, null, children));
  });
  if (!ref.current) {
    throw new Error('renderer was not created');
  }
  return ref.current;
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function hosts(renderer: Renderer, type: string): TestRenderer.ReactTestInstance[] {
  return renderer.root.findAll(node => node.type === type);
}

function outerView(renderer: Renderer): TestRenderer.ReactTestInstance | undefined {
  return hosts(renderer, 'View')[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  platformMock.OS = 'ios';
  useColorSchemeMock.mockReturnValue('dark');
  accessibilityMock.addEventListener.mockReturnValue({ remove: vi.fn() });
  childMounts = 0;
  __resetBlurBarForTests();
});

describe('BlurBar Reduce Transparency', () => {
  it('renders the solid surface while the iOS preference is still unknown', async () => {
    const pending = deferred<boolean>();
    accessibilityMock.isReduceTransparencyEnabled.mockReturnValue(pending.promise);
    const renderer = await render(createElement('Text', null, 'content'));

    expect(outerView(renderer)?.props.className).toContain('bg-background');
    expect(hosts(renderer, 'BlurView')).toHaveLength(0);

    renderer.unmount();
  });

  it('renders BlurView behind children when Reduce Transparency is off on iOS', async () => {
    const pending = deferred<boolean>();
    accessibilityMock.isReduceTransparencyEnabled.mockReturnValue(pending.promise);
    const renderer = await render(createElement('Text', null, 'content'));

    pending.resolve(false);
    await settle();

    const outer = outerView(renderer);
    expect(outer?.props.className).not.toContain('bg-background');

    const blurs = hosts(renderer, 'BlurView');
    expect(blurs).toHaveLength(1);
    expect(blurs[0]?.props.intensity).toBe(40);
    expect(blurs[0]?.props.tint).toBe('dark');
    expect(blurs[0]?.props.className).toBe('absolute inset-0');

    // BlurView is the first child (the background), then children.
    const firstChild = outer?.children[0];
    expect(typeof firstChild === 'string' ? null : firstChild?.type).toBe('BlurView');
    expect(hosts(renderer, 'Text')[0]?.props.children).toBe('content');

    renderer.unmount();
  });

  it('renders the solid surface when Reduce Transparency is on on iOS', async () => {
    const pending = deferred<boolean>();
    accessibilityMock.isReduceTransparencyEnabled.mockReturnValue(pending.promise);
    const renderer = await render(createElement('Text', null, 'content'));

    pending.resolve(true);
    await settle();

    expect(outerView(renderer)?.props.className).toContain('bg-background');
    expect(hosts(renderer, 'BlurView')).toHaveLength(0);

    renderer.unmount();
  });

  it('stays solid when the iOS preference read rejects', async () => {
    const pending = deferred<boolean>();
    accessibilityMock.isReduceTransparencyEnabled.mockReturnValue(pending.promise);
    const renderer = await render(createElement('Text', null, 'content'));

    pending.reject(new Error('native read failed'));
    await settle();

    expect(outerView(renderer)?.props.className).toContain('bg-background');
    expect(hosts(renderer, 'BlurView')).toHaveLength(0);

    renderer.unmount();
  });

  it('flips to solid on a change event without remounting children', async () => {
    const pending = deferred<boolean>();
    accessibilityMock.isReduceTransparencyEnabled.mockReturnValue(pending.promise);
    const renderer = await render(createElement(ChildProbe));

    pending.resolve(false);
    await settle();

    expect(hosts(renderer, 'BlurView')).toHaveLength(1);
    expect(hosts(renderer, 'Text')[0]?.props.children).toBe('child-1');
    expect(childMounts).toBe(1);

    const handler = accessibilityMock.addEventListener.mock.calls[0]?.[1] as (
      value: boolean
    ) => void;
    expect(handler).toBeTypeOf('function');
    await act(async () => {
      await Promise.resolve();
      handler(true);
    });

    expect(outerView(renderer)?.props.className).toContain('bg-background');
    expect(hosts(renderer, 'BlurView')).toHaveLength(0);
    // Same child mount across the background flip: identity preserved.
    expect(hosts(renderer, 'Text')[0]?.props.children).toBe('child-1');
    expect(childMounts).toBe(1);

    renderer.unmount();
  });

  it('keeps the solid surface when a stale read resolves after a newer change event', async () => {
    const pending = deferred<boolean>();
    accessibilityMock.isReduceTransparencyEnabled.mockReturnValue(pending.promise);
    const renderer = await render(createElement('Text', null, 'content'));

    const handler = accessibilityMock.addEventListener.mock.calls[0]?.[1] as (
      value: boolean
    ) => void;
    expect(handler).toBeTypeOf('function');
    await act(async () => {
      await Promise.resolve();
      handler(true);
    });

    expect(outerView(renderer)?.props.className).toContain('bg-background');

    // The read resolves false afterwards; it must not repaint BlurView.
    pending.resolve(false);
    await settle();

    expect(outerView(renderer)?.props.className).toContain('bg-background');
    expect(hosts(renderer, 'BlurView')).toHaveLength(0);

    renderer.unmount();
  });

  it('keeps a fresh mount solid until its own read resolves after the last subscriber leaves', async () => {
    const first = deferred<boolean>();
    accessibilityMock.isReduceTransparencyEnabled.mockReturnValueOnce(first.promise);
    const renderer = await render(createElement('Text', null, 'content'));

    first.resolve(false);
    await settle();
    expect(hosts(renderer, 'BlurView')).toHaveLength(1);

    renderer.unmount();

    // The previous read resolved false, but the fresh mount must stay solid
    // until its own read resolves.
    const second = deferred<boolean>();
    accessibilityMock.isReduceTransparencyEnabled.mockReturnValueOnce(second.promise);
    const renderer2 = await render(createElement('Text', null, 'content'));

    expect(outerView(renderer2)?.props.className).toContain('bg-background');
    expect(hosts(renderer2, 'BlurView')).toHaveLength(0);

    second.resolve(false);
    await settle();
    expect(hosts(renderer2, 'BlurView')).toHaveLength(1);

    renderer2.unmount();
  });

  it('never mounts BlurView on Android', async () => {
    platformMock.OS = 'android';
    accessibilityMock.isReduceTransparencyEnabled.mockResolvedValue(false);
    const renderer = await render(createElement('Text', null, 'content'));

    expect(outerView(renderer)?.props.className).toContain('bg-background');
    expect(hosts(renderer, 'BlurView')).toHaveLength(0);
    expect(accessibilityMock.isReduceTransparencyEnabled).not.toHaveBeenCalled();
    expect(accessibilityMock.addEventListener).not.toHaveBeenCalled();

    renderer.unmount();
  });
});
