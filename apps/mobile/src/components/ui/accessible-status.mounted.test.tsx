/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as src/components/agents/markdown-image.mounted.test.tsx) */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AccessibleStatus } from './accessible-status';

const accessibilityMock = vi.hoisted(() => ({
  announceForAccessibility: vi.fn(),
  setAccessibilityFocus: vi.fn(),
}));

// Mutated between tests so one suite can prove both platform channels.
const platformMock = vi.hoisted(() => ({ OS: 'android' as 'android' | 'ios' }));

vi.mock('react-native', () => ({
  AccessibilityInfo: accessibilityMock,
  findNodeHandle: vi.fn(),
  Platform: platformMock,
}));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));

type Renderer = TestRenderer.ReactTestRenderer;

async function mount(message: string | null): Promise<Renderer> {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = {
    current: undefined,
  };
  await act(async () => {
    await Promise.resolve();
    ref.current = TestRenderer.create(createElement(AccessibleStatus, { message }));
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

async function update(renderer: Renderer, message: string | null): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    renderer.update(createElement(AccessibleStatus, { message }));
  });
}

function textNodes(root: TestRenderer.ReactTestInstance): TestRenderer.ReactTestInstance[] {
  return root.findAll(node => typeof node.type === 'string' && (node.type as string) === 'Text');
}

describe('AccessibleStatus platform channels (D14)', () => {
  beforeEach(() => {
    accessibilityMock.announceForAccessibility.mockClear();
  });

  it('Android: renders a polite live region and never calls the imperative announce', async () => {
    platformMock.OS = 'android';
    const renderer = await mount('Failed to load');

    const texts = textNodes(renderer.root);
    expect(texts).toHaveLength(1);
    expect(texts[0]?.props.accessibilityLiveRegion).toBe('polite');
    expect(texts[0]?.props.children).toBe('Failed to load');
    expect(accessibilityMock.announceForAccessibility).not.toHaveBeenCalled();

    renderer.unmount();
  });

  it('iOS: renders no live region and announces a new message exactly once', async () => {
    platformMock.OS = 'ios';
    const renderer = await mount('Failed to load');

    const texts = textNodes(renderer.root);
    expect(texts).toHaveLength(1);
    expect(texts[0]?.props.accessibilityLiveRegion).toBeUndefined();
    expect(accessibilityMock.announceForAccessibility).toHaveBeenCalledTimes(1);
    expect(accessibilityMock.announceForAccessibility).toHaveBeenCalledWith('Failed to load');

    renderer.unmount();
  });

  it('iOS: a message change produces one announcement path and a repeat stays silent', async () => {
    platformMock.OS = 'ios';
    const renderer = await mount('Failed to load');

    // Same message re-rendered: deduped, no new announcement.
    await update(renderer, 'Failed to load');
    expect(accessibilityMock.announceForAccessibility).toHaveBeenCalledTimes(1);

    // Genuine change: one new announcement.
    await update(renderer, 'Try again');
    expect(accessibilityMock.announceForAccessibility).toHaveBeenCalledTimes(2);
    expect(accessibilityMock.announceForAccessibility).toHaveBeenLastCalledWith('Try again');

    // Clearing to null: silent and the text unmounts.
    await update(renderer, null);
    expect(accessibilityMock.announceForAccessibility).toHaveBeenCalledTimes(2);
    expect(textNodes(renderer.root)).toHaveLength(0);

    renderer.unmount();
  });

  it('renders nothing when message is null on both platforms', async () => {
    platformMock.OS = 'ios';
    let renderer = await mount(null);
    expect(textNodes(renderer.root)).toHaveLength(0);
    renderer.unmount();

    platformMock.OS = 'android';
    renderer = await mount(null);
    expect(textNodes(renderer.root)).toHaveLength(0);
    renderer.unmount();
  });
});
