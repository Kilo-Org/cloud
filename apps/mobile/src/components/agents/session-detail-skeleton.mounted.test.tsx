import { createElement, type ReactElement } from 'react';
import { act, type ReactTestRenderer, TestRenderer } from '@/test/renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SessionSkeletonMessages } from './session-detail-skeleton';

vi.mock('react-native', () => ({ View: 'View', ActivityIndicator: 'ActivityIndicator' }));
vi.mock('react-native-reanimated', () => ({
  default: { View: 'AnimatedView' },
  FadeOut: { duration: () => ({}) },
}));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@/components/ui/blur-bar', () => ({ BlurBar: 'BlurBar' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));

const mounted: ReactTestRenderer[] = [];

async function render(element: ReactElement): Promise<ReactTestRenderer> {
  const holder: { current: ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    holder.current = TestRenderer.create(element);
    await Promise.resolve();
  });
  const renderer = holder.current;
  if (!renderer) {
    throw new Error('Renderer did not mount');
  }
  mounted.push(renderer);
  return renderer;
}

afterEach(() => {
  for (const renderer of mounted.splice(0)) {
    renderer.unmount();
  }
});

function bubbleClasses(renderer: ReactTestRenderer): string[] {
  return renderer.root.findAllByType('Skeleton').map(node => String(node.props.className));
}

describe('SessionSkeletonMessages', () => {
  it('fills the transcript region with enough rows to overflow a tall viewport', async () => {
    const renderer = await render(
      createElement(SessionSkeletonMessages, { sessionId: 'session-1' })
    );

    const container = renderer.root.findByType('AnimatedView');
    const containerClasses = String(container.props.className);
    expect(containerClasses).toContain('flex-1');
    expect(containerClasses).toContain('justify-end');
    // Clipped at the region's top edge, so the extra rows fill the region
    // instead of painting over the header.
    expect(containerClasses).toContain('overflow-hidden');

    // 8 repeats of the 3-bubble layout. The shortest shape is 168px per
    // repeat plus the wrappers' py-1, so the column is at least 1536px and
    // overflows a tall phone's transcript region.
    const bubbles = bubbleClasses(renderer);
    expect(bubbles.length).toBeGreaterThanOrEqual(24);
  });

  it('keeps the newest bubble bottom-anchored just above the composer', async () => {
    const renderer = await render(
      createElement(SessionSkeletonMessages, { sessionId: 'session-1' })
    );
    const wrappers = renderer.root
      .findAllByType('View')
      .filter(node => String(node.props.className).includes('px-4'));

    expect(wrappers.length).toBe(bubbleClasses(renderer).length);
    expect(wrappers.at(-1)?.props.className).toContain('items-start');
    expect(bubbleClasses(renderer).at(-1)).toContain('w-2/3');
  });

  it('is deterministic per session and varies between sessions', async () => {
    const first = await render(createElement(SessionSkeletonMessages, { sessionId: 'session-1' }));
    const reopen = await render(createElement(SessionSkeletonMessages, { sessionId: 'session-1' }));
    const other = await render(createElement(SessionSkeletonMessages, { sessionId: 'session-b' }));

    expect(bubbleClasses(reopen)).toEqual(bubbleClasses(first));
    expect(bubbleClasses(other)).not.toEqual(bubbleClasses(first));
  });

  it('renders no spinner', async () => {
    const renderer = await render(
      createElement(SessionSkeletonMessages, { sessionId: 'session-1' })
    );
    expect(renderer.root.findAllByType('ActivityIndicator')).toHaveLength(0);
  });
});
